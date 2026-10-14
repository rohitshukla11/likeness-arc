import "server-only";
/**
 * One-time gas top-up in native USDC to a new embedded wallet, so creators and brands can pay gas on
 * Arc mainnet. USDC is Arc's gas token; native value has 18 decimals (docs.arc.io, EVM differences), so
 * the amount is parsed with 18 decimals. Default 0.05 USDC: about 10 of this app's transactions at the
 * 20 gwei base fee (register and payRender use roughly 300k gas, about 0.006 USDC each).
 *
 * Limits:
 *  - per address: once. Only a wallet with a zero balance and nonce 0 qualifies, so the chain itself is
 *    the ledger and the cap survives restarts and multiple instances;
 *  - per IP: DRIP_PER_IP_PER_HOUR (default 2), and per instance: DRIP_PER_HOUR (default 10), in memory;
 *  - the drip wallet holds only a small float, which is the hard cap;
 *  - every top-up and refusal is logged as one JSON line (Vercel function logs).
 */
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, isAddress, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcMainnet, MIN_MAX_FEE_PER_GAS } from "@/lib/chain";
import { loadKey } from "./keys";

const HOUR = 3_600_000;
const perIpLimit = Number(process.env.DRIP_PER_IP_PER_HOUR ?? 2);
const globalLimit = Number(process.env.DRIP_PER_HOUR ?? 10);
/** Native USDC, 18 decimals. */
export const DRIP_AMOUNT = parseEther(process.env.DRIP_AMOUNT_USDC ?? "0.05");
const amount = DRIP_AMOUNT;

const byIp = new Map<string, number[]>();
let global: number[] = [];
const inFlight = new Set<string>();

export type DripResult = { status: number; body: Record<string, unknown> };

function log(event: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "drip", ...event }));
}

function recent(times: number[], now: number) {
  return times.filter((t) => now - t < HOUR);
}


export async function drip(addressInput: string, ip: string): Promise<DripResult> {
  const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 12);
  const key = loadKey("DRIP_KEY_FILE", "DRIP_PRIVATE_KEY");
  if (!key) return { status: 503, body: { error: "drip is not configured" } };
  if (!isAddress(addressInput)) return { status: 400, body: { error: "bad address" } };
  const address = addressInput.toLowerCase() as Address;

  const now = Date.now();
  const ipTimes = recent(byIp.get(ipHash) ?? [], now);
  global = recent(global, now);
  if (ipTimes.length >= perIpLimit || global.length >= globalLimit) {
    log({ result: "rate-limited", address, ipHash });
    return { status: 429, body: { error: "rate limited, try later" } };
  }
  if (inFlight.has(address)) return { status: 409, body: { error: "already in progress" } };

  const transport = http(arcMainnet.rpcUrls.default.http[0]);
  const pub = createPublicClient({ chain: arcMainnet, transport });
  inFlight.add(address);
  try {
    const [balance, nonce] = await Promise.all([pub.getBalance({ address }), pub.getTransactionCount({ address })]);
    if (balance > 0n || nonce > 0) {
      log({ result: "refused-not-new", address, ipHash });
      return { status: 409, body: { error: "only new, empty wallets get a gas top-up" } };
    }
    const wallet = createWalletClient({ chain: arcMainnet, transport, account: privateKeyToAccount(key) });
    // Arc drops transactions with maxFeePerGas under 20 gwei, so the fee never goes below that floor.
    const fees = await pub.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? fees.maxFeePerGas : MIN_MAX_FEE_PER_GAS;
    const hash = await wallet.sendTransaction({ to: address, value: amount, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    ipTimes.push(now);
    byIp.set(ipHash, ipTimes);
    global.push(now);
    log({ result: "sent", address, ipHash, amount: amount.toString(), hash });
    return { status: 200, body: { hash, amount: amount.toString() } };
  } catch (e) {
    log({ result: "error", address, ipHash, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { status: 502, body: { error: "gas top-up failed" } };
  } finally {
    inFlight.delete(address);
  }
}
