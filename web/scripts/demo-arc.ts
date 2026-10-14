/**
 * The scripted end-to-end flow on Arc mainnet, with demo wallets and a synthetic, non-real face.
 *
 *   pnpm demo:arc --plan   No transactions. Rehearses every on-chain step on a local arc-anvil fork of
 *                          Arc mainnet with the real keys, and prices each at the live gas price.
 *   pnpm demo:arc --run    Runs it on Arc mainnet, stopping at the first failure:
 *     fund the demo creator and brand from the deployer → seal the three synthetic photos (dev-key
 *     path) and store the ciphertext on the live site → register the creator with an attestation
 *     signed by the attester, provider "demo-scripted" → Brew & Co. brand profile and policy on the
 *     live site → licence request, creator's EIP-712 approval, brand issues → approve and deposit →
 *     release and one Gemini render in this process (C2PA, render-agent signature, wallet-mode
 *     payRender from the brand) → verify (local and live) → creator revokes → a second render is
 *     refused → verify again → brand refunds. Writes deployments/arc-mainnet-demo.json.
 *
 * Keys: ../.secrets/deployer.key (funds), ../.secrets/demo/{creator,brand}.key, the attester and render
 * agent keys. Faces: ../.secrets/demo/faces/{front,left,right}.jpg. Only addresses are printed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { LicenseRegistryAbi } from "@/lib/abi/LicenseRegistry";
import { signAttestation } from "@/lib/attestation";
import { actionMessage } from "@/lib/auth";
import { BRAND_POLICY_VERSION, brandPolicyHash, brandProfileFields } from "@/lib/brand-policy";
import { arcMainnet, MIN_MAX_FEE_PER_GAS, USDC } from "@/lib/chain";
import { ALL_REGIONS } from "@/lib/categories";
import { deployment } from "@/lib/deployment";
import { approvalTypedData, PROVIDERS, type LicenceRequest, type Terms } from "@/lib/licensing";
import { devAttestation } from "@/lib/dev/seed";

const PLAN = process.argv.includes("--plan");
const RUN = process.argv.includes("--run");
if (PLAN === RUN) throw new Error("pass exactly one of --plan or --run");
const MAINNET_RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const SITE = process.env.SITE_URL || "https://likenesss.vercel.app";

const FUND_CREATOR = parseEther("0.03"); // native USDC for gas
const FUND_BRAND = parseEther("0.25"); // gas plus a 0.20 deposit
const PRICE = 100_000n; // 0.10 USDC per render
const DEPOSIT = 200_000n; // 0.20 USDC: two renders
const RESERVE = parseEther("0.80"); // the deployer keeps at least this
const ADVERTISING = 1 << 8;
const PROMPT = "Smiling in a sunlit café holding a ceramic coffee cup, product shot for a spring campaign";
const BRAND = { name: "Brew & Co.", website: "brewandco.example", uses: ["Advertising"], monthlyRenders: "Under 50" };
const TERMS: Terms = { categories: ADVERTISING | (1 << 9), regions: ALL_REGIONS, maxDuration: 7n * 86_400n, maxRenders: 10, pricePerRender: PRICE, autoApprove: false };

const key = (p: string) => readFileSync(`../.secrets/${p}.key`, "utf8").trim() as Hex;
const deployer = privateKeyToAccount(key("deployer"));
const creator = privateKeyToAccount(key("demo/creator"));
const brand = privateKeyToAccount(key("demo/brand"));
const attesterKey = key("attester");
const agent = privateKeyToAccount(key("render-agent"));
const usd = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)}`;
const X = "https://explorer.arc.io/tx/";

type Row = { step: string; from: string; hash: Hex; gasUsed: bigint; feeWei: bigint; ms: number; value?: bigint };
const rows: Row[] = [];
const who = (a: Address) => (a === deployer.address ? "deployer 0x6834" : a === creator.address ? "Demo Creator" : a === brand.address ? "Brew & Co." : a);

function rpc(url: string) {
  const chain = defineChain({ ...arcMainnet, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url, { retryCount: 3, retryDelay: 500 }) }) as PublicClient;
  const wallet = (acct: typeof deployer) => createWalletClient({ chain, transport: http(url), account: acct });
  return { chain, pub, wallet };
}

async function fees(pub: PublicClient) {
  const f = await pub.estimateFeesPerGas();
  return { maxFeePerGas: f.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? f.maxFeePerGas : MIN_MAX_FEE_PER_GAS, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
}

/** Send one transaction, time it from send to receipt, stop on failure. */
async function send(c: ReturnType<typeof rpc>, step: string, acct: typeof deployer, tx: { to: Address; data?: Hex; value?: bigint }) {
  const gas = await c.pub.estimateGas({ account: acct.address, ...tx });
  const f = await fees(c.pub);
  const t = performance.now();
  const hash = await c.wallet(acct).sendTransaction({ ...tx, gas: (gas * 115n) / 100n, ...f });
  const r = await c.pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  const ms = Math.round(performance.now() - t);
  const row = { step, from: who(acct.address), hash, gasUsed: r.gasUsed, feeWei: r.gasUsed * r.effectiveGasPrice, ms, value: tx.value };
  rows.push(row);
  console.log(`${step.padEnd(32)} ${row.from.padEnd(16)} ${r.status}  gas ${String(r.gasUsed).padStart(7)}  ${usd(row.feeWei)} USDC  ${String(ms).padStart(5)} ms  ${PLAN ? "(fork)" : X + hash}`);
  if (r.status !== "success") throw new Error(`${step} failed; stopping`);
  return r;
}

