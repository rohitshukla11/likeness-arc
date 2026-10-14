/**
 * Creator public profiles, sample renders, brand onboarding and visibility tiers, end to end on an anvil
 * fork of Arc mainnet (the real deployed contracts). The creator's reference photos are real face
 * images (the landing page's portrait, three variants); a photo of another person must be refused.
 * Samples use the DevRenderer (no model key in tests), so no model cost.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { parseEther, stringToHex, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { signAttestation } from "@/lib/attestation";
import { actionMessage } from "@/lib/auth";
import { BRAND_POLICY_VERSION, brandPolicyHash, brandProfileFields } from "@/lib/brand-policy";
import { SAMPLE_SCENES } from "@/lib/creator-profile";
import { b64u } from "@/lib/crypto/encoding";
import { devNamespaceKey } from "@/lib/crypto/devkeys";
import { referenceSetHash, sealReferenceSet, unwrapDek, type ReferenceSet } from "@/lib/crypto/envelope";
import { releaseForSamples, sampleContext } from "@/lib/crypto/release";
import { deployment } from "@/lib/deployment";
import { hasAnvil, startFork, takeOverRoles, wallet, type Fork } from "@/lib/dev/fork";

// Needs arc-anvil and the deployed contracts (lib/deployment.ts).
const run = hasAnvil() && process.env.SKIP_FORK_TESTS !== "1" && !!deployment.CreatorRegistry;
const facesAvailable = existsSync(path.resolve(process.cwd(), ".models/auraface_glintr100.onnx"));

describe.skipIf(!run)("public profiles, samples and brands", () => {
  let fork: Fork;
  const attesterKey = generatePrivateKey();
  const creatorKey = generatePrivateKey();
  const brandKey = generatePrivateKey();
  const creator = privateKeyToAccount(creatorKey).address.toLowerCase() as Address;
  const brand = privateKeyToAccount(brandKey).address.toLowerCase() as Address;
  const devSecret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  let set: ReferenceSet;
  let photos: Uint8Array[];
  let stranger: Uint8Array;

  const sign = async (key: `0x${string}`, action: string, fields: Record<string, string>) => {
    const acct = privateKeyToAccount(key);
    const message = actionMessage(action, { wallet: acct.address.toLowerCase(), ...fields });
    return { message, signature: await acct.signMessage({ message }) };
  };

  beforeAll(async () => {
    fork = await startFork(8552);
    const tmp = mkdtempSync(path.join(tmpdir(), "likeness-profiles-"));
    const keyFile = path.join(tmp, "attester.key");
    (await import("node:fs")).writeFileSync(keyFile, attesterKey);
    Object.assign(process.env, {
      ARC_RPC_URL: fork.url,
      DB_DIR: path.join(tmp, "db"),
      MEDIA_DIR: path.join(tmp, "media"),
      INDEX_CACHE_DIR: tmp,
      INDEX_START_BLOCK: String(fork.forkBlock + 1n),
      ATTESTER_KEY_FILE: keyFile,
      VERIFICATION_LEVEL: "free",
      MAILER: "test",
    });
    delete process.env.GEMINI_API_KEY; // DevRenderer, local prompt rules: no model cost in tests
    delete process.env.RESEND_API_KEY;
    await takeOverRoles(fork, { attester: privateKeyToAccount(attesterKey).address, agent: privateKeyToAccount(generatePrivateKey()).address });
    await fork.test.setBalance({ address: creator, value: parseEther("5") });

    // Three photos of one real face (the landing portrait), and a photo of someone else.
    const face = readFileSync(path.resolve(process.cwd(), "public/landing/portrait-cyan.png"));
    photos = [
      new Uint8Array(await sharp(face).jpeg().toBuffer()),
      new Uint8Array(await sharp(face).extract({ left: 10, top: 6, width: 270, height: 410 }).jpeg().toBuffer()),
      new Uint8Array(await sharp(face).modulate({ brightness: 1.06 }).jpeg().toBuffer()),
    ];
    stranger = new Uint8Array(await sharp(readFileSync(path.resolve(process.cwd(), "public/landing/hero-cutout.webp"))).flatten({ background: "#ffffff" }).jpeg().toBuffer());

    const key = await devNamespaceKey(devSecret, { kind: "reference" });
    set = await sealReferenceSet(key.kek, creator, photos.map((p) => p.slice()));
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
    const terms = { categories: (1 << 8) | (1 << 9), regions: 63, maxDuration: 30n * 86_400n, maxRenders: 100, pricePerRender: 2_000_000n, autoApprove: false };
    const hash = await wallet(fork, creatorKey).writeContract({ address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "register", args: [creator, a, deadline, sig, terms] } as never);
    await fork.pub.waitForTransactionReceipt({ hash });
  }, 180_000);
  afterAll(() => fork?.stop());

  // ---------------------------------------------------------------- public photo

  it.skipIf(!facesAvailable)("refuses a public photo of someone else", async () => {
    const { setPublicPhoto } = await import("./profiles");
    const { sha256 } = await import("./media");
    const auth = await sign(creatorKey, "set public photo", { "photo sha256": sha256(stranger) });
    // Checked against all three attested photos: the best of them still must not pass a stranger.
    await expect(setPublicPhoto({ address: creator, auth, set, references: photos.map((p) => p.slice()), photo: stranger.slice() })).rejects.toThrow(/doesn't match your verified face/);
    // A reference that is not one of the attested photos is refused before any matching.
    const again = await sign(creatorKey, "set public photo", { "photo sha256": sha256(stranger) });
    await expect(setPublicPhoto({ address: creator, auth: again, set, references: [stranger.slice()], photo: stranger.slice() })).rejects.toThrow(/not one of your attested photos/);
  }, 120_000);

  it.skipIf(!facesAvailable)("publishes a matching photo: 512 px, watermarked, labelled by the verifier", async () => {
    const { setPublicPhoto, publicProfile } = await import("./profiles");
    const { mediaBytes, sha256 } = await import("./media");
    const { verifyFile } = await import("./verify");
    const chosen = photos[1].slice();
    const auth = await sign(creatorKey, "set public photo", { "photo sha256": sha256(chosen) });
    const r = await setPublicPhoto({ address: creator, auth, set, references: [photos[0].slice(), photos[2].slice()], photo: chosen });
    expect(r.photo).toMatch(/^\/api\/media\/profile\//);
    const m = (await mediaBytes(r.sha256))!;
    const meta = await sharp(m.bytes).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);
    expect(meta.exif).toBeUndefined();
    const v = await verifyFile(new Uint8Array(m.bytes), "image/jpeg");
    expect(v.verdict).toBe("ProfilePhoto");
    expect(v.manifest?.present && v.manifest.preview?.kind).toBe("profile-photo");
    expect((await publicProfile(creator)).photo).toBe(r.photo);
  }, 120_000);

  it("sets style tags from the curated list only", async () => {
    const { setTags, publicProfile } = await import("./profiles");
    const t = { tone: ["warm", "playful"], setting: ["urban"], ageRange: "25–34" };
    const auth = await sign(creatorKey, "set style tags", { tone: "warm|playful", setting: "urban", "age range": "25–34" });
    await setTags(creator, auth, { ...t, tone: [...t.tone, "ethnicity:any"] } as never);
    expect((await publicProfile(creator)).tags).toEqual(t);
  });

  // ---------------------------------------------------------------- samples

  let published: string[] = [];
  it("creates two samples from a one-request release; the creator approves them", async () => {
    const { createSamples, decideSample, samplePublicKey, countPublished } = await import("./samples");
    const key = await devNamespaceKey(devSecret, { kind: "reference" });
    const dek = await unwrapDek(key.kek, set);
    const context = sampleContext(creator, "n1");
    const release = await releaseForSamples(dek, b64u.decode(samplePublicKey()), context);
    dek.fill(0);
    const prompts = SAMPLE_SCENES.slice(0, 2).map((s) => ({ scene: s.label, prompt: s.prompt }));
    const made = await createSamples({ creator, auth: await sign(creatorKey, "create sample renders", { context }), release, set, prompts });
    expect(made).toHaveLength(2);
    expect(made.every((s) => s.status === "pending" && s.url.startsWith("/api/media/"))).toBe(true);
    for (const s of made) await decideSample(creator, await sign(creatorKey, "decide sample", { sample: s.id, decision: "approve" }), s.id, "approve");
    published = made.map((s) => s.sha256);
    expect(await countPublished(creator)).toBe(2);
  }, 120_000);

  it("refuses a sample release replayed under another creator's context", async () => {
    const { createSamples, samplePublicKey } = await import("./samples");
    const key = await devNamespaceKey(devSecret, { kind: "reference" });
    const dek = await unwrapDek(key.kek, set);
    const release = await releaseForSamples(dek, b64u.decode(samplePublicKey()), sampleContext(brand, "x"));
    dek.fill(0);
    await expect(
      createSamples({ creator, auth: await sign(creatorKey, "create sample renders", { context: release.context }), release, set, prompts: [{ scene: "x", prompt: "studio portrait" }] }),
    ).rejects.toThrow(/another request/);
  });

  // ---------------------------------------------------------------- brand onboarding

  let session = "";
  it("onboards a brand with a verified domain (work email at the website's domain)", async () => {
    const { sendEmailCode, testMailbox, confirmEmailCode, saveBrandProfile, signBrandPolicy, startBrandSession, brandCards } = await import("./brands");
    await sendEmailCode(brand, await sign(brandKey, "verify work email", { email: "ads@brewandco.example" }), "ads@brewandco.example");
    await confirmEmailCode(brand, testMailbox("ads@brewandco.example")!);
    const fields = brandProfileFields({ name: "Brew & Co.", website: "https://www.brewandco.example", uses: ["Advertising", "Social"], monthlyRenders: "50–500", logoSha256: null });
    const saved = await saveBrandProfile({ address: brand, auth: await sign(brandKey, "save brand profile", fields), name: "Brew & Co.", website: "https://www.brewandco.example", uses: ["Advertising", "Social"], monthlyRenders: "50–500" });
    expect(saved.badge).toBe("verified-domain");
    expect(saved.kyb).toBe("not-run");
    await signBrandPolicy(brand, await sign(brandKey, "agree to the brand policy", { version: BRAND_POLICY_VERSION, "text sha256": await brandPolicyHash() }));
    session = (await startBrandSession(brand, await sign(brandKey, "start brand session", {}))).token;
    // What the creator sees on the request, before approving.
    expect((await brandCards([brand]))[brand]).toMatchObject({ name: "Brew & Co.", badge: "verified-domain" });
  });

  it("marks a free email domain as an unverified brand", async () => {
    const { badgeFor } = await import("./brands");
    expect(badgeFor({ emailDomain: "gmail.com", method: "email-code", at: 0 }, "brewandco.example")).toBe("unverified");
    expect(badgeFor({ emailDomain: "brewandco.example", method: "email-code", at: 0 }, "othershop.example")).toBe("unverified");
  });

  // ---------------------------------------------------------------- visibility tiers

  it("signed out: the photo and the count, but no sample images", async () => {
    const { GET } = await import("@/app/api/samples/route");
    const r = await GET(new NextRequest(`http://localhost/api/samples?creator=${creator}`));
    expect(r.status).toBe(401);
    const { publicProfile } = await import("./profiles");
    expect((await publicProfile(creator)).samples).toBe(2);
  });

  it("signed in as the brand: the samples, as short-lived URLs", async () => {
    const { GET } = await import("@/app/api/samples/route");
    const r = await GET(new NextRequest(`http://localhost/api/samples?creator=${creator}`, { headers: { "x-likeness-brand": session } }));
    expect(r.status).toBe(200);
    const { samples } = (await r.json()) as { samples: { url: string }[] };
    expect(samples).toHaveLength(2);
    const media = await import("@/app/api/media/[token]/route");
    const token = samples[0].url.split("/").pop()!;
    const img = await media.GET(new NextRequest(`http://localhost${samples[0].url}`), { params: Promise.resolve({ token }) } as never);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
  });

  it("signed URLs expire", async () => {
    const { signToken, readToken } = await import("./tokens");
    const t = signToken("media", { h: published[0], p: 0, v: brand }, 1);
    expect(readToken("media", t)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 2100));
    expect(readToken("media", t)).toBeNull();
    const media = await import("@/app/api/media/[token]/route");
    const res = await media.GET(new NextRequest(`http://localhost/api/media/${t}`), { params: Promise.resolve({ token: t }) } as never);
    expect(res.status).toBe(403);
    expect(readToken("brand-session", t)).toBeNull(); // a media token is not a session
  });

  it("the verifier labels a sample, not Unknown", async () => {
    const { mediaBytes } = await import("./media");
    const { verifyFile } = await import("./verify");
    const m = (await mediaBytes(published[0]))!;
    const v = await verifyFile(new Uint8Array(m.bytes), "image/jpeg");
    expect(v.verdict).toBe("Sample");
    expect(v.headline).toMatch(/not a licence/);
  });

  // ---------------------------------------------------------------- an approved sample as the public photo

  it("refuses a sample that is not one of the creator's approved samples", async () => {
    const { setPublicPhotoFromSample } = await import("./profiles");
    const auth = await sign(creatorKey, "set public photo from sample", { sample: "not-a-sample" });
    await expect(setPublicPhotoFromSample({ address: creator, auth, sampleId: "not-a-sample", set, references: [photos[0].slice()] })).rejects.toThrow(/approved samples/);
  });

  it.skipIf(!facesAvailable)("uses an approved sample as the public photo, labelled AI-generated everywhere", async () => {
    const { setPublicPhotoFromSample, publicProfile } = await import("./profiles");
    const { mySamples } = await import("./samples");
    const { mediaBytes } = await import("./media");
    const { verifyFile } = await import("./verify");
    const s = (await mySamples(creator, await sign(creatorKey, "list my samples", {}))).find((x) => x.sha256 === published[1])!;
    // A signature for another sample does not carry over.
    const wrong = await sign(creatorKey, "set public photo from sample", { sample: "other" });
    await expect(setPublicPhotoFromSample({ address: creator, auth: wrong, sampleId: s.id, set, references: [photos[0].slice()] })).rejects.toThrow(/another sample/);

    const auth = await sign(creatorKey, "set public photo from sample", { sample: s.id });
    const r = await setPublicPhotoFromSample({ address: creator, auth, sampleId: s.id, set, references: photos.map((p) => p.slice()) });
    expect(r.ai).toBe(true);
    const p = await publicProfile(creator);
    expect(p.photo).toBe(r.photo);
    expect(p.photoAi).toBe(true);
    const m = (await mediaBytes(r.sha256))!;
    const meta = await sharp(m.bytes).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);
    expect(meta.exif).toBeUndefined();
    const v = await verifyFile(new Uint8Array(m.bytes), "image/jpeg");
    expect(v.verdict).toBe("ProfilePhoto");
    expect(v.headline).toMatch(/^AI-generated profile image/);
    expect(v.preview?.aiGenerated).toBe(true);
    expect(v.manifest?.present && v.manifest.preview?.aiGenerated).toBe(true);
  }, 120_000);

  // ---------------------------------------------------------------- takedowns

  it("removing a sample takes it down everywhere", async () => {
    const { mySamples, decideSample, samplesForBrand } = await import("./samples");
    const { mediaBytes } = await import("./media");
    const { verifyFile } = await import("./verify");
    const before = (await mediaBytes(published[0]))!.bytes;
    const s = (await mySamples(creator, await sign(creatorKey, "list my samples", {}))).find((x) => x.sha256 === published[0])!;
    await decideSample(creator, await sign(creatorKey, "decide sample", { sample: s.id, decision: "remove" }), s.id, "remove");
    expect(await mediaBytes(published[0])).toBeNull();
    expect(await samplesForBrand(creator, brand)).toHaveLength(1);
    const v = await verifyFile(new Uint8Array(before), "image/jpeg");
    expect(v.verdict).toBe("Sample");
    expect(v.preview?.status).toBe("removed");
  });

  it.skipIf(!facesAvailable)("removing the public photo takes it down everywhere", async () => {
    const { removePublicPhoto, publicProfile, getProfile } = await import("./profiles");
    const { mediaBytes } = await import("./media");
    const hash = (await getProfile(creator))!.photo!.sha256;
    await removePublicPhoto(creator, await sign(creatorKey, "remove public photo", {}));
    expect(await mediaBytes(hash)).toBeNull();
    const p = await publicProfile(creator);
    expect(p.photo).toBeNull();
    expect(p.listed).toBe(false); // no photo, not listed
  });

  it("rate-limits sample views per brand", async () => {
    const { samplesForBrand, VIEWS_PER_HOUR } = await import("./samples");
    let refused = false;
    for (let i = 0; i <= VIEWS_PER_HOUR; i++) {
      try {
        await samplesForBrand(creator, brand);
      } catch (e) {
        refused = /too many sample views/.test((e as Error).message);
        break;
      }
    }
    expect(refused).toBe(true);
  });
});
