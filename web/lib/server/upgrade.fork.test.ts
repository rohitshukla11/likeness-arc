/**
 * Re-verification at a higher level on an arc-anvil fork of Arc mainnet: a creator registered with
 * passive liveness (didit:passive) is upgraded to active liveness with CreatorRegistry.updateAttestation;
 * a same-level or lower re-attestation is refused, and a second registration is refused.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEther, stringToHex, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { signAttestation } from "@/lib/attestation";
import { CONSENT_VERSION } from "@/lib/consent";
import { deployment } from "@/lib/deployment";
import { hasAnvil, startFork, takeOverRoles, wallet, type Fork } from "@/lib/dev/fork";
import { sealDevReferenceSet } from "@/lib/dev/seed";
import type { ReferenceSet } from "@/lib/crypto/envelope";

// Needs arc-anvil and the deployed contracts (lib/deployment.ts).
const run = hasAnvil() && process.env.SKIP_FORK_TESTS !== "1" && !!deployment.CreatorRegistry;

describe.skipIf(!run)("re-verify at a higher level", () => {
  let fork: Fork;
  const attesterKey = generatePrivateKey();
  const creatorKey = generatePrivateKey();
  const creator = privateKeyToAccount(creatorKey).address.toLowerCase() as Address;
  let set: ReferenceSet;

  beforeAll(async () => {
    fork = await startFork(8551);
    const tmp = mkdtempSync(path.join(tmpdir(), "likeness-upgrade-"));
    const keyFile = path.join(tmp, "attester.key");
    (await import("node:fs")).writeFileSync(keyFile, attesterKey);
    Object.assign(process.env, {
      ARC_RPC_URL: fork.url,
      DB_DIR: path.join(tmp, "db"),
      INDEX_CACHE_DIR: tmp,
      INDEX_START_BLOCK: String(fork.forkBlock + 1n),
      ATTESTER_KEY_FILE: keyFile,
      VERIFICATION_LEVEL: "full",
    });
    delete process.env.DIDIT_API_KEY; // the post-attestation Didit erase is best effort; no network here
    await takeOverRoles(fork, { attester: privateKeyToAccount(attesterKey).address, agent: privateKeyToAccount(generatePrivateKey()).address });
    await fork.test.setBalance({ address: creator, value: parseEther("5") });

    // Registered at the free level: didit:passive.
    set = (await sealDevReferenceSet(creator, toHex(crypto.getRandomValues(new Uint8Array(32))))).set;
    const { referenceSetHash } = await import("@/lib/crypto/envelope");
    const a = {
      referenceSetHash: await referenceSetHash(set),
      livenessSessionHash: toHex(crypto.getRandomValues(new Uint8Array(32))),
      livenessProvider: stringToHex("didit:passive", { size: 32 }),
      ageProvider: stringToHex("didit", { size: 32 }),
      verifiedAt: BigInt(Math.floor(Date.now() / 1000)),
      adult: true,
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const sig = await signAttestation(attesterKey, deployment.CreatorRegistry!, 5042, creator, a, 0n, deadline);
    const terms = { categories: 1 << 8, regions: 1, maxDuration: 86_400n, maxRenders: 5, pricePerRender: 1_000_000n, autoApprove: true };
    const hash = await wallet(fork, creatorKey).writeContract({ address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "register", args: [creator, a, deadline, sig, terms] } as never);
    await fork.pub.waitForTransactionReceipt({ hash });
  }, 120_000);
  afterAll(() => fork?.stop());

  /** What the Didit and photo-match steps leave behind, at a given liveness. */
  async function verifiedAs(method: "PASSIVE" | "ACTIVE_3D", level: "free" | "full") {
    const { dbPut } = await import("./db");
    await dbPut("consents", creator, { address: creator, version: CONSENT_VERSION, textSha256: "x", message: "x", signature: "x", at: Date.now() });
    const sessionId = `s-${method}-${Math.random()}`;
    await dbPut("identity", creator, {
      address: creator, sessionId, level, environment: "live", state: "approved", sessionStatus: "Approved", reasons: [], createdAt: Date.now(), decidedAt: Date.now(),
      checks: { adult: true, livenessMethod: method },
    });
    await dbPut("captures-passed", creator, { address: creator, sessionId, digests: set.digests, scores: [90, 90, 90], matcher: "didit", at: Date.now() });
  }

  it("refuses a second registration and a same-level re-attestation", async () => {
    const { attest } = await import("./attest");
    process.env.VERIFICATION_LEVEL = "free";
    await verifiedAs("PASSIVE", "free");
    await expect(attest(creator, set, "register")).rejects.toThrow(/already registered/);
    await verifiedAs("PASSIVE", "free");
    await expect(attest(creator, set, "upgrade")).rejects.toThrow(/not an upgrade/);
    process.env.VERIFICATION_LEVEL = "full";
  });

  it("upgrades passive to active with updateAttestation, and shows when", async () => {
    const { attest } = await import("./attest");
    await verifiedAs("ACTIVE_3D", "full");
    const a = await attest(creator, set, "upgrade");
    expect(a.liveness).toBe("didit:active");
    const hash = await wallet(fork, creatorKey).writeContract({
      address: deployment.CreatorRegistry!,
      abi: CreatorRegistryAbi,
      functionName: "updateAttestation",
      args: [{ ...(a.attestation as never as object), verifiedAt: BigInt(a.attestation.verifiedAt) } as never, BigInt(a.deadline), a.signature as Hex],
    } as never);
    expect((await fork.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    const { readCreatorWithHistory } = await import("./protocol");
    const c = (await readCreatorWithHistory(creator))!;
    expect(c.trust).toMatchObject({ level: "verified", livenessMethod: "active" });
    expect(c.upgradedAt).toBeGreaterThan(0);
    expect(c.upgradedTx).toBe(hash);
  });

  it("then refuses going back down to passive", async () => {
    const { attest } = await import("./attest");
    process.env.VERIFICATION_LEVEL = "free";
    await verifiedAs("PASSIVE", "free");
    await expect(attest(creator, set, "upgrade")).rejects.toThrow(/not an upgrade/);
    process.env.VERIFICATION_LEVEL = "full";
  });
});
