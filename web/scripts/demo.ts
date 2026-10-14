/**
 * The whole protocol in one command, through the app's own server modules (the same code the API
 * routes run), printing every transaction hash:
 *
 *   seed the unverified test creator → fund a test brand with USDC → licence → deposit → key release
 *   → two renders (Gemini when GEMINI_API_KEY is set, else the DevRenderer; C2PA; payRender) →
 *   two banned prompts refused → verify one file →
 *   revoke → render refused → verify again ("licensed when made, since revoked") → refund
 *
 *   pnpm demo --fork    A local arc-anvil fork of Arc mainnet: the deployed contracts and Circle's real
 *                       USDC contract, with local balances. Hashes are local, not on Arc Explorer.
 *   pnpm seed           Arc mainnet, seed only: the render agent, and a test brand wallet with gas.
 *
 * The scripted creator ("dev-unverified", synthetic drawings) exists only on the throwaway fork. On
 * Arc mainnet there is no test creator: the live demo runs in the app with a Didit-verified creator.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  toHex,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { LicenseRegistryAbi } from "@/lib/abi/LicenseRegistry";
import { arcMainnet, USDC } from "@/lib/chain";
import { b64u } from "@/lib/crypto/encoding";
import { devNamespaceKey } from "@/lib/crypto/devkeys";
import { unwrapDek } from "@/lib/crypto/envelope";
import { releaseToService } from "@/lib/crypto/release";
import { deployment } from "@/lib/deployment";
import { dealUsdc, startFork, takeOverRoles, type Fork } from "@/lib/dev/fork";
import { registerDevCreator, sealDevReferenceSet } from "@/lib/dev/seed";
import { purposeHash, usdc, type Terms } from "@/lib/licensing";

const args = new Set(process.argv.slice(2));
const FORK = args.has("--fork");
const SEED_ONLY = args.has("--seed-only");
const SECRETS = path.resolve("../.secrets");
const PRICE = usdc.parse(process.env.DEMO_PRICE_USDC ?? "0.25");
const RENDERS = 2;
const DEPOSIT = PRICE * BigInt(RENDERS + 2); // two renders, the rest comes back on refund

type W = WalletClient<Transport, Chain, Account>;
type Logged = { step: string; hash: Hex; gasUsed?: bigint; ms?: number };
const txs: Logged[] = [];
let forkHandle: Fork | undefined;

const line = (s = "") => console.log(s);
const head = (s: string) => line(`\n── ${s}`);
const link = (h: string) => (FORK ? `${h}  (local fork)` : `https://explorer.arc.io/tx/${h}`);

function readKey(file: string): Hex | undefined {
  if (!existsSync(file)) return undefined;
  const k = readFileSync(file, "utf8").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : undefined;
}

function keyFile(file: string): Hex {
  const k = readKey(file);
  if (k) return k;
  const fresh = generatePrivateKey();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, fresh + "\n", { mode: 0o600 });
  return fresh;
}

async function main() {
  // ------------------------------------------------------------ environment
  // Provider keys (GEMINI_API_KEY, model ids) come from .env.local, as in the app; every path below
  // is then pointed at the demo's own data directories.
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  let fork: Fork | undefined;
  let pub: PublicClient;
  let chain: Chain = arcMainnet;
  let rpc = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
  const dataDir = path.resolve(FORK ? ".data/demo-fork" : ".data");
  const devDir = FORK ? path.join(dataDir, "dev-keys") : path.join(SECRETS, "dev");

  if (FORK) {
    line("Starting an arc-anvil fork of Arc mainnet…");
    fork = forkHandle = await startFork(Number(process.env.DEMO_FORK_PORT ?? 8555));
    rpc = fork.url;
    chain = fork.chain;
    pub = fork.pub as PublicClient;
  } else {
    pub = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  }
  Object.assign(process.env, {
    ARC_RPC_URL: rpc,
    STORE_DIR: path.join(dataDir, "vault"),
    DB_DIR: path.join(dataDir, "db"),
    RENDERS_DIR: path.join(dataDir, "renders"),
    INDEX_CACHE_DIR: dataDir,
    DEV_DELEGATION: "1",
    DEV_KEYS_DIR: devDir,
    ...(fork ? { INDEX_START_BLOCK: String(fork.forkBlock + 1n) } : {}),
  });

  const wallet = (key: Hex): W => createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(key) });
  async function send(step: string, w: W, call: Record<string, unknown>): Promise<Hex> {
    const gas = await pub.estimateContractGas({ account: w.account, ...call } as never);
    const t = Date.now();
    const hash = await w.writeContract({ ...call, gas: (gas * 115n) / 100n } as never);
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    const ms = Date.now() - t;
    if (r.status !== "success") throw new Error(`${step} reverted: ${hash}`);
    txs.push({ step, hash, gasUsed: r.gasUsed, ms });
    line(`   ${step}: ${link(hash)}  gas ${r.gasUsed} · ${ms} ms`);
    return hash;
  }
  async function sendValue(step: string, w: W, to: Address, value: bigint) {
    const t = Date.now();
    const hash = await w.sendTransaction({ to, value });
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    txs.push({ step, hash, gasUsed: r.gasUsed, ms: Date.now() - t });
    line(`   ${step}: ${link(hash)}`);
  }

  // ------------------------------------------------------------ keys and roles
  head("1. Platform roles and test wallets");
  let attesterKey: Hex;
  const agentKey = FORK ? generatePrivateKey() : keyFile(path.join(SECRETS, "render-agent.key"));
  const agentAddr = privateKeyToAccount(agentKey).address;
  const agentFile = FORK ? path.join(dataDir, "render-agent.key") : path.join(SECRETS, "render-agent.key");
  if (FORK) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(agentFile, agentKey, { mode: 0o600 });
    attesterKey = generatePrivateKey();
    await takeOverRoles(fork!, { attester: privateKeyToAccount(attesterKey).address, agent: agentAddr });
    line("   fork: attester and render agent pointed at throwaway keys (owner impersonated)");
  } else {
    attesterKey = readKey(path.join(SECRETS, "attester.key")) ?? (() => { throw new Error("../.secrets/attester.key missing"); })();
  }
  process.env.RENDER_AGENT_KEY_FILE = agentFile;
  delete process.env.RENDER_AGENT_PRIVATE_KEY;

  const walletsFile = path.join(devDir, "wallets.json");
  type DevW = { role: "creator" | "brand"; label: string; address: Address; key: Hex; devSecret?: Hex };
  let seeded: { note: string; wallets: DevW[] } | null = existsSync(walletsFile) ? JSON.parse(readFileSync(walletsFile, "utf8")) : null;
  if (!seeded) {
    const brandKey = generatePrivateKey();
    seeded = { note: "DEV ONLY: throwaway test wallets.", wallets: [{ role: "brand", label: "Brew & Co. (test brand)", address: privateKeyToAccount(brandKey).address, key: brandKey }] };
  }
  // A test creator only ever exists on the fork; on Arc mainnet any old one is dropped from the file.
  seeded.wallets = seeded.wallets.filter((w) => w.role !== "creator" || FORK);
  if (FORK && !seeded.wallets.some((w) => w.role === "creator")) {
    const creatorKey = generatePrivateKey();
    seeded.wallets.unshift({ role: "creator", label: "Fork test creator (unverified)", address: privateKeyToAccount(creatorKey).address, key: creatorKey, devSecret: toHex(crypto.getRandomValues(new Uint8Array(32))) });
  }
  mkdirSync(devDir, { recursive: true, mode: 0o700 });
  writeFileSync(walletsFile, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  const B = seeded.wallets.find((w) => w.role === "brand")!;
  writeFileSync(path.join(devDir, `${B.address.toLowerCase()}.key`), B.key, { mode: 0o600 }); // for dev delegation
  const brand = wallet(B.key);
  if (!FORK && !SEED_ONLY) {
    line("\nThe scripted demo runs only on a fork: pnpm demo --fork.");
    line("On Arc mainnet there is no test creator; run the demo in the app with a Didit-verified creator.");
    process.exitCode = 2;
    return;
  }
  const C = seeded.wallets.find((w) => w.role === "creator");
  if (C) line(`   creator ${C.address} (fork-only test creator, unverified)`);
  line(`   brand   ${B.address}`);
  line(`   agent   ${agentAddr}`);

  // ------------------------------------------------------------ preflight: USDC
  const funderKey = FORK ? undefined : readKey(process.env.DEMO_FUNDER_KEY_FILE ?? path.join(SECRETS, "deployer.key"));
  if (!FORK && !SEED_ONLY) {
    // unreachable: testnet runs stop above; kept for the funder check if a testnet run is reintroduced
    if (!funderKey) throw new Error("no funder key (DEMO_FUNDER_KEY_FILE)");
    const funder = privateKeyToAccount(funderKey).address;
    const have = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [funder] });
    const brandHas = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [B.address] });
    if (have + brandHas < DEPOSIT) {
      line(`\nThe funder ${funder} holds ${usdc.format(have)} USDC and the test brand ${usdc.format(brandHas)}; the demo needs ${usdc.format(DEPOSIT)}.`);
      line("Get Circle testnet USDC at https://faucet.circle.com (network: Arc mainnet) for either address, then re-run.");
      line("Or run the same demo on a local fork now: pnpm demo --fork");
      process.exitCode = 2;
      return;
    }
  }

  // ------------------------------------------------------------ gas
  head("2. Gas");
  if (FORK) {
    for (const a of [C!.address, B.address]) await fork!.test.setBalance({ address: a, value: parseEther("5") });
    line("   fork: 5 USDC (native, for gas) each");
  } else {
    const gasKey = readKey(path.join(SECRETS, "drip.key")) ?? funderKey;
    if (!gasKey) throw new Error("no key to pay gas from (../.secrets/drip.key)");
    const gasWallet = wallet(gasKey);
    for (const [who, a] of [["brand", B.address]] as const) {
      const bal = await pub.getBalance({ address: a });
      if (bal < parseEther("0.15")) await sendValue(`USDC for ${who} gas`, gasWallet, a, parseEther("0.3"));
      else line(`   ${who} has ${formatEther(bal)} USDC for gas`);
    }
  }

  // ------------------------------------------------------------ render agent registered
  const escrow = deployment.LicenseEscrow!;
  const isAgent = await pub.readContract({ address: escrow, abi: LicenseEscrowAbi, functionName: "isRenderAgent", args: [agentAddr] });
  if (!isAgent) {
    const ownerKey = readKey(path.join(SECRETS, "deployer.key"));
    if (!ownerKey) throw new Error("render agent not registered and no owner key to register it");
    await send("register render agent (LicenseEscrow.setRenderAgent)", wallet(ownerKey), { address: escrow, abi: LicenseEscrowAbi, functionName: "setRenderAgent", args: [agentAddr, true] });
  }

  if (SEED_ONLY) return summary();

  // ------------------------------------------------------------ seed creator (fork only)
  head("3. Seed the fork-only test creator");
  if (!C?.devSecret) throw new Error("no fork test creator");
  const devSecret = C.devSecret;
  const creator = wallet(C.key);
  const { putCiphertext, getCiphertext } = await import("@/lib/server/store");
  const registry = deployment.CreatorRegistry!;
  const terms: Terms = { categories: (1 << 8) | (1 << 9), regions: 0x3f, maxDuration: 30n * 86_400n, maxRenders: 20, pricePerRender: PRICE, autoApprove: true };
  let refHash: Hex;
  let vaultKey: string;
  const onChain = await pub.readContract({ address: registry, abi: CreatorRegistryAbi, functionName: "creator", args: [C.address] });
  if (onChain.registered) {
    refHash = onChain.attestation.referenceSetHash;
    const ref = await devNamespaceKey(devSecret, { kind: "reference" });
    const { vaultId } = await import("@/lib/crypto/vault");
    vaultKey = vaultId(ref.credentialId, `reference-set:${refHash}`);
    if (!(await getCiphertext(vaultKey))) throw new Error("creator is registered but its sealed reference set is not in this vault");
    line("   already registered");
  } else {
    const sealed = await sealDevReferenceSet(C.address, devSecret);
    await putCiphertext(sealed.vaultKey, JSON.stringify(sealed.set));
    refHash = sealed.hash;
    vaultKey = sealed.vaultKey;
    line(`   synthetic reference set sealed (3 drawings, not a person); ciphertext hash ${refHash}`);
    const t = Date.now();
    const hash = await registerDevCreator({ pub, creator, attesterKey, registry, refHash, terms });
    const r = await pub.getTransactionReceipt({ hash });
    txs.push({ step: "register creator (dev-unverified)", hash, gasUsed: r.gasUsed, ms: Date.now() - t });
    line(`   register creator (dev-unverified): ${link(hash)}  gas ${r.gasUsed}`);
  }
  const { readCreator } = await import("@/lib/server/protocol");
  const cv = (await readCreator(C.address))!;
  line(`   trust label: ${cv.trust.level}  (liveness: ${cv.trust.liveness}, age: ${cv.trust.age})`);
  if (cv.terms.pricePerRender !== PRICE || !cv.terms.autoApprove)
    await send("set terms", creator, { address: registry, abi: CreatorRegistryAbi, functionName: "setTerms", args: [terms] });

  // ------------------------------------------------------------ USDC
  head("4. Fund the test brand with USDC");
  if (FORK) {
    await dealUsdc(fork!, B.address, DEPOSIT * 2n);
    line(`   fork: ${usdc.format(DEPOSIT * 2n)} USDC written to the brand's balance in Circle's USDC contract`);
  } else {
    const brandHas = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [B.address] });
    if (brandHas < DEPOSIT)
      await send(`USDC ${usdc.format(DEPOSIT - brandHas)} to brand`, wallet(funderKey!), { address: USDC, abi: erc20Abi, functionName: "transfer", args: [B.address, DEPOSIT - brandHas] });
    else line(`   brand already holds ${usdc.format(brandHas)} USDC`);
  }

  // ------------------------------------------------------------ licence
  head("5. Licence (auto-approved inside the creator's terms)");
  const { saveBrief } = await import("@/lib/server/requests");
  const brief = { brand: "Brew & Co.", campaign: `Demo ${new Date().toISOString().slice(0, 16)}`, use: "Two social posts (TEST RENDER)" };
  await saveBrief(brief);
  const req = { creator: C.address, category: 1 << 9, regions: 1 | 4, duration: 7n * 86_400n, renderCap: RENDERS + 2, pricePerRender: PRICE, purposeHash: purposeHash(brief), deadline: 0n, salt: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  const reqHash = await send("request licence", brand, { address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "request", args: [req, "0x"] });
  const issued = parseEventLogs({ abi: LicenseRegistryAbi, logs: (await pub.getTransactionReceipt({ hash: reqHash })).logs, eventName: "LicenceIssued" })[0];
  const licenceId = issued.args.id;
  line(`   licence #${licenceId}: Social, ${RENDERS + 2} renders at ${usdc.format(PRICE)} USDC, 7 days`);

  head("6. Escrow deposit");
  await send("approve USDC", brand, { address: USDC, abi: erc20Abi, functionName: "approve", args: [escrow, DEPOSIT] });
  await send(`deposit ${usdc.format(DEPOSIT)} USDC`, brand, { address: escrow, abi: LicenseEscrowAbi, functionName: "deposit", args: [licenceId, DEPOSIT] });

  // ------------------------------------------------------------ key release
  head("7. Key release to this licence's ephemeral service key");
  const { serviceKey, acceptLicenceRelease } = await import("@/lib/server/keyring");
  const { publicKey } = await serviceKey(licenceId);
  const ref = await devNamespaceKey(devSecret, { kind: "reference" });
  const dek = await unwrapDek(ref.kek, JSON.parse((await getCiphertext(vaultKey))!));
  const release = await releaseToService(dek, b64u.decode(publicKey), licenceId);
  dek.fill(0);
  const accepted = await acceptLicenceRelease(licenceId, release, vaultKey);
  line(`   creator re-wrapped the photo key to the service key; ${accepted.captures} captures open and match their digests`);

  // ------------------------------------------------------------ delegation
  head("8. Delegated render payments (DEV delegation: payRender only, chain 5042, total cap)");
  const { saveGrant } = await import("@/lib/server/delegation");
  await saveGrant({ licensee: B.address.toLowerCase() as Address, provider: "dev-local", capUsdc: (PRICE * BigInt(RENDERS)).toString(), spentUsdc: "0", createdAt: Date.now() });
  line(`   cap ${usdc.format(PRICE * BigInt(RENDERS))} USDC. Dynamic delegated access replaces this when its credentials are set.`);

  // ------------------------------------------------------------ renders
  head(`9. ${RENDERS} renders`);
  const { generate } = await import("@/lib/server/generate");
  const { rendererPlan } = await import("@/lib/server/render");
  line(`   renderer: ${rendererPlan().primary}`);
  const { checkPrompt } = await import("@/lib/server/filter");
  for (const p of [
    "At a podium in a flag-draped hall, asking voters to back Maria Lopez for governor next month",
    "In handcuffs being led out of a bank by police, shot like a real news photo",
  ]) {
    const f = await checkPrompt(p, 1 << 9);
    line(`   blocked prompt ${f.allowed ? "NOT BLOCKED" : "refused"}: “${p.slice(0, 48)}…” → ${f.reasons[0] ?? "-"}`);
  }
  const prompts = ["Smiling in a sunlit cafe holding a ceramic coffee cup, product shot", "Walking through a city park in autumn, lifestyle photo for a social post"];
  const files: { bytes: Uint8Array; mime: string }[] = [];
  for (const prompt of prompts.slice(0, RENDERS)) {
    const r = await generate({ licenceId, licensee: B.address.toLowerCase() as Address, prompt, mode: "delegated" });
    txs.push({ step: `payRender (render ${r.record.renderIndex})`, hash: r.record.tx!, gasUsed: BigInt(r.record.gasUsed!), ms: r.record.confirmMs });
    line(`   render ${r.record.renderIndex} [${r.record.test ? "TEST RENDER" : r.record.model}] payRender: ${link(r.record.tx!)}  gas ${r.record.gasUsed} · ${r.record.confirmMs} ms`);
    line(`      asset ${r.record.assetHash}`);
    if (r.record.usage) line(`      model usage ${JSON.stringify(r.record.usage)}`);
    const { fileByToken } = await import("@/lib/server/generate");
    const f = (await fileByToken(r.record.download!.split("/").pop()!))!;
    files.push({ bytes: new Uint8Array(f.bytes), mime: f.mime });
  }

  // ------------------------------------------------------------ verify
  head("10. Verify render 0");
  const { verifyFile } = await import("@/lib/server/verify");
  let v = await verifyFile(files[0].bytes, files[0].mime);
  line(`   ${v.verdict}: ${v.headline}`);
  for (const n of v.notes) line(`   · ${n}`);

  // ------------------------------------------------------------ revoke
  head("11. Revoke");
  await send(`revoke licence #${licenceId}`, creator, { address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "revoke", args: [licenceId] });
  try {
    await generate({ licenceId, licensee: B.address.toLowerCase() as Address, prompt: "one more", mode: "delegated" });
    throw new Error("render after revoke was NOT refused");
  } catch (e) {
    const d = (e as { details?: { checks?: { name: string; ok: boolean; detail: string }[] } }).details;
    line(`   render refused: ${d?.checks?.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join(", ") ?? (e as Error).message}`);
  }
  v = await verifyFile(files[0].bytes, files[0].mime);
  line(`   verify render 0 again → ${v.verdict}: ${v.headline}`);

  head("12. Refund unused escrow");
  await send("refund", brand, { address: escrow, abi: LicenseEscrowAbi, functionName: "refund", args: [licenceId] });

  const outDir = path.join(dataDir, "demo-output");
  mkdirSync(outDir, { recursive: true });
  files.forEach((f, i) => writeFileSync(path.join(outDir, `licence-${licenceId}-render-${i}.${f.mime === "image/png" ? "png" : "jpg"}`), f.bytes));
  line(`\n   rendered files: ${outDir}  (sha256 of render 0: 0x${createHash("sha256").update(files[0].bytes).digest("hex")})`);
  summary();

  function summary() {
    head(`Transactions (${FORK ? "local fork of Arc mainnet" : "Arc mainnet"})`);
    for (const t of txs) line(`   ${t.step.padEnd(44)} ${t.hash}${t.gasUsed ? `  gas ${t.gasUsed}` : ""}${t.ms !== undefined ? `  ${t.ms} ms` : ""}`);
  }
}

main()
  .catch((e) => {
    console.error(`\ndemo failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // anvil (fork mode) is a child process: stop it, then exit.
    forkHandle?.stop();
    setTimeout(() => process.exit(), 100);
  });
