/**
 * The whole licence lifecycle on an arc-anvil fork of Arc mainnet: the deployed contracts, Circle's real
 * USDC contract, and the app's own server modules (no mocks). Skipped without anvil or with
 * SKIP_FORK_TESTS=1; needs network access to fork the public RPC.
 *
 *   creator registers (dev-unverified) → sets terms → brand files a request → creator signs the
 *   EIP-712 approval → brand issues it on chain → deposits USDC → creator releases the reference
 *   key to the per-licence service key → delegated payRender (policy guard) pays the creator and
 *   anchors the receipt → creator revokes → keys dropped, renders refused → brand refunds.
 */
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeFunctionData, erc20Abi, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { LicenseRegistryAbi } from "@/lib/abi/LicenseRegistry";
import { USDC } from "@/lib/chain";
import { b64u } from "@/lib/crypto/encoding";
import { devNamespaceKey } from "@/lib/crypto/devkeys";
import { unwrapDek } from "@/lib/crypto/envelope";
import { releaseToService } from "@/lib/crypto/release";
import { deployment } from "@/lib/deployment";
import { dealUsdc, hasAnvil, startFork, takeOverRoles, wallet, type Fork } from "@/lib/dev/fork";
import { registerDevCreator, sealDevReferenceSet, syntheticPortraits } from "@/lib/dev/seed";
import { approvalTypedData, type Terms } from "@/lib/licensing";

// Needs arc-anvil and the deployed contracts (lib/deployment.ts).
const run = hasAnvil() && process.env.SKIP_FORK_TESTS !== "1" && !!deployment.CreatorRegistry;
const PRICE = 1_500_000n; // 1.5 USDC

