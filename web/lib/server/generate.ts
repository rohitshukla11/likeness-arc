import "server-only";
/**
 * One render, end to end:
 *   checks (licence Active and held by this brand, under its cap, escrow covers the price, the prompt
 *   passes the banned-use filter, the creator has released the reference photos)
 *   → renderer → C2PA manifest (licence id + receipt lookup, test certificate) → sha256 of the final
 *   file → render agent's EIP-712 Render signature → LicenseEscrow.payRender: usage, payment to the
 *   creator and the receipt anchor in one transaction.
 *
 * payRender must come from the brand's wallet:
 *  - "delegated": the server sends it under the brand's delegation (Dynamic, or dev-local), through
 *    the payRender-only policy guard; the file is returned once the transaction is final;
 *  - "wallet": the server returns the signed render authorisation and holds the file; the brand's
 *    wallet sends payRender, and the file is released only after its receipt is on chain.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { toHex, type Address, type Hex } from "viem";
import { categoryLabels } from "@/lib/categories";
import { requireAddress } from "@/lib/deployment";
import { renderAgent } from "./agent";
import { embedManifest, type LicenceAssertion } from "./c2pa";
import { serverChain, singleton } from "./chain";
import { dbGet, dbList, dbPut } from "./db";
import { getGrant, sendDelegatedPayRender } from "./delegation";
import { fileGet, filePut, localDir } from "./files";
import { checkPrompt, type FilterResult } from "./filter";
import { referenceImages } from "./keyring";
import { readEscrow, readLicence, readReceipt } from "./protocol";
import { render } from "./render";
import { RenderBudgetError } from "./render/budget";

export type RenderRecord = {
  assetHash: Hex;
  token: string; // random download token, shown to the licensee only
  licenceId: string;
  renderIndex: number;
  licensee: Address;
  creator: Address;
  file: string;
  mime: string;
  provider: string;
  model: string;
  test: boolean;
  usage?: Record<string, unknown>;
  promptSha256: string;
  filter: FilterResult;
  mode: "delegated" | "wallet";
  state: "awaiting-payment" | "paid";
  createdAt: number;
  agent: Address;
  deadline: string;
  agentSig: Hex;
  tx?: Hex;
  gasUsed?: string;
  confirmMs?: number;
  block?: string;
  paidBy?: string;
};

export class GenerateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const AUTH_WINDOW = 10 * 60; // seconds the agent signature (and a wallet-mode hold) stays valid
const locks = singleton("render-locks", () => new Map<string, Promise<unknown>>());

const rendersDir = () => localDir("RENDERS_DIR", "renders");

/** One render at a time per licence: the render index is part of what the agent signs. */
async function serial<T>(licenceId: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(licenceId) ?? Promise.resolve();
  const next = prev.then(f, f);
  locks.set(licenceId, next.catch(() => {}));
  return next;
}

export type Preflight = {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  filter?: FilterResult;
};

/** Everything that must hold before a render. Also served to the UI so it can show why not. */
export async function preflight(licenceId: bigint, licensee: Address, prompt?: string): Promise<Preflight> {
  const checks: Preflight["checks"] = [];
  const l = await readLicence(licenceId);
  if (!l) return { ok: false, checks: [{ name: "Licence", ok: false, detail: "no such licence" }] };
  checks.push({ name: "Licence active", ok: l.status === "Active", detail: l.status });
  checks.push({ name: "Held by this brand", ok: l.licensee === licensee.toLowerCase(), detail: l.licensee });
  checks.push({ name: "Licensed use", ok: categoryLabels(l.category).length === 1, detail: categoryLabels(l.category).join() });
  checks.push({ name: "Under the render cap", ok: l.renderCount < l.renderCap, detail: `${l.renderCount} of ${l.renderCap} used` });
  const escrow = await readEscrow(licenceId);
  checks.push({ name: "Escrow covers the price", ok: escrow.balance >= l.pricePerRender, detail: `${escrow.balance} ≥ ${l.pricePerRender} USDC units` });
  const pending = (await dbList<RenderRecord>("renders")).find(
    (r) => r.licenceId === licenceId.toString() && r.state === "awaiting-payment" && Number(r.deadline) > Date.now() / 1000,
  );
  checks.push({ name: "No unpaid render pending", ok: !pending, detail: pending ? `render ${pending.renderIndex} awaits payRender until its authorisation expires` : "none" });
  let filter: FilterResult | undefined;
  if (prompt !== undefined) {
    filter = await checkPrompt(prompt, l.category);
    checks.push({ name: "Prompt filter", ok: filter.allowed, detail: filter.allowed ? filter.layers.map((x) => (x.ran ? x.name : x.note)).join("; ") : filter.reasons.join("; ") });
  }
  return { ok: checks.every((c) => c.ok), checks, filter };
}

