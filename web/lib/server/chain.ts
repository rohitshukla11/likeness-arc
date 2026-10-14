import "server-only";
/**
 * Server-side chain access. The RPC is read at call time, so a test or the local demo can point the
 * whole server at an arc-anvil fork of Arc mainnet (ARC_RPC_URL) without touching the browser config.
 */
import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { arcMainnet } from "@/lib/chain";

export function rpcUrl(): string {
  return process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.mainnet.arc.io";
}

/** True when the server is pointed at a local fork rather than Arc mainnet. */
export function isLocalFork(): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl());
}

export function serverChain() {
  return defineChain({ ...arcMainnet, rpcUrls: { default: { http: [rpcUrl()] } } });
}

const clients = new Map<string, PublicClient>();
export function pub(): PublicClient {
  const url = rpcUrl();
  let c = clients.get(url);
  if (!c) {
    // Contract reads issued together go out as one Multicall3 call, and retries back off. Arc's public
    // endpoint is load-balanced, and a backend slightly behind the head answers -32014; a retry fixes it.
    c = createPublicClient({
      chain: serverChain(),
      batch: { multicall: { wait: 16 } },
      transport: http(url, { retryCount: 5, retryDelay: 400 }),
    }) as PublicClient;
    clients.set(url, c);
  }
  return c;
}

/** Gas estimate plus a small margin, so a transaction doesn't run out if state moves before it lands. */
export const withMargin = (gas: bigint) => (gas * 115n) / 100n;

/**
 * Process-wide singletons. Next's dev server can load a module once per route bundle, so state that
 * must be shared across routes (in-memory keys, caches) hangs off globalThis.
 */
export function singleton<T>(name: string, make: () => T): T {
  const g = globalThis as unknown as Record<string, T>;
  const key = `__likeness_${name}`;
  if (!(key in g)) g[key] = make();
  return g[key];
}
