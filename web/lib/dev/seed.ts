/**
 * DEV ONLY: the unverified test creator. Registers a creator whose attestation names the provider
 * "dev-unverified" for both liveness and age, so every reader (marketplace, dashboards, verifier)
 * labels it an unverified test creator. Its "reference photos" are synthetic placeholder drawings,
 * not a person. It exists so licensing, rendering, receipts and revocation can be tested end to end
 * before the liveness and ID-check credentials arrive. Never use it in the demo.
 *
 * Runs outside Next (scripts, tests), so it imports nothing server-only.
 */
import sharp from "sharp";
import { keccak256, stringToHex, toHex, type Address, type Hex, type PublicClient, type WalletClient, type Account, type Chain, type Transport } from "viem";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { signAttestation, type Attestation } from "@/lib/attestation";
import { devNamespaceKey } from "@/lib/crypto/devkeys";
import { referenceSetHash, sealReferenceSet, type ReferenceSet } from "@/lib/crypto/envelope";
import { vaultId } from "@/lib/crypto/vault";
import { PROVIDERS, type Terms } from "@/lib/licensing";

const POSES = [
  { label: "front", fill: "#56a7e0", dx: 0 },
  { label: "left", fill: "#8fe3b7", dx: -40 },
  { label: "right", fill: "#f5e663", dx: 40 },
];

/** Three synthetic "reference photos": a flat drawn figure per pose, clearly labelled as not a person. */
export async function syntheticPortraits(): Promise<Uint8Array[]> {
  return Promise.all(
    POSES.map(async (p) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
        <rect width="512" height="512" fill="#232328"/>
        <circle cx="${256 + p.dx}" cy="200" r="92" fill="${p.fill}"/>
        <rect x="${136 + p.dx}" y="310" width="240" height="220" rx="110" fill="${p.fill}"/>
        <text x="256" y="44" font-family="Helvetica, Arial" font-size="24" font-weight="700" fill="#f3f3f5" text-anchor="middle">SYNTHETIC</text>
        <text x="256" y="76" font-family="Helvetica, Arial" font-size="18" fill="#c2c2c8" text-anchor="middle">not a person · ${p.label}</text>
      </svg>`;
      return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer());
    }),
  );
}

/** "dev-unverified" for the local test creator; "demo-scripted" for the scripted Arc mainnet demo creator. */
export type SeedProvider = typeof PROVIDERS.devUnverified | typeof PROVIDERS.demoScripted;

export function devAttestation(refHash: Hex, provider: SeedProvider = PROVIDERS.devUnverified): Attestation {
  return {
    referenceSetHash: refHash,
    livenessSessionHash: keccak256(toHex(`${provider}:${Date.now()}:${Math.random()}`)),
    livenessProvider: stringToHex(provider, { size: 32 }),
    ageProvider: stringToHex(provider, { size: 32 }),
    verifiedAt: BigInt(Math.floor(Date.now() / 1000)),
    // CreatorRegistry only registers adults; the provider name, not this flag, carries the truth here.
    adult: true,
  };
}

/**
 * Seal a reference set under the dev secret's reference key (the same envelope code as a passkey
 * creator). Defaults to the placeholder drawings; the scripted demo passes its synthetic face photos.
 * Returns the set and its vault key.
 */
export async function sealDevReferenceSet(
  creator: Address,
  devSecret: string,
  images?: Uint8Array[],
): Promise<{ set: ReferenceSet; vaultKey: string; hash: Hex }> {
  const key = await devNamespaceKey(devSecret, { kind: "reference" });
  const captures = images ? images.map((i) => new Uint8Array(i)) : await syntheticPortraits();
  const set = await sealReferenceSet(key.kek, creator, captures);
  captures.forEach((c) => c.fill(0));
  const hash = await referenceSetHash(set);
  return { set, hash, vaultKey: vaultId(key.credentialId, `reference-set:${hash}`) };
}

export async function registerDevCreator(opts: {
  pub: PublicClient;
  creator: WalletClient<Transport, Chain, Account>;
  attesterKey: Hex;
  registry: Address;
  refHash: Hex;
  terms: Terms;
  provider?: SeedProvider;
  /** Fee overrides (Arc: at least 20 gwei). */
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}): Promise<Hex> {
  const { pub, creator, registry } = opts;
  const who = creator.account.address;
  const attestation = devAttestation(opts.refHash, opts.provider);
  const nonce = await pub.readContract({ address: registry, abi: CreatorRegistryAbi, functionName: "attestationNonce", args: [who] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const sig = await signAttestation(opts.attesterKey, registry, await pub.getChainId(), who, attestation, nonce, deadline);
  const args = [who, attestation, deadline, sig, opts.terms] as const;
  const gas = await pub.estimateContractGas({ account: who, address: registry, abi: CreatorRegistryAbi, functionName: "register", args });
  const hash = await creator.writeContract({ address: registry, abi: CreatorRegistryAbi, functionName: "register", args, gas: (gas * 115n) / 100n, ...(opts.fees ?? {}) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`register reverted: ${hash}`);
  return hash;
}
