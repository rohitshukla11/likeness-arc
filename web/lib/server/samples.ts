import "server-only";
/**
 * Sample renders for a creator's public profile. Not licences: no LicenseEscrow, no payRender; Likeness
 * pays the model cost, capped at SAMPLES_PER_DAY per creator per UTC day.
 *
 * The creator's browser releases their reference DEK to the render service's sample key for one request
 * (lib/crypto/release: releaseForSamples). Every server instance derives that key from the attester key,
 * so the release and the render are one request; the decrypted references live only for it and are
 * zeroed after. Each result is watermarked "Sample · not licensed", given a C2PA manifest saying it is a
 * sample render and not a licence, and kept as pending until the creator approves it. Rejected samples
 * are deleted; published ones can be removed at any time.
 *
 * Images are only ever handed out as short-lived signed URLs: to the creator (their own pending and
 * published samples, after a wallet signature) and to signed-in brands with a completed profile
 * (published only, rate limited per brand).
 */
import { RenderBudgetError } from "./render/budget";
import { randomBytes } from "node:crypto";
import { hkdfSync } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import type { Address } from "viem";
import type { SignedAction } from "@/lib/auth";
import { CATEGORIES } from "@/lib/categories";
import { SAMPLE_SCENES, SAMPLES_PER_DAY, SAMPLES_PER_REQUEST } from "@/lib/creator-profile";
import { b64u } from "@/lib/crypto/encoding";
import { openItem, referenceSetHash, type ReferenceSet } from "@/lib/crypto/envelope";
import { acceptSampleRelease, sampleContext, type SampleRelease } from "@/lib/crypto/release";
import { verifyAction } from "./auth";
import { dbGet, dbPut } from "./db";
import { checkPrompt } from "./filter";
import { HttpError } from "./http";
import { loadKey } from "./keys";
import { logMedia, publishPreview, removeMedia, setMediaStatus } from "./media";
import { readCreator } from "./protocol";
import { render } from "./render";
import { assertCiphertext } from "./store";
import { signToken } from "./tokens";

export type Sample = {
  id: string;
  sha256: string;
  scene: string;
  prompt: string;
  model: string;
  test: boolean;
  status: "pending" | "published";
  createdAt: number;
  decidedAt?: number;
};
type SampleDoc = { creator: string; items: Sample[] };

const key = (a: string) => a.toLowerCase();
const doc = async (creator: string): Promise<SampleDoc> => (await dbGet<SampleDoc>("samples", key(creator))) ?? { creator: key(creator), items: [] };
const saveDoc = (d: SampleDoc) => dbPut("samples", d.creator, d);
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** The render service's sample key pair, the same on every instance (HKDF from the attester key). */
function sampleSecret(): Uint8Array {
  const attester = loadKey("ATTESTER_KEY_FILE", "ATTESTER_PRIVATE_KEY");
  if (!attester) throw new HttpError(503, "sample renders need the attester key on this server");
  return new Uint8Array(hkdfSync("sha256", Buffer.from(attester.slice(2), "hex"), Buffer.alloc(0), "likeness/samples/service-key/v1", 32));
}
export const samplePublicKey = () => b64u.encode(x25519.getPublicKey(sampleSecret()));

/** One of the creator's published samples, by id. */
export async function publishedSample(creator: string, id: string): Promise<Sample | null> {
  return (await doc(creator)).items.find((s) => s.id === id && s.status === "published") ?? null;
}

export async function countPublished(creator: string): Promise<number> {
  return (await doc(creator)).items.filter((s) => s.status === "published").length;
}

async function quota(creator: string, add: number) {
  const id = `${key(creator)}-${today()}`;
  const q = (await dbGet<{ count: number }>("sample-quota", id)) ?? { count: 0 };
  if (q.count + add > SAMPLES_PER_DAY) throw new HttpError(429, `you can create ${SAMPLES_PER_DAY} sample renders a day; ${Math.max(0, SAMPLES_PER_DAY - q.count)} left today`);
  await dbPut("sample-quota", id, { count: q.count + add });
}

