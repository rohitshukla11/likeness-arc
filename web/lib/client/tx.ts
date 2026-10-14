"use client";
/**
 * Browser-side contract writes. Every write estimates gas first and adds
 * 15%. Each returns the hash and how long the receipt took, which the UI shows next to the explorer link.
 */
import { createPublicClient, http, type Abi, type ContractFunctionArgs, type ContractFunctionName, type Hex, type TransactionReceipt } from "viem";
import { arcMainnet, MIN_MAX_FEE_PER_GAS } from "@/lib/chain";
import type { ActiveWallet } from "@/components/wallet/WalletProvider";

export const browserPub = createPublicClient({ chain: arcMainnet, batch: { multicall: { wait: 16 } }, transport: http(undefined, { retryCount: 5, retryDelay: 400 }) });

export async function write<const abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">>(
  wallet: ActiveWallet,
  call: { address: `0x${string}`; abi: abi; functionName: fn; args: ContractFunctionArgs<abi, "nonpayable" | "payable", fn> },
): Promise<{ hash: Hex; ms: number; receipt: TransactionReceipt }> {
  const params = { account: wallet.address, ...call } as never;
  const [gas, fees] = await Promise.all([browserPub.estimateContractGas(params), browserPub.estimateFeesPerGas()]);
  // Arc's mempool silently drops transactions with maxFeePerGas under 20 gwei.
  const maxFeePerGas = fees.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? fees.maxFeePerGas : MIN_MAX_FEE_PER_GAS;
  const hash = await wallet.client.writeContract({
    ...(call as object),
    chain: arcMainnet,
    account: wallet.client.account,
    gas: (gas * 115n) / 100n,
    maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  } as never);
  const t = performance.now();
  const receipt = await browserPub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  const ms = Math.round(performance.now() - t);
  // Timing log for the operator (server log only; hashes are public anyway).
  void fetch("/api/txlog", { method: "POST", body: JSON.stringify({ hash, fn: String(call.functionName), from: wallet.address, ms, gasUsed: receipt.gasUsed.toString() }) }).catch(() => {});
  return { hash, ms, receipt };
}

/** Pull a contract's custom error name out of a viem error, for a readable message. */
export function reason(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  const text = `${err.shortMessage ?? ""} ${err.message ?? ""}`;
  if (/limited to \d+\/sec|429|rate limit/i.test(text)) return "The Arc RPC is busy (rate limited). Wait a moment and try again.";
  // Dynamic's wallet service refused to sign for this browser session (e.g. stale state after a sign-out).
  if (/WalletApiError: Forbidden|Error signing message[\s\S]*Forbidden/i.test(text))
    return "Your wallet couldn't sign in this browser session. Sign out, reload the page and sign in again; if it repeats, clear this site's data in the browser and sign in once more.";
  const name = err.cause?.data?.errorName;
  return name ? `${name}${err.shortMessage ? ` (${err.shortMessage})` : ""}` : (err.shortMessage ?? err.message ?? String(e));
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${url} ${r.status}`);
  return j as T;
}
