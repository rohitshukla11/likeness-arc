/**
 * Contract addresses on Arc mainnet, from deployments/arc-mainnet.json. startBlock is
 * CreatorRegistry's creation block, for the history scanner. Null until the contracts are deployed.
 */
import type { Address } from "viem";

export const deployment: {
  chainId: 5042;
  startBlock: number | null;
  CreatorRegistry: Address | null;
  LicenseRegistry: Address | null;
  LicenseEscrow: Address | null;
  ReceiptAnchor: Address | null;
} = {
  chainId: 5042,
  startBlock: null,
  CreatorRegistry: null,
  LicenseRegistry: null,
  LicenseEscrow: null,
  ReceiptAnchor: null,
};

export function requireAddress(name: "CreatorRegistry" | "LicenseRegistry" | "LicenseEscrow" | "ReceiptAnchor"): Address {
  const a = deployment[name];
  if (!a) throw new Error(`${name} is not deployed yet`);
  return a;
}