export async function generate(input: { licenceId: bigint; licensee: Address; prompt: string; mode: "delegated" | "wallet" }) {
  return serial(input.licenceId.toString(), async () => {
    const pre = await preflight(input.licenceId, input.licensee, input.prompt);
    if (!pre.ok) throw new GenerateError(pre.checks.find((c) => !c.ok)?.name === "Prompt filter" ? 422 : 409, "render refused", pre);
    if (input.mode === "delegated") {
      const g = await getGrant(input.licensee);
      if (!g || g.revokedAt) throw new GenerateError(409, "this brand has not delegated render payments; use wallet mode");
    }
    const l = (await readLicence(input.licenceId))!;
    const renderIndex = l.renderCount;

    // The creator's reference photos, decrypted in memory for this render only.
    const references = await referenceImages(input.licenceId).catch((e) => {
      throw new GenerateError(409, (e as Error).message);
    });
    let out;
    try {
      out = await render({ prompt: input.prompt, references, licenceId: input.licenceId, renderIndex });
    } catch (e) {
      if (e instanceof RenderBudgetError) throw new GenerateError(429, e.message);
      throw e;
    } finally {
      references.forEach((r) => r.fill(0));
    }

    const agent = await renderAgent();
    const promptSha256 = createHash("sha256").update(input.prompt).digest("hex");
    const assertion: LicenceAssertion = {
      protocol: "likeness/1",
      chainId: serverChain().id,
      licenceId: input.licenceId.toString(),
      renderIndex,
      creator: l.creator,
      licensee: l.licensee,
      category: categoryLabels(l.category).join(),
      licenceRegistry: requireAddress("LicenseRegistry"),
      escrow: requireAddress("LicenseEscrow"),
      receipt: { anchor: requireAddress("ReceiptAnchor"), key: "sha256 of this file, manifest included", lookup: "ReceiptAnchor.receiptOf(sha256(file))" },
      renderAgent: agent.address,
      renderer: { provider: out.provider, model: out.model, test: out.test },
      promptSha256,
      createdAt: new Date().toISOString(),
    };
    const signed = embedManifest(out.bytes, out.mime, assertion);
    const assetHash = toHex(createHash("sha256").update(signed).digest());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + AUTH_WINDOW);
    const agentSig = await agent.signRender({ licenceId: input.licenceId, assetHash, renderIndex, deadline });

    const file = `${assetHash}.${out.mime === "image/png" ? "png" : "jpg"}`;
    await filePut(`renders/${file}`, path.join(/*turbopackIgnore: true*/ rendersDir(), file), signed, { contentType: out.mime, overwrite: false });
    const record: RenderRecord = {
      assetHash,
      token: randomBytes(24).toString("base64url"),
      licenceId: input.licenceId.toString(),
      renderIndex,
      licensee: l.licensee,
      creator: l.creator,
      file,
      mime: out.mime,
      provider: out.provider,
      model: out.model,
      test: out.test,
      usage: out.usage,
      promptSha256,
      filter: pre.filter!,
      mode: input.mode,
      state: "awaiting-payment",
      createdAt: Date.now(),
      agent: agent.address,
      deadline: deadline.toString(),
      agentSig,
    };
    await dbPut("renders", assetHash, record);
    console.log(JSON.stringify({ service: "render", licenceId: record.licenceId, renderIndex, model: out.model, test: out.test, assetHash, mode: input.mode }));

    if (input.mode === "wallet") {
      return { record: publicRecord(record, false), authorisation: { licenceId: input.licenceId, assetHash, agent: agent.address, deadline, agentSig, renderIndex }, attempts: out.attempts };
    }
    const sent = await sendDelegatedPayRender(input.licensee, { licenceId: input.licenceId, assetHash, agent: agent.address, deadline, agentSig });
    Object.assign(record, { state: "paid", tx: sent.hash, gasUsed: sent.gasUsed.toString(), confirmMs: sent.confirmMs, block: sent.blockNumber.toString(), paidBy: sent.provider });
    console.log(JSON.stringify({ service: "tx", hash: sent.hash, fn: "payRender (delegated)", from: input.licensee, ms: sent.confirmMs, gasUsed: sent.gasUsed.toString() }));
    await dbPut("renders", assetHash, record);
    return { record: publicRecord(record, true), attempts: out.attempts };
  });
}

/** Wallet mode: once the brand's payRender is on chain, release the file. */
export async function claim(assetHash: Hex, tx: Hex | undefined) {
  const r = await dbGet<RenderRecord>("renders", assetHash);
  if (!r) throw new GenerateError(404, "no such render");
  const receipt = await readReceipt(assetHash);
  if (!receipt) throw new GenerateError(402, "no receipt on chain for this file yet: send payRender first");
  if (r.state !== "paid") {
    Object.assign(r, { state: "paid", tx, paidBy: "brand wallet" });
    await dbPut("renders", assetHash, r);
  }
  return publicRecord(r, true);
}

/** What the licensee sees. The download token is included only once the render is paid. */
export function publicRecord(r: RenderRecord, withToken: boolean) {
  const { token, file, agentSig, ...rest } = r;
  void file;
  void agentSig;
  return { ...rest, download: withToken && r.state === "paid" ? `/api/renders/file/${token}` : undefined };
}

export async function rendersFor(filter: { licensee?: Address; licenceId?: string }) {
  const all = await dbList<RenderRecord>("renders");
  return all
    .filter((r) => (!filter.licensee || r.licensee === filter.licensee.toLowerCase()) && (!filter.licenceId || r.licenceId === filter.licenceId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function fileByToken(token: string): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const r = (await dbList<RenderRecord>("renders")).find((x) => x.token === token && x.state === "paid");
  if (!r) return null;
  const bytes = await fileGet(`renders/${r.file}`, path.join(/*turbopackIgnore: true*/ rendersDir(), r.file));
  if (!bytes) return null;
  return { bytes, mime: r.mime, name: `likeness-${r.licenceId}-${r.renderIndex}${r.test ? "-TEST-RENDER" : ""}.${r.file.split(".").pop()}` };
}