/** Create up to SAMPLES_PER_REQUEST samples from the released reference set. Returns them as pending. */
export async function createSamples(input: { creator: Address; auth: SignedAction; release: SampleRelease; set: ReferenceSet; prompts: { scene: string; prompt: string }[] }) {
  const who = key(input.creator);
  const prompts = input.prompts.slice(0, SAMPLES_PER_REQUEST).map((p) => ({ scene: String(p.scene).slice(0, 40), prompt: String(p.prompt).trim().slice(0, 600) }));
  if (prompts.length === 0 || prompts.some((p) => p.prompt.length < 3)) throw new HttpError(400, "choose at least one scene or write a prompt");

  const fields = await verifyAction(input.auth, "create sample renders", input.creator);
  if (fields.wallet !== who || fields.context !== input.release.context || !input.release.context.startsWith(sampleContext(who, ""))) throw new HttpError(401, "signature is for another request");

  const creator = await readCreator(input.creator);
  if (!creator?.canLicense) throw new HttpError(409, "only registered, active creators can create samples");
  assertCiphertext(input.set);
  if (input.set.creator !== who) throw new HttpError(422, "reference set belongs to another creator");
  if ((await referenceSetHash(input.set)) !== creator.referenceSetHash) throw new HttpError(422, "reference set is not the one attested on chain");

  // Same banned-use filter as licensed renders, in the creator's first allowed use.
  const category = CATEGORIES.find((c) => creator.terms.categories & c.bit)?.bit ?? CATEGORIES[0].bit;
  for (const p of prompts) {
    const f = await checkPrompt(p.prompt, category);
    if (!f.allowed) throw new HttpError(422, `“${p.prompt.slice(0, 60)}…” is not allowed: ${f.reasons.join("; ")}`);
  }
  await quota(who, prompts.length);

  let dek: Uint8Array | undefined;
  let refs: Uint8Array[] = [];
  try {
    dek = await acceptSampleRelease(input.release, sampleSecret()).catch((e) => {
      throw new HttpError(422, `release does not open the reference set: ${(e as Error).message}`);
    });
    refs = await Promise.all(input.set.items.map((_, i) => openItem(dek!, input.set, i)));
    const made = await Promise.all(
      prompts.map(async (p, i) => {
        const out = await render({ prompt: p.prompt, references: refs, licenceId: 0n, renderIndex: i }).catch((e) => {
          throw e instanceof RenderBudgetError ? new HttpError(429, e.message) : e;
        });
        const id = randomBytes(8).toString("hex");
        const rec = await publishPreview({ bytes: out.bytes, kind: "sample-render", owner: who, edge: 1024, status: "pending", ref: id, model: out.model });
        return { id, sha256: rec.sha256, scene: p.scene, prompt: p.prompt, model: out.model, test: out.test, status: "pending" as const, createdAt: Date.now() };
      }),
    );
    const d = await doc(who);
    d.items.push(...made);
    await saveDoc(d);
    await logMedia({ action: "created", kind: "sample-render", owner: who, by: who, reason: `${made.length} pending` });
    return made.map((s) => withUrl(s, who, true));
  } finally {
    dek?.fill(0);
    refs.forEach((r) => r.fill(0));
  }
}

const withUrl = (s: Sample, viewer: string, allowPending: boolean) => ({
  ...s,
  url: `/api/media/${signToken("media", { h: s.sha256, p: allowPending ? 1 : 0, v: viewer }, 15 * 60)}`,
});

/** The creator's own samples (pending and published), after a wallet signature. */
export async function mySamples(creator: Address, auth: SignedAction) {
  const fields = await verifyAction(auth, "list my samples", creator);
  if (fields.wallet !== key(creator)) throw new HttpError(401, "signature is for another wallet");
  return (await doc(creator)).items.map((s) => withUrl(s, key(creator), true));
}

/** Approve (publish), reject (delete) or remove (take down) one sample. */
export async function decideSample(creator: Address, auth: SignedAction, id: string, decision: "approve" | "reject" | "remove") {
  const who = key(creator);
  const fields = await verifyAction(auth, "decide sample", creator);
  if (fields.wallet !== who || fields.sample !== id || fields.decision !== decision) throw new HttpError(401, "signature does not match this decision");
  const d = await doc(who);
  const s = d.items.find((x) => x.id === id);
  if (!s) throw new HttpError(404, "no such sample");
  if (decision === "approve") {
    if (s.status !== "pending") throw new HttpError(409, "only a pending sample can be approved");
    await setMediaStatus(s.sha256, "live");
    Object.assign(s, { status: "published", decidedAt: Date.now() });
    await logMedia({ action: "published", sha256: s.sha256, kind: "sample-render", owner: who, by: who, reason: "approved by the creator" });
  } else {
    await removeMedia(s.sha256, who, decision === "reject" ? "rejected by the creator" : "removed by the creator");
    d.items = d.items.filter((x) => x.id !== id);
  }
  await saveDoc(d);
  return { ok: true };
}

/** Published samples for a signed-in brand, as short-lived URLs; rate limited per brand per hour. */
export const VIEWS_PER_HOUR = 120;
export async function samplesForBrand(creator: string, brand: string) {
  const published = (await doc(creator)).items.filter((s) => s.status === "published");
  if (published.length === 0) return [];
  const id = `${key(brand)}-${new Date().toISOString().slice(0, 13).replace(/[-T]/g, "")}`;
  const v = (await dbGet<{ count: number }>("sample-views", id)) ?? { count: 0 };
  if (v.count + published.length > VIEWS_PER_HOUR) throw new HttpError(429, "too many sample views this hour; try again later");
  await dbPut("sample-views", id, { count: v.count + published.length });
  return published.map((s) => {
    const { url } = withUrl(s, key(brand), false);
    return { id: s.id, scene: s.scene, url, test: s.test };
  });
}

export const SCENES = SAMPLE_SCENES;
