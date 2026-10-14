/**
 * Contract addresses on Arc mainnet, from deployments/arc-mainnet.json (deployed 2026-10-14 UTC).
 * startBlock is CreatorRegistry's creation block, for the history scanner.
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
  startBlock: 25968293,
  CreatorRegistry: "0x87934d5E1A61be3Bb06FE54AC7e21E7704731d1C",
  LicenseRegistry: "0xE33Dc788C060cb77F79A2AFF96Ca685f6C018721",
  LicenseEscrow: "0x8a747D78811066F58A0dDe04E82165A02fA37725",
  ReceiptAnchor: "0x38703a57c5f8eB2F8d1576A3d2B4B35A10D66FA6",
};

export function requireAddress(name: "CreatorRegistry" | "LicenseRegistry" | "LicenseEscrow" | "ReceiptAnchor"): Address {
  const a = deployment[name];
  if (!a) throw new Error(`${name} is not deployed yet`);
  return a;
}
