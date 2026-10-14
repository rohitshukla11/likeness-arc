/**
 * Fund the gas top-up wallet and deploy and wire the four contracts on Arc mainnet, one transaction at a
 * time, timing each from send to receipt.
 *
 *   pnpm deploy:arc --preflight   No transactions. Rehearses every step on a local arc-anvil fork of
 *                                 Arc mainnet as the real deployer, then prices each one at the live
 *                                 gas price: gas, gas limit, expected cost, worst case, total, and what
 *                                 the deployer keeps.
 *   pnpm deploy:arc --broadcast   Sends the same eight transactions to Arc mainnet, one at a time,
 *                                 stopping at the first failure, and writes deployments/arc-mainnet.json.
 *                                 Refuses to start unless the deployer keeps at least RESERVE in the
 *                                 worst case.
 *
 * Keys: ../.secrets/deployer.key must be the owner and treasury, OWNER below. The attester, render agent
 * and drip addresses come from their key files. Only addresses are printed.
 * Contracts come from contracts/out (run `forge build` in contracts/ first).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcMainnet, MIN_MAX_FEE_PER_GAS, USDC } from "@/lib/chain";

const PREFLIGHT = process.argv.includes("--preflight");
const BROADCAST = process.argv.includes("--broadcast");
if (PREFLIGHT === BROADCAST) throw new Error("pass exactly one of --preflight or --broadcast");
const MAINNET_RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";

const OWNER: Address = "0x68343Aa0598b7FCAA102769D172e59cdDfae10f2"; // deployer, owner and treasury
const FEE_BPS = 1_000; // 10%
const DRIP_FUNDING = parseEther("0.10"); // native USDC, 18 decimals: two 0.05 top-ups
const RESERVE = parseEther("0.40"); // the deployer must keep at least this, worst case
const LIMIT_MARGIN = 110n; // gas limit = estimate + 10%
const MAX_OVER_REHEARSAL = 120n; // refuse if a live estimate is >20% over the rehearsal

const key = (name: string) => readFileSync(`../.secrets/${name}.key`, "utf8").trim() as Hex;
const deployer = privateKeyToAccount(key("deployer"));
if (deployer.address !== OWNER) throw new Error(`deployer key is ${deployer.address}, expected ${OWNER}`);
const attester = privateKeyToAccount(key("attester")).address;
const agent = privateKeyToAccount(key("render-agent")).address;
const drip = privateKeyToAccount(key("drip")).address;
const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(`../contracts/out/${name}.sol/${name}.json`, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};
const usd = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)} USDC`;

type Addrs = { creators?: Address; licences?: Address; receipts?: Address; escrow?: Address };
type Step = { label: string; tx: (a: Addrs) => { to?: Address; data?: Hex; value?: bigint }; save?: keyof Addrs };
const call = (name: string, to: (a: Addrs) => Address, functionName: string, args: (a: Addrs) => unknown[]) => (a: Addrs) => ({
  to: to(a),
  data: encodeFunctionData({ abi: artifact(name).abi, functionName, args: args(a) } as never),
});
const deploy = (name: string, args: (a: Addrs) => unknown[]) => (a: Addrs) => ({
  data: encodeDeployData({ abi: artifact(name).abi, bytecode: artifact(name).bytecode, args: args(a) }),
});

const STEPS: Step[] = [
  { label: "fund drip 0.10 USDC", tx: () => ({ to: drip, value: DRIP_FUNDING }) },
  { label: "deploy CreatorRegistry", save: "creators", tx: deploy("CreatorRegistry", () => [OWNER, attester]) },
  { label: "deploy LicenseRegistry", save: "licences", tx: deploy("LicenseRegistry", (a) => [OWNER, a.creators]) },
  { label: "deploy ReceiptAnchor", save: "receipts", tx: deploy("ReceiptAnchor", () => [OWNER]) },
  { label: "deploy LicenseEscrow", save: "escrow", tx: deploy("LicenseEscrow", (a) => [OWNER, USDC, a.licences, a.receipts, OWNER, FEE_BPS]) },
  { label: "LicenseRegistry.setEscrow", tx: call("LicenseRegistry", (a) => a.licences!, "setEscrow", (a) => [a.escrow]) },
  { label: "ReceiptAnchor.setEscrow", tx: call("ReceiptAnchor", (a) => a.receipts!, "setEscrow", (a) => [a.escrow]) },
  { label: "LicenseEscrow.setRenderAgent", tx: call("LicenseEscrow", (a) => a.escrow!, "setRenderAgent", () => [agent, true]) },
];

async function fees(pub: PublicClient) {
  const f = await pub.estimateFeesPerGas();
  return { maxFeePerGas: f.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? f.maxFeePerGas : MIN_MAX_FEE_PER_GAS, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
}

/** Run every step on an arc-anvil fork as the real deployer; returns gas used per step. */
async function rehearse(): Promise<bigint[]> {
  const port = 8600 + Math.floor(Math.random() * 300);
  const p = spawn(process.env.ANVIL_BIN ?? `${homedir()}/.local/bin/arc-anvil`, ["--network", "arc", "--fork-url", MAINNET_RPC, "--port", String(port), "--silent"], { stdio: "ignore" });
  try {
    const url = `http://127.0.0.1:${port}`;
    const chain = defineChain({ ...arcMainnet, rpcUrls: { default: { http: [url] } } });
    const pub = createPublicClient({ chain, transport: http(url) }) as PublicClient;
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // The fork starts from the deployer's real balance; nothing here touches the real chain.
    const wallet = createWalletClient({ chain, transport: http(url), account: deployer });
    void createTestClient;
    const a: Addrs = {};
    const used: bigint[] = [];
    for (const s of STEPS) {
      const hash = await wallet.sendTransaction({ ...s.tx(a), ...(await fees(pub)) });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`rehearsal: ${s.label} reverted`);
      if (s.save) a[s.save] = r.contractAddress!;
      used.push(r.gasUsed);
    }
    return used;
  } finally {
    p.kill();
  }
}

