/**
 * Types and EIP-712 definitions shared by the browser and the server. Every struct mirrors the
 * contract field for field: LicenseRegistry.Request / APPROVAL_TYPEHASH, LicenseEscrow.RENDER_TYPEHASH.
 */
import { hexToString, keccak256, toHex, type Address, type Hex } from "viem";
import { parseDiditLiveness, type LivenessMethod } from "./verification";

export const STATUS = ["Unknown", "Active", "Revoked", "Expired", "Exhausted"] as const;
export type LicenceStatus = (typeof STATUS)[number];

export type Terms = {
  categories: number;
  regions: number;
  maxDuration: bigint; // seconds
  maxRenders: number;
  pricePerRender: bigint; // USDC, 6 decimals
  autoApprove: boolean;
};

export type LicenceRequest = {
  creator: Address;
  category: number;
  regions: number;
  duration: bigint;
  renderCap: number;
  pricePerRender: bigint;
  purposeHash: Hex;
  deadline: bigint;
  salt: Hex;
};

export type Licence = {
  id: bigint;
  creator: Address;
  licensee: Address;
  start: bigint;
  end: bigint;
  category: number;
  regions: number;
  renderCap: number;
  renderCount: number;
  creatorEpoch: bigint;
  revoked: boolean;
  pricePerRender: bigint;
  purposeHash: Hex;
  status: LicenceStatus;
};

export const approvalTypes = {
  Approval: [
    { name: "creator", type: "address" },
    { name: "licensee", type: "address" },
    { name: "category", type: "uint32" },
    { name: "regions", type: "uint32" },
    { name: "duration", type: "uint64" },
    { name: "renderCap", type: "uint32" },
    { name: "pricePerRender", type: "uint128" },
    { name: "purposeHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const renderTypes = {
  Render: [
    { name: "licenceId", type: "uint256" },
    { name: "assetHash", type: "bytes32" },
    { name: "renderIndex", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const approvalDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Likeness LicenseRegistry", version: "1", chainId, verifyingContract }) as const;

export const renderDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Likeness LicenseEscrow", version: "1", chainId, verifyingContract }) as const;

/** The typed data a creator signs to approve one exact request for one licensee. */
export function approvalTypedData(chainId: number, registry: Address, r: LicenceRequest, licensee: Address) {
  return {
    domain: approvalDomain(chainId, registry),
    types: approvalTypes,
    primaryType: "Approval" as const,
    message: { ...r, licensee },
  };
}

/** The brief behind a licence lives off chain; the chain holds keccak256 of its canonical JSON. */
export type PurposeBrief = { brand: string; campaign: string; use: string };
export function purposeHash(brief: PurposeBrief): Hex {
  return keccak256(toHex(JSON.stringify({ brand: brief.brand.trim(), campaign: brief.campaign.trim(), use: brief.use.trim() })));
}

export const declineMessage = (requestId: string) => `Likeness: decline licence request ${requestId}`;

/** Does a request fit a creator's published terms well enough to auto-approve? Same rule as the contract. */
export function fitsTerms(t: Terms, r: Pick<LicenceRequest, "category" | "regions" | "duration" | "renderCap" | "pricePerRender">): string | null {
  if (!t.autoApprove) return "this creator approves each licence personally";
  if ((r.category & t.categories) !== r.category) return "category not in the creator's terms";
  if ((r.regions & t.regions) !== r.regions) return "regions outside the creator's terms";
  if (r.duration > t.maxDuration) return "longer than the creator's maximum";
  if (r.renderCap > t.maxRenders) return "more renders than the creator's maximum";
  if (r.pricePerRender < t.pricePerRender) return "below the creator's price";
  return null;
}

// ---------------------------------------------------------------- attestation trust labels

/** Attestation provider names written on chain (bytes32). Didit runs ID, liveness and face match. */
export const PROVIDERS = {
  didit: "didit",
  diditSandbox: "didit-sandbox",
  devUnverified: "dev-unverified",
} as const;

export type Trust =
  | { level: "verified"; liveness: string; age: string; sandbox: boolean; livenessMethod: LivenessMethod }
  | { level: "unverified-test"; liveness: string; age: string }
  | { level: "unknown"; liveness: string; age: string };

export function providerName(b: Hex): string {
  return hexToString(b, { size: 32 }).replace(/\0+$/, "");
}

/**
 * How much an attestation proves. Only a Didit verification (ID document with an 18+ date of birth,
 * liveness, and selfie-to-ID face match) is "verified", with the liveness method that ran (active or
 * passive, from livenessProvider "didit:<method>") and labelled sandbox when it ran on a sandbox key.
 * The dev seed's "dev-unverified" creator is labelled an unverified test creator everywhere.
 */
export function trustOf(livenessProvider: Hex, ageProvider: Hex): Trust {
  const liveness = providerName(livenessProvider);
  const age = providerName(ageProvider);
  if (liveness === PROVIDERS.devUnverified || age === PROVIDERS.devUnverified) return { level: "unverified-test", liveness, age };
  const didit = [PROVIDERS.didit, PROVIDERS.diditSandbox] as string[];
  const live = parseDiditLiveness(liveness);
  if (live && didit.includes(age)) return { level: "verified", liveness, age, sandbox: live.sandbox || age === PROVIDERS.diditSandbox, livenessMethod: live.method };
  return { level: "unknown", liveness, age };
}

export const usdc = {
  format(units: bigint): string {
    const whole = units / 1_000_000n;
    const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}` : `${whole}.00`;
  },
  parse(text: string): bigint {
    const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(text.trim());
    if (!m) throw new Error("not a USDC amount");
    return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  },
};

export function formatDuration(seconds: bigint | number): string {
  const s = Number(seconds);
  if (s % 86_400 === 0) return `${s / 86_400} day${s === 86_400 ? "" : "s"}`;
  if (s % 3_600 === 0) return `${s / 3_600} h`;
  return `${s} s`;
}

/**
 * This mainnet deployment keeps amounts small: at most 2 USDC in total may be deposited into escrow for
 * one licence. The app enforces it (the contract itself has no cap; see the README).
 */
export const MAX_DEPOSIT_PER_LICENCE = 2_000_000n; // 2 USDC, 6 decimals

/** Why a deposit is refused, or null when `amount` fits under the cap given what was already deposited. */
export function checkDeposit(alreadyDeposited: bigint, amount: bigint): string | null {
  if (amount <= 0n) return "enter an amount above zero";
  const room = alreadyDeposited >= MAX_DEPOSIT_PER_LICENCE ? 0n : MAX_DEPOSIT_PER_LICENCE - alreadyDeposited;
  if (amount > room) return `deposits are capped at ${usdc.format(MAX_DEPOSIT_PER_LICENCE)} USDC per licence on this deployment (${usdc.format(room)} USDC left)`;
  return null;
}

/** The suggested deposit: what the remaining renders cost, capped by the room left under the per-licence cap. */
export function suggestedDeposit(pricePerRender: bigint, rendersLeft: number, alreadyDeposited: bigint): bigint {
  const need = pricePerRender * BigInt(Math.max(0, rendersLeft));
  const room = alreadyDeposited >= MAX_DEPOSIT_PER_LICENCE ? 0n : MAX_DEPOSIT_PER_LICENCE - alreadyDeposited;
  return need < room ? need : room;
}