describe.skipIf(!run)("licence lifecycle on an Arc mainnet fork", () => {
  let fork: Fork;
  const keys = { attester: generatePrivateKey(), agent: generatePrivateKey(), creator: generatePrivateKey(), brand: generatePrivateKey() };
  const addr = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v).address.toLowerCase()])) as Record<keyof typeof keys, Address>;
  const devSecret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  let tmp: string;
  let vaultKey: string;
  let refHash: Hex;
  let licenceId: bigint;
  let rendered: { bytes: Uint8Array; mime: string } | undefined;

  beforeAll(async () => {
    fork = await startFork(8549);
    tmp = mkdtempSync(path.join(tmpdir(), "likeness-fork-"));
    mkdirSync(path.join(tmp, "dev"));
    writeFileSync(path.join(tmp, "agent.key"), keys.agent);
    writeFileSync(path.join(tmp, "dev", `${addr.brand}.key`), keys.brand);
    Object.assign(process.env, {
      ARC_RPC_URL: fork.url,
      STORE_DIR: path.join(tmp, "vault"),
      DB_DIR: path.join(tmp, "db"),
      INDEX_CACHE_DIR: tmp,
      INDEX_START_BLOCK: String(fork.forkBlock + 1n),
      RENDER_AGENT_KEY_FILE: path.join(tmp, "agent.key"),
      RENDERS_DIR: path.join(tmp, "renders"),
      DEV_DELEGATION: "1",
      DEV_KEYS_DIR: path.join(tmp, "dev"),
    });
    await takeOverRoles(fork, { attester: addr.attester, agent: addr.agent });
    for (const a of [addr.creator, addr.brand]) await fork.test.setBalance({ address: a, value: parseEther("10") });
    await dealUsdc(fork, addr.brand, 100_000_000n);
    // No model or LLM keys in this test: the DevRenderer and the local rules run.
    delete process.env.GEMINI_API_KEY;
  }, 120_000);
  afterAll(() => fork?.stop());

  const write = async (key: Hex, call: Parameters<ReturnType<typeof wallet>["writeContract"]>[0]) => {
    const hash = await wallet(fork, key).writeContract(call);
    const r = await fork.pub.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success");
    return r;
  };

  it("registers the dev-unverified creator and labels it unverified", async () => {
    const { putCiphertext } = await import("./store");
    const sealed = await sealDevReferenceSet(addr.creator, devSecret);
    await putCiphertext(sealed.vaultKey, JSON.stringify(sealed.set));
    vaultKey = sealed.vaultKey;
    refHash = sealed.hash;
    const terms: Terms = { categories: (1 << 8) | (1 << 9), regions: 0x3f, maxDuration: 30n * 86_400n, maxRenders: 10, pricePerRender: PRICE, autoApprove: false };
    await registerDevCreator({ pub: fork.pub as never, creator: wallet(fork, keys.creator) as never, attesterKey: keys.attester, registry: deployment.CreatorRegistry!, refHash, terms });

    const { readCreator, listCreators } = await import("./protocol");
    const c = await readCreator(addr.creator);
    expect(c?.trust.level).toBe("unverified-test");
    expect(c?.referenceSetHash).toBe(refHash);
    expect((await listCreators()).map((x) => x.address)).toContain(addr.creator);
  });

  it("refuses an auto-approved request while autoApprove is off, then issues against the creator's EIP-712 approval", async () => {
    const { fileRequest, decide, toRequest } = await import("./requests");
    const stored = await fileRequest({
      licensee: addr.brand,
      creator: addr.creator,
      category: 1 << 8,
      regions: 1,
      durationDays: 7,
      renderCap: 6,
      pricePerRender: PRICE.toString(),
      brief: { brand: "Acme", campaign: "Spring", use: "Two social posts" },
    });
    const req = toRequest(stored.request);
    await expect(
      fork.pub.simulateContract({ account: addr.brand, address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "request", args: [req, "0x"] }),
    ).rejects.toThrow(/OutsideTerms/);

    // A signature from anyone but the creator is refused by the relay.
    const forged = await privateKeyToAccount(keys.brand).signTypedData(approvalTypedData(deployment.chainId, deployment.LicenseRegistry!, req, addr.brand));
    await expect(decide(stored.id, { approve: true, signature: forged })).rejects.toThrow(/not signed by the creator/);

    const signature = await privateKeyToAccount(keys.creator).signTypedData(approvalTypedData(deployment.chainId, deployment.LicenseRegistry!, req, addr.brand));
    expect((await decide(stored.id, { approve: true, signature })).state).toBe("approved");
    const r = await write(keys.brand, { address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "request", args: [req, signature] } as never);
    const { parseEventLogs } = await import("viem");
    licenceId = parseEventLogs({ abi: LicenseRegistryAbi, logs: r.logs, eventName: "LicenceIssued" })[0].args.id;

    const { readLicence } = await import("./protocol");
    const l = await readLicence(licenceId);
    expect(l?.status).toBe("Active");
    expect(l?.licensee).toBe(addr.brand);
    // Replaying the same approval fails on chain.
    await expect(
      fork.pub.simulateContract({ account: addr.brand, address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "request", args: [req, signature] }),
    ).rejects.toThrow(/ApprovalReused/);
  });

  it("deposits real-contract USDC into escrow", async () => {
    await write(keys.brand, { address: USDC, abi: erc20Abi, functionName: "approve", args: [deployment.LicenseEscrow!, 5n * PRICE] } as never);
    await write(keys.brand, { address: deployment.LicenseEscrow!, abi: LicenseEscrowAbi, functionName: "deposit", args: [licenceId, 5n * PRICE] } as never);
    const { readEscrow } = await import("./protocol");
    expect((await readEscrow(licenceId)).balance).toBe(5n * PRICE);
  });

  it("releases the reference key to this licence's ephemeral service key only", async () => {
    const { serviceKey, acceptLicenceRelease, referenceImages } = await import("./keyring");
    const { getCiphertext } = await import("./store");
    await expect(referenceImages(licenceId)).rejects.toThrow(/not released/);

    const { publicKey } = await serviceKey(licenceId);
    const ref = await devNamespaceKey(devSecret, { kind: "reference" });
    const dek = await unwrapDek(ref.kek, JSON.parse((await getCiphertext(vaultKey))!));
    const release = await releaseToService(dek, b64u.decode(publicKey), licenceId);

    // Bound to the licence id: the same release cannot be replayed for another licence.
    await expect(acceptLicenceRelease(licenceId, { ...release, licenceId: "999" }, vaultKey)).rejects.toThrow(/another licence/);
    // A release made under the wrong data key does not open the attested set.
    const bogus = await releaseToService(new Uint8Array(32), b64u.decode(publicKey), licenceId);
    await expect(acceptLicenceRelease(licenceId, bogus, vaultKey)).rejects.toThrow(/does not open/);

    await acceptLicenceRelease(licenceId, release, vaultKey);
    dek.fill(0);
    const images = await referenceImages(licenceId);
    const expected = await syntheticPortraits();
    expect(images.map((i) => keccak256(i))).toEqual(expected.map((i) => keccak256(i)));
    images.forEach((i) => i.fill(0));
  });

  it("pays a render through dev delegation, and the policy guard refuses everything else", async () => {
    const { checkPolicy, saveGrant, sendDelegatedPayRender, PolicyError } = await import("./delegation");
    const { renderAgent } = await import("./agent");
    await saveGrant({ licensee: addr.brand, provider: "dev-local", capUsdc: (2n * PRICE).toString(), spentUsdc: "0", createdAt: Date.now() });
    const grant = { licensee: addr.brand, provider: "dev-local" as const, capUsdc: (2n * PRICE).toString(), spentUsdc: "0", createdAt: 0 };
    const escrow = deployment.LicenseEscrow!;
    const depositData = encodeFunctionData({ abi: LicenseEscrowAbi, functionName: "deposit", args: [licenceId, 1n] });
    const payData = encodeFunctionData({ abi: LicenseEscrowAbi, functionName: "payRender", args: [licenceId, keccak256("0x01"), addr.agent, 1n, "0x"] });
    await expect(checkPolicy({ to: escrow, data: depositData, value: 0n, chainId: 5042 }, grant)).rejects.toThrow(/not payRender/);
    await expect(checkPolicy({ to: USDC, data: payData, value: 0n, chainId: 5042 }, grant)).rejects.toThrow(/not the Likeness escrow/);
    await expect(checkPolicy({ to: escrow, data: payData, value: 0n, chainId: 1 }, grant)).rejects.toThrow(/chain 1/);
    await expect(checkPolicy({ to: escrow, data: payData, value: 1n, chainId: 5042 }, grant)).rejects.toThrow(/value/);
    await expect(checkPolicy({ to: escrow, data: payData, value: 0n, chainId: 5042 }, { ...grant, spentUsdc: (PRICE + 1n).toString() })).rejects.toBeInstanceOf(PolicyError);
    expect(await checkPolicy({ to: escrow, data: payData, value: 0n, chainId: 5042 }, grant)).toBe(PRICE);

    const agent = await renderAgent();
    expect(agent.address.toLowerCase()).toBe(addr.agent);
    const payoutBefore = await fork.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr.creator] });
    const assetHash = keccak256(toHex("fork-render-1"));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const agentSig = await agent.signRender({ licenceId, assetHash, renderIndex: 0, deadline });
    const sent = await sendDelegatedPayRender(addr.brand, { licenceId, assetHash, agent: agent.address, deadline, agentSig });
    expect(sent.gasUsed).toBeGreaterThan(0n);

    const fee = (PRICE * 1000n) / 10_000n;
    const payoutAfter = await fork.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr.creator] });
    expect(payoutAfter - payoutBefore).toBe(PRICE - fee);
    const { readReceipt, readLicence } = await import("./protocol");
    expect((await readReceipt(assetHash))?.licenceId).toBe(licenceId);
    expect((await readLicence(licenceId))?.renderCount).toBe(1);

    // Cap: 2 renders' worth; the second fits, a third would not.
    const h2 = keccak256(toHex("fork-render-2"));
    await sendDelegatedPayRender(addr.brand, { licenceId, assetHash: h2, agent: agent.address, deadline, agentSig: await agent.signRender({ licenceId, assetHash: h2, renderIndex: 1, deadline }) });
    const h3 = keccak256(toHex("fork-render-3"));
    await expect(
      sendDelegatedPayRender(addr.brand, { licenceId, assetHash: h3, agent: agent.address, deadline, agentSig: await agent.signRender({ licenceId, assetHash: h3, renderIndex: 2, deadline }) }),
    ).rejects.toThrow(/total cap reached/);
  });


  it.skipIf(!existsSync("../.secrets/c2pa/signer.pem"))("generates: filter, DevRenderer, C2PA manifest with the licence, delegated and wallet-mode payRender", async () => {
    const { saveGrant } = await import("./delegation");
    const { generate, claim, fileByToken, GenerateError } = await import("./generate");
    const { readManifest } = await import("./c2pa");
    const { readReceipt } = await import("./protocol");
    await saveGrant({ licensee: addr.brand, provider: "dev-local", capUsdc: (10n * PRICE).toString(), spentUsdc: "0", createdAt: Date.now() });

    await expect(generate({ licenceId, licensee: addr.brand, prompt: "topless beach shoot", mode: "delegated" })).rejects.toBeInstanceOf(GenerateError);

    const r = await generate({ licenceId, licensee: addr.brand, prompt: "smiling in a sunlit cafe holding a ceramic cup, product shot", mode: "delegated" });
    expect(r.record.state).toBe("paid");
    expect(r.record.test).toBe(true);
    const file = (await fileByToken(r.record.download!.split("/").pop()!))!;
    const { createHash } = await import("node:crypto");
    expect(`0x${createHash("sha256").update(file.bytes).digest("hex")}`).toBe(r.record.assetHash);
    const m = await readManifest(new Uint8Array(file.bytes), file.mime);
    expect(m.present && m.licence?.licenceId).toBe(licenceId.toString());
    expect(m.present && m.licence?.renderIndex).toBe(2);
    expect(m.present && m.signatureValid).toBe(true);
    const receipt = await readReceipt(r.record.assetHash);
    expect(receipt?.licenceId).toBe(licenceId);
    expect(receipt?.renderIndex).toBe(2);
    rendered = { bytes: new Uint8Array(file.bytes), mime: file.mime };

    const { verifyFile } = await import("./verify");
    const v = await verifyFile(rendered.bytes, rendered.mime);
    expect(v.verdict).toBe("Licensed");
    expect(v.manifestMatches).toBe(true);
    expect(v.notes.join(" ")).toMatch(/unverified test creator/);
    expect(v.notes.join(" ")).toMatch(/TEST RENDER/);
    // Re-encoding the image keeps nothing the receipt can match: Unknown, with the manifest's claim named.
    const sharp = (await import("sharp")).default;
    const reencoded = new Uint8Array(await sharp(rendered.bytes).jpeg({ quality: 70 }).toBuffer());
    const u = await verifyFile(reencoded, "image/jpeg");
    expect(u.verdict).toBe("Unknown");

    // Wallet mode: the server signs the authorisation and holds the file until the brand pays.
    const w = await generate({ licenceId, licensee: addr.brand, prompt: "running shoes ad on a city street at dusk", mode: "wallet" });
    expect(w.record.download).toBeUndefined();
    await expect(claim(w.authorisation!.assetHash, undefined)).rejects.toThrow(/no receipt/);
    const a = w.authorisation!;
    await write(keys.brand, { address: deployment.LicenseEscrow!, abi: LicenseEscrowAbi, functionName: "payRender", args: [a.licenceId, a.assetHash, a.agent, a.deadline, a.agentSig] } as never);
    const claimed = await claim(a.assetHash, undefined);
    expect(claimed.download).toMatch(/^\/api\/renders\/file\//);
  });

  it("revokes: keys dropped, renders refused, receipts kept, unused escrow refunded", async () => {
    await write(keys.creator, { address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "revoke", args: [licenceId] } as never);
    const { readLicence, readReceipt, revokedAt, readEscrow } = await import("./protocol");
    const l = (await readLicence(licenceId))!;
    expect(l.status).toBe("Revoked");
    const { referenceImages, releaseState } = await import("./keyring");
    await expect(referenceImages(licenceId)).rejects.toThrow(/Revoked/);
    expect(releaseState(licenceId).keyHeld).toBe(false);

    const { renderAgent } = await import("./agent");
    const agent = await renderAgent();
    const h = keccak256(toHex("after-revoke"));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    await expect(
      fork.pub.simulateContract({
        account: addr.brand,
        address: deployment.LicenseEscrow!,
        abi: LicenseEscrowAbi,
        functionName: "payRender",
        args: [licenceId, h, agent.address, deadline, await agent.signRender({ licenceId, assetHash: h, renderIndex: 4, deadline })],
      }),
    ).rejects.toThrow(/NotActive/);

    // Content made before revocation keeps its receipt.
    expect((await readReceipt(keccak256(toHex("fork-render-1"))))?.licenceId).toBe(licenceId);
    const when = await revokedAt(l);
    expect(when?.how).toBe("licence");
    if (rendered) {
      const { verifyFile } = await import("./verify");
      const v = await verifyFile(rendered.bytes, rendered.mime);
      expect(v.verdict).toBe("Revoked");
      expect(v.headline).toMatch(/Licensed when made .*since revoked/);
      expect(v.revoked?.how).toBe("licence");
    }

    const { generate } = await import("./generate");
    await expect(generate({ licenceId, licensee: addr.brand, prompt: "studio portrait", mode: "delegated" })).rejects.toThrow(/refused/);

    const before = await fork.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr.brand] });
    await write(keys.brand, { address: deployment.LicenseEscrow!, abi: LicenseEscrowAbi, functionName: "refund", args: [licenceId] } as never);
    const after = await fork.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr.brand] });
    expect(after - before).toBe(PRICE);
    expect((await readEscrow(licenceId)).balance).toBe(0n);
  });

  it("revokeAll revokes an auto-approved licence issued later in the same epoch", async () => {
    const terms: Terms = { categories: 1 << 8, regions: 0x3f, maxDuration: 30n * 86_400n, maxRenders: 10, pricePerRender: PRICE, autoApprove: true };
    await write(keys.creator, { address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "setTerms", args: [terms] } as never);
    const req = { creator: addr.creator, category: 1 << 8, regions: 1, duration: 86_400n, renderCap: 2, pricePerRender: PRICE, purposeHash: keccak256("0x02"), deadline: 0n, salt: keccak256("0x03") };
    const r = await write(keys.brand, { address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "request", args: [req, "0x"] } as never);
    const { parseEventLogs } = await import("viem");
    const id = parseEventLogs({ abi: LicenseRegistryAbi, logs: r.logs, eventName: "LicenceIssued" })[0].args.id;
    await write(keys.creator, { address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "revokeAll", args: [] } as never);
    const { readLicence, revokedAt } = await import("./protocol");
    const l = (await readLicence(id))!;
    expect(l.status).toBe("Revoked");
    expect((await revokedAt(l))?.how).toBe("all");
  });
});