async function main() {
  const pub = createPublicClient({ chain: arcMainnet, transport: http(MAINNET_RPC, { retryCount: 3, retryDelay: 500 }) }) as PublicClient;
  if ((await pub.getChainId()) !== 5042) throw new Error("not Arc mainnet");
  const [balance, nonce, f, block] = await Promise.all([pub.getBalance({ address: OWNER }), pub.getTransactionCount({ address: OWNER }), fees(pub), pub.getBlock()]);
  const baseFee = block.baseFeePerGas ?? 0n;
  const price = baseFee + f.maxPriorityFeePerGas; // what a transaction pays per gas now

  console.log(`${PREFLIGHT ? "PRE-FLIGHT (no transactions)" : "ARC MAINNET BROADCAST"}`);
  console.log(`owner/treasury/deployer ${OWNER}  attester ${attester}  render agent ${agent}  drip ${drip}  fee ${FEE_BPS / 100}%`);
  console.log(`deployer balance ${usd(balance)}  nonce ${nonce}  |  base fee ${Number(baseFee) / 1e9} gwei, tip ${Number(f.maxPriorityFeePerGas) / 1e9} gwei, max fee ${Number(f.maxFeePerGas) / 1e9} gwei\n`);

  const rehearsed = await rehearse();
  const limits = rehearsed.map((g) => (g * LIMIT_MARGIN) / 100n);
  const expected = rehearsed.map((g) => g * price);
  const worst = limits.map((l) => l * f.maxFeePerGas);
  const value = DRIP_FUNDING;
  const totalExpected = expected.reduce((s, x) => s + x, 0n);
  const totalWorst = worst.reduce((s, x) => s + x, 0n);
  STEPS.forEach((s, i) =>
    console.log(`${String(i).padStart(1)} ${s.label.padEnd(30)} gas ${rehearsed[i].toString().padStart(9)}  limit ${limits[i].toString().padStart(9)}  expected ${usd(expected[i])}  worst ${usd(worst[i])}`),
  );
  console.log(`\ngas fees: expected ${usd(totalExpected)}, worst case ${usd(totalWorst)}; plus the 0.10 USDC sent to the drip`);
  console.log(`deployer keeps: expected ${usd(balance - value - totalExpected)}, worst case ${usd(balance - value - totalWorst)} (must be ≥ ${usd(RESERVE)})`);
  if (balance - value - totalWorst < RESERVE) {
    console.log(`SHORTFALL: ${usd(RESERVE - (balance - value - totalWorst))}. Nothing will be sent.`);
    process.exit(2);
  }
  if (PREFLIGHT) return;

  const wallet = createWalletClient({ chain: arcMainnet, transport: http(MAINNET_RPC), account: deployer });
  const a: Addrs = {};
  const done: { step: string; hash: Hex; block: number; gasUsed: string; feeUsdc: string; sendToReceiptMs: number; address?: Address }[] = [];
  for (const [i, s] of STEPS.entries()) {
    const tx = s.tx(a);
    const est = await pub.estimateGas({ account: OWNER, ...tx });
    if (est * 100n > rehearsed[i] * MAX_OVER_REHEARSAL) throw new Error(`${s.label}: live estimate ${est} is over 120% of the rehearsal ${rehearsed[i]}; stopping`);
    const gas = (est * LIMIT_MARGIN) / 100n;
    const t = performance.now();
    const hash = await wallet.sendTransaction({ ...tx, gas, ...(await fees(pub)) });
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    const ms = Math.round(performance.now() - t);
    const fee = r.gasUsed * r.effectiveGasPrice;
    console.log(`${i} ${s.label.padEnd(30)} ${r.status}  gas ${r.gasUsed}  ${usd(fee)}  ${ms} ms  ${r.contractAddress ?? ""}  ${arcMainnet.blockExplorers.default.url}/tx/${hash}`);
    if (r.status !== "success") throw new Error(`${s.label} failed; stopping`);
    if (s.save) a[s.save] = r.contractAddress!;
    done.push({ step: s.label, hash, block: Number(r.blockNumber), gasUsed: r.gasUsed.toString(), feeUsdc: formatEther(fee), sendToReceiptMs: ms, ...(r.contractAddress ? { address: r.contractAddress } : {}) });
    writeFileSync("../deployments/arc-mainnet.partial.json", JSON.stringify({ addresses: a, transactions: done }, null, 2) + "\n");
  }
  const out = {
    chainId: 5042,
    network: "Arc mainnet",
    deployedAt: new Date().toISOString(),
    startBlock: done.find((d) => d.step === "deploy CreatorRegistry")!.block,
    usdc: USDC,
    owner: OWNER,
    treasury: OWNER,
    attester,
    renderAgent: agent,
    gasTopUpWallet: drip,
    feeBps: FEE_BPS,
    CreatorRegistry: a.creators,
    LicenseRegistry: a.licences,
    ReceiptAnchor: a.receipts,
    LicenseEscrow: a.escrow,
    transactions: done,
  };
  writeFileSync("../deployments/arc-mainnet.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote deployments/arc-mainnet.json; deployer balance now ${usd(await pub.getBalance({ address: OWNER }))}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.split("\n")[0] : e);
  process.exit(1);
});