const call = (abi: unknown, functionName: string, args: unknown[]) => encodeFunctionData({ abi, functionName, args } as never);

async function register(c: ReturnType<typeof rpc>, refHash: Hex) {
  const registry = deployment.CreatorRegistry!;
  const attestation = devAttestation(refHash, PROVIDERS.demoScripted);
  const nonce = await c.pub.readContract({ address: registry, abi: CreatorRegistryAbi, functionName: "attestationNonce", args: [creator.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const sig = await signAttestation(attesterKey, registry, 5042, creator.address, attestation, nonce, deadline);
  return send(c, "CreatorRegistry.register", creator, { to: registry, data: call(CreatorRegistryAbi, "register", [creator.address, attestation, deadline, sig, TERMS]) });
}

function licenceRequest(purposeHash: Hex): LicenceRequest {
  return {
    creator: creator.address.toLowerCase() as Address,
    category: ADVERTISING,
    regions: ALL_REGIONS,
    duration: 7n * 86_400n,
    renderCap: 2,
    pricePerRender: PRICE,
    purposeHash,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400),
    salt: toHex(randomBytes(32)),
  };
}

async function issueAndFund(c: ReturnType<typeof rpc>, req: LicenceRequest, approval: Hex) {
  const r = await send(c, "LicenseRegistry.request (issue)", brand, { to: deployment.LicenseRegistry!, data: call(LicenseRegistryAbi, "request", [req, approval]) });
  const id = parseEventLogs({ abi: LicenseRegistryAbi, logs: r.logs, eventName: "LicenceIssued" })[0].args.id as bigint;
  await send(c, "USDC.approve(escrow, 0.20)", brand, { to: USDC, data: call(erc20Abi, "approve", [deployment.LicenseEscrow!, DEPOSIT]) });
  await send(c, "LicenseEscrow.deposit(0.20)", brand, { to: deployment.LicenseEscrow!, data: call(LicenseEscrowAbi, "deposit", [id, DEPOSIT]) });
  return id;
}

async function plan() {
  const live = rpc(MAINNET_RPC);
  const [balance, block, f] = await Promise.all([live.pub.getBalance({ address: deployer.address }), live.pub.getBlock(), fees(live.pub)]);
  const price = (block.baseFeePerGas ?? 0n) + f.maxPriorityFeePerGas;
  const port = 8600 + Math.floor(Math.random() * 300);
  const p = spawn(process.env.ANVIL_BIN ?? `${homedir()}/.local/bin/arc-anvil`, ["--network", "arc", "--fork-url", MAINNET_RPC, "--port", String(port), "--silent"], { stdio: "ignore" });
  try {
    const c = rpc(`http://127.0.0.1:${port}`);
    for (let i = 0; i < 100; i++) {
      try {
        await c.pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    console.log(`PLAN (rehearsal on an arc-anvil fork; nothing sent). Live base fee ${Number(block.baseFeePerGas) / 1e9} gwei.\n`);
    await send(c, "fund Demo Creator 0.03", deployer, { to: creator.address, value: FUND_CREATOR });
    await send(c, "fund Brew & Co. 0.25", deployer, { to: brand.address, value: FUND_BRAND });
    await register(c, keccak256(toHex("plan-reference-set")));
    const req = licenceRequest(keccak256(toHex("plan-brief")));
    const approval = await creator.signTypedData(approvalTypedData(5042, deployment.LicenseRegistry!, req, brand.address));
    const id = await issueAndFund(c, req, approval);
    const { renderTypedData } = await import("@/lib/server/agent");
    const assetHash = keccak256(toHex("plan-render"));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const agentSig = await agent.signTypedData(renderTypedData({ licenceId: id, assetHash, renderIndex: 0, deadline }));
    await send(c, "LicenseEscrow.payRender", brand, { to: deployment.LicenseEscrow!, data: call(LicenseEscrowAbi, "payRender", [id, assetHash, agent.address, deadline, agentSig]) });
    await send(c, "LicenseRegistry.revoke", creator, { to: deployment.LicenseRegistry!, data: call(LicenseRegistryAbi, "revoke", [id]) });
    await send(c, "LicenseEscrow.refund", brand, { to: deployment.LicenseEscrow!, data: call(LicenseEscrowAbi, "refund", [id]) });
  } finally {
    p.kill();
  }
  console.log("\nAt the live gas price:");
  const cost = (from: string) => rows.filter((r) => r.from === from).reduce((s, r) => s + r.gasUsed * price, 0n);
  for (const r of rows) console.log(`  ${r.step.padEnd(32)} ${r.from.padEnd(16)} gas ${String(r.gasUsed).padStart(7)}  ${usd(r.gasUsed * price)} USDC`);
  const dGas = cost("deployer 0x6834"), cGas = cost("Demo Creator"), bGas = cost("Brew & Co.");
  console.log(`\ngas: deployer ${usd(dGas)}, Demo Creator ${usd(cGas)} (funded 0.03), Brew & Co. ${usd(bGas)} (funded 0.25, of which 0.20 is the deposit)`);
  console.log(`total gas ${usd(dGas + cGas + bGas)} USDC; deployer sends 0.28 USDC`);
  const after = balance - FUND_CREATOR - FUND_BRAND - dGas;
  console.log(`deployer now ${usd(balance)} → after funding ${usd(after)}; +0.01 fee from the render → ${usd(after + parseEther("0.01"))} (must stay ≥ 0.80)`);
  if (after < RESERVE) throw new Error(`shortfall ${usd(RESERVE - after)} USDC`);
  if (cGas > FUND_CREATOR) throw new Error("creator funding does not cover its gas");
  if (bGas + parseEther("0.20") > FUND_BRAND) throw new Error("brand funding does not cover gas plus the deposit");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${SITE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${r.status} ${(j as { error?: string }).error ?? ""}`);
  return j as T;
}

async function verifyLive(bytes: Uint8Array, mime: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: mime }), "arc-render-0.jpg");
  const r = await fetch(`${SITE}/api/verify`, { method: "POST", body: form });
  return (await r.json()) as { verdict: string; headline?: string; notes?: string[]; creator?: { address: string }; licensee?: string; receipt?: { tx: string } };
}

async function run() {
  const dir = ".data-demo";
  Object.assign(process.env, {
    STORE_DRIVER: "local",
    STORE_DIR: `${dir}/vault`,
    DB_DIR: `${dir}/db`,
    RENDERS_DIR: `${dir}/renders`,
    INDEX_CACHE_DIR: dir,
    RENDER_AGENT_KEY_FILE: "../.secrets/render-agent.key",
    ARC_RPC_URL: MAINNET_RPC,
  });
  delete process.env.DEV_DELEGATION;
  const c = rpc(MAINNET_RPC);
  const out: Record<string, unknown> = { site: SITE, creator: creator.address, brand: brand.address, deployer: deployer.address };
  const bal = async (a: Address) => c.pub.getBalance({ address: a });
  const start = { deployer: await bal(deployer.address) };
  if (start.deployer - FUND_CREATOR - FUND_BRAND - parseEther("0.01") < RESERVE) throw new Error("deployer would drop under 0.80 USDC; stopping");
  console.log(`RUN on Arc mainnet. Site ${SITE}. Deployer ${usd(start.deployer)} USDC.\n`);

  // 1. Fund the demo wallets.
  await send(c, "fund Demo Creator 0.03", deployer, { to: creator.address, value: FUND_CREATOR });
  await send(c, "fund Brew & Co. 0.25", deployer, { to: brand.address, value: FUND_BRAND });

  // 2. Seal the synthetic photos (dev-key path) and store the ciphertext on the live site and locally.
  const { sealDevReferenceSet } = await import("@/lib/dev/seed");
  const secretFile = "../.secrets/demo/creator.devsecret";
  if (!existsSync(secretFile)) writeFileSync(secretFile, toHex(randomBytes(32)) + "\n", { mode: 0o600 });
  const devSecret = readFileSync(secretFile, "utf8").trim();
  const faces = ["front", "left", "right"].map((n) => new Uint8Array(readFileSync(`../.secrets/demo/faces/${n}.jpg`)));
  const sealed = await sealDevReferenceSet(creator.address.toLowerCase() as Address, devSecret, faces);
  faces.forEach((f) => f.fill(0));
  const put = await fetch(`${SITE}/api/vault/${sealed.vaultKey}`, { method: "PUT", body: JSON.stringify(sealed.set) });
  if (!(put.status === 201 || put.status === 409)) throw new Error(`vault PUT on the live site: ${put.status}`);
  const { putCiphertext, getCiphertext } = await import("@/lib/server/store");
  if (!(await getCiphertext(sealed.vaultKey))) await putCiphertext(sealed.vaultKey, JSON.stringify(sealed.set));
  console.log(`sealed reference set ${sealed.hash} → live vault (${put.status}) and local copy`);

  // 3. Register the creator: attestation by the attester, provider "demo-scripted".
  await register(c, sealed.hash);

  // 4. Brew & Co. brand profile and policy, through the live site's brand routes.
  const sign = (acct: typeof brand, action: string, fields: Record<string, string>) => {
    const message = actionMessage(action, { wallet: acct.address.toLowerCase(), ...fields });
    return acct.signMessage({ message }).then((signature) => ({ message, signature }));
  };
  const fields = brandProfileFields({ ...BRAND, uses: [...BRAND.uses], logoSha256: null });
  await api("/api/brands", { method: "POST", body: JSON.stringify({ address: brand.address, auth: await sign(brand, "save brand profile", fields), ...BRAND, logo: null }) });
  await api("/api/brands/policy", { method: "POST", body: JSON.stringify({ address: brand.address, auth: await sign(brand, "agree to the brand policy", { version: BRAND_POLICY_VERSION, "text sha256": await brandPolicyHash() }) }) });
  console.log("Brew & Co. brand profile and policy saved on the live site");

  // 5. Licence: the brand requests, the creator approves (EIP-712), the brand issues and deposits.
  const stored = await api<{ id: string; request: Record<string, string | number> }>("/api/requests", {
    method: "POST",
    body: JSON.stringify({ licensee: brand.address, creator: creator.address, category: ADVERTISING, regions: ALL_REGIONS, durationDays: 7, renderCap: 2, pricePerRender: PRICE.toString(), brief: { brand: "Brew & Co.", campaign: "Spring café", use: "Two advertising images" } }),
  });
  const { toRequest } = await import("@/lib/server/requests");
  const req = toRequest(stored.request as never);
  const approval = await creator.signTypedData(approvalTypedData(5042, deployment.LicenseRegistry!, req, brand.address));
  await api(`/api/requests/${stored.id}`, { method: "POST", body: JSON.stringify({ approve: true, signature: approval }) });
  console.log(`licence request ${stored.id} filed and approved on the live site`);
  const licenceId = await issueAndFund(c, req, approval);
  out.licenceId = licenceId.toString();

  // 6. Release and render in this one process.
  const { serviceKey, acceptLicenceRelease } = await import("@/lib/server/keyring");
  const { devNamespaceKey } = await import("@/lib/crypto/devkeys");
  const { unwrapDek } = await import("@/lib/crypto/envelope");
  const { releaseToService } = await import("@/lib/crypto/release");
  const { b64u } = await import("@/lib/crypto/encoding");
  const { publicKey } = await serviceKey(licenceId);
  const ref = await devNamespaceKey(devSecret, { kind: "reference" });
  const dek = await unwrapDek(ref.kek, sealed.set);
  await acceptLicenceRelease(licenceId, await releaseToService(dek, b64u.decode(publicKey), licenceId), sealed.vaultKey);
  dek.fill(0);
  console.log("creator released the photos to this licence's service key");

  const { generate, claim, fileByToken } = await import("@/lib/server/generate");
  const g = await generate({ licenceId, licensee: brand.address, prompt: PROMPT, mode: "wallet" });
  const a = g.authorisation!;
  const creatorUsdcBefore = await c.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [creator.address] });
  const treasuryBefore = await bal(deployer.address);
  await send(c, "LicenseEscrow.payRender", brand, { to: deployment.LicenseEscrow!, data: call(LicenseEscrowAbi, "payRender", [a.licenceId, a.assetHash, a.agent, a.deadline, a.agentSig]) });
  const creatorUsdcAfter = await c.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [creator.address] });
  const treasuryAfter = await bal(deployer.address);
  const claimed = await claim(a.assetHash, undefined);
  const file = (await fileByToken(claimed.download!.split("/").pop()!))!;
  const bytes = new Uint8Array(file.bytes);
  mkdirSync("../demo-renders", { recursive: true });
  writeFileSync("../demo-renders/arc-render-0.jpg", bytes);
  out.render = { assetHash: a.assetHash, mime: file.mime, model: g.record.model, test: g.record.test, saved: "demo-renders/arc-render-0.jpg" };
  console.log(`render saved: demo-renders/arc-render-0.jpg (${file.mime}, ${bytes.length} bytes, model ${g.record.model}, test ${g.record.test})`);

  // 7. Verify, locally and on the live site.
  const { verifyFile } = await import("@/lib/server/verify");
  const v1 = await verifyFile(bytes, file.mime);
  const l1 = await verifyLive(bytes, file.mime);
  out.verifyAfterRender = { local: { verdict: v1.verdict, headline: v1.headline }, live: { verdict: l1.verdict, headline: l1.headline } };
  console.log(`verify: local ${v1.verdict} (${v1.headline}); live ${l1.verdict} (${l1.headline})`);

  // 8. Revoke; a second render is refused; verify again.
  await send(c, "LicenseRegistry.revoke", creator, { to: deployment.LicenseRegistry!, data: call(LicenseRegistryAbi, "revoke", [licenceId]) });
  let refused = "";
  try {
    await generate({ licenceId, licensee: brand.address, prompt: PROMPT, mode: "wallet" });
    throw new Error("a second render after revocation was NOT refused");
  } catch (e) {
    const err = e as Error & { status?: number; details?: { checks?: { name: string; ok: boolean; detail: string }[] } };
    if (/NOT refused/.test(err.message)) throw err;
    const failed = (err.details?.checks ?? []).filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`);
    refused = `${err.constructor.name} ${err.status ?? ""}: ${err.message}${failed.length ? ` (${failed.join("; ")})` : ""}`;
  }
  out.secondRender = refused;
  console.log(`second render refused: ${refused}`);
  const v2 = await verifyFile(bytes, file.mime);
  const l2 = await verifyLive(bytes, file.mime);
  out.verifyAfterRevoke = { local: { verdict: v2.verdict, headline: v2.headline }, live: { verdict: l2.verdict, headline: l2.headline } };
  console.log(`verify after revoke: local ${v2.verdict} (${v2.headline}); live ${l2.verdict} (${l2.headline})`);

  // 9. Refund the unused deposit.
  const brandBefore = await bal(brand.address);
  const refund = await send(c, "LicenseEscrow.refund", brand, { to: deployment.LicenseEscrow!, data: call(LicenseEscrowAbi, "refund", [licenceId]) });
  const brandAfter = await bal(brand.address);

  // 10. Money check.
  const check = {
    creatorReceived: formatUnits(creatorUsdcAfter - creatorUsdcBefore, 6),
    treasuryReceived: formatEther(treasuryAfter - treasuryBefore),
    brandRefunded: formatEther(brandAfter - brandBefore + refund.gasUsed * refund.effectiveGasPrice),
    final: {
      deployer: formatEther(await bal(deployer.address)),
      creator: formatEther(await bal(creator.address)),
      brand: formatEther(await bal(brand.address)),
    },
  };
  out.moneyCheck = check;
  out.transactions = rows.map((r) => ({ step: r.step, from: r.from, hash: r.hash, gasUsed: r.gasUsed.toString(), feeUsdc: formatEther(r.feeWei), sendToReceiptMs: r.ms, ...(r.value ? { valueUsdc: formatEther(r.value) } : {}) }));
  writeFileSync("../deployments/arc-mainnet-demo.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`\nmoney check: ${JSON.stringify(check)}\nwrote deployments/arc-mainnet-demo.json`);
}

(PLAN ? plan() : run()).catch((e) => {
  console.error("STOPPED:", e instanceof Error ? e.message.split("\n")[0] : e);
  process.exit(1);
});
