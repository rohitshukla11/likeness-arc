/**
 * Arc mainnet, from https://docs.arc.io/arc/references/rpc-endpoints.md and
 * https://docs.arc.io/arc/references/contract-addresses.md.
 *
 * USDC is Arc's native gas token. It has two interfaces over one balance: native value with 18
 * decimals (gas, and the gas top-up) and the ERC-20 interface at 0x3600…0000 with 6 decimals (every
 * licence price, deposit and payout). The two are never mixed.
 */
import { defineChain, type Address } from "viem";

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
  contracts: {
    // Listed on the contract addresses page above.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/** Circle USDC's ERC-20 interface on Arc, 6 decimals (the contract addresses page above). */
export const USDC: Address = "0x3600000000000000000000000000000000000000";

/** Arc's mempool drops transactions whose maxFeePerGas is under 20 gwei (docs: gas and fees). */
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n;

export const explorer = {
  tx: (hash: string) => `${arcMainnet.blockExplorers.default.url}/tx/${hash}`,
  address: (a: string) => `${arcMainnet.blockExplorers.default.url}/address/${a}`,
};
