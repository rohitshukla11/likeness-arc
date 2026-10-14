import "server-only";
/**
 * Is this file licensed?
 *
 *  1. sha256 of the exact bytes → ReceiptAnchor.receiptOf. A receipt exists only if payRender
 *     succeeded, and payRender only succeeds on an Active licence, so a file with a receipt was
 *     licensed when it was made, by construction.
 *  2. The C2PA manifest, if any: which licence it claims, whether its signature holds, who signed.
 *  3. The licence's status now:
 *       Active / Exhausted → Licensed
 *       Expired            → Expired (licensed when made, licence period over)
 *       Revoked            → Revoked (licensed when made, since revoked), with when and how
 *     No receipt for these bytes → Unknown, even if a manifest claims a licence (edited, re-encoded,
 *     or never paid for). A hash alone (no file) checks the receipt only.
 */
import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { categoryLabels, regionLabels } from "@/lib/categories";
import { formatDuration, usdc } from "@/lib/licensing";
import { LIVENESS_NOTE } from "@/lib/verification";
import { readManifest, type ManifestRead } from "./c2pa";
import { mediaRecord } from "./media";
import { history } from "./index";
import { readCreatorWithHistory, readLicence, readReceipt, revokedAt, type CreatorView } from "./protocol";

export type Verdict = "Licensed" | "Expired" | "Revoked" | "Unknown" | "ProfilePhoto" | "Sample";

export type Verification = {
  verdict: Verdict;
  headline: string;
  assetHash: Hex;
  receipt: { licenceId: string; renderIndex: number; renderedAt: number; tx?: Hex } | null;
  manifest: ManifestRead | null;
  manifestMatches: boolean | null;
  licence: {
    id: string;
    status: string;
    use: string;
    regions: string;
    start: number;
    end: number;
    renders: string;
    price: string;
    creator: string;
    licensee: string;
  } | null;
  creator: Pick<CreatorView, "address" | "trust" | "verifiedAt" | "upgradedAt"> | null;
  revoked: { at: number; tx: Hex; how: string } | null;
  /** For a profile photo or sample render Likeness published: what it is and whether it is still up. */
  preview: { kind: "profile-photo" | "sample-render"; status: "pending" | "live" | "removed"; publishedAt: number; removedAt?: number; aiGenerated?: boolean } | null;
  notes: string[];
};

export async function verifyHash(assetHash: Hex, manifest: ManifestRead | null = null): Promise<Verification> {
  const notes: string[] = [];
  const receipt = await readReceipt(assetHash);
  const claimed = manifest?.present ? manifest.licence : null;

  if (manifest?.present) {
    if (!manifest.signatureValid) notes.push("The C2PA manifest does not validate: the file or its manifest was altered after signing.");
    if (!manifest.trustedSigner) notes.push(`C2PA signer “${manifest.signer.commonName ?? "unknown"}” is a test certificate, not on the C2PA trust list.`);
    if (claimed?.renderer.test) notes.push("This is a TEST RENDER from the DevRenderer, not a model output.");
  }

  if (!receipt) {
    // A preview Likeness published (by its exact bytes), or a file whose manifest says it is one.
    const rec = await mediaRecord(assetHash.slice(2));
    const kind = rec && rec.kind !== "brand-logo" ? rec.kind : manifest?.present && manifest.signatureValid ? (manifest.preview?.kind ?? null) : null;
    if (kind) {
      const creatorView = rec ? await readCreatorWithHistory(rec.owner as Hex) : manifest?.present && manifest.preview ? await readCreatorWithHistory(manifest.preview.creator as Hex) : null;
      if (!rec) notes.push("Recognised from its content credential; these exact bytes are not on file (it was edited or re-encoded).");
      if (rec?.status === "removed") notes.push("The creator has since taken it down.");
      const ai = kind === "profile-photo" && (!!rec?.ai || (!!manifest?.present && !!manifest.preview?.aiGenerated));
      return {
        verdict: kind === "profile-photo" ? "ProfilePhoto" : "Sample",
        headline:
          kind === "profile-photo"
            ? ai
              ? "AI-generated profile image of a Likeness creator. It is a preview, not a licensed asset: no licence to use this face comes with it."
              : "Profile photo of a Likeness creator. It is a preview, not a licensed asset: no licence to use this face comes with it."
            : "Sample render: not a licence to use this face. Made by Likeness for the creator's profile.",
        assetHash,
        receipt: null,
        manifest,
        manifestMatches: null,
        licence: null,
        creator: creatorView ? { address: creatorView.address, trust: creatorView.trust, verifiedAt: creatorView.verifiedAt, upgradedAt: creatorView.upgradedAt } : null,
        revoked: null,
        preview: rec ? { kind: rec.kind as "profile-photo" | "sample-render", status: rec.status, publishedAt: rec.createdAt, removedAt: rec.removedAt, ...(ai ? { aiGenerated: true } : {}) } : null,
        notes,
      };
    }
    return {
      verdict: "Unknown",
      headline: claimed
        ? `Claims Likeness licence #${claimed.licenceId}, but there is no on-chain receipt for this exact file. It was edited or re-encoded after delivery, or never paid for.`
        : "No Likeness receipt for this file.",
      assetHash,
      receipt: null,
      manifest,
      manifestMatches: null,
      licence: null,
      creator: null,
      revoked: null,
      preview: null,
      notes,
    };
  }

  const l = (await readLicence(receipt.licenceId))!;
  const c = await readCreatorWithHistory(l.creator);
  const h = await history();
  const paid = h.renders.find((r) => r.assetHash.toLowerCase() === assetHash.toLowerCase());
  const rev = l.status === "Revoked" ? await revokedAt(l) : null;
  if (c?.trust.level === "unverified-test") notes.push("The creator is an unverified test creator: no liveness or ID check was run.");
  if (c?.trust.level === "demo") notes.push("The creator is the scripted demo creator (Demo Creator): a synthetic, non-real face attested without an ID or liveness check.");
  if (c?.trust.level === "verified") {
    notes.push(`Creator verified by Didit${c.trust.sandbox ? " (sandbox)" : ""}: ID 18+, ${c.trust.livenessMethod} liveness, selfie-to-ID face match. ${LIVENESS_NOTE[c.trust.livenessMethod]}`);
    if (c.upgradedAt)
      notes.push(
        `The creator's verification was upgraded to this level on ${new Date(c.upgradedAt * 1000).toISOString().slice(0, 10)}${c.upgradedAt > receipt.timestamp ? ", after this file was made; it was made under the earlier, lower level" : ""}.`,
      );
  }
  const manifestMatches = claimed ? claimed.licenceId === receipt.licenceId.toString() && claimed.renderIndex === receipt.renderIndex : null;
  if (manifestMatches === false) notes.push("The manifest names a different licence or render than the on-chain receipt. Trust the receipt.");

  const when = new Date(receipt.timestamp * 1000).toISOString().slice(0, 10);
  const verdict: Verdict = l.status === "Revoked" ? "Revoked" : l.status === "Expired" ? "Expired" : "Licensed";
  const headline = {
    Licensed: `Licensed. Made under licence #${l.id} on ${when}, and the licence is still in force.`,
    Expired: `Expired. Licensed when made (${when}); licence #${l.id} ended on ${new Date(Number(l.end) * 1000).toISOString().slice(0, 10)}.`,
    Revoked: `Revoked. Licensed when made (${when}), since revoked${rev ? ` on ${new Date(rev.timestamp * 1000).toISOString().slice(0, 10)}${rev.how === "all" ? " (the creator revoked every licence)" : rev.how === "suspension" ? " (creator suspended)" : ""}` : ""}.`,
    Unknown: "",
  }[verdict];

  return {
    verdict,
    headline,
    assetHash,
    receipt: { licenceId: receipt.licenceId.toString(), renderIndex: receipt.renderIndex, renderedAt: receipt.timestamp, tx: paid?.tx },
    manifest,
    manifestMatches,
    licence: {
      id: l.id.toString(),
      status: l.status,
      use: categoryLabels(l.category).join(", "),
      regions: regionLabels(l.regions).join(", "),
      start: Number(l.start),
      end: Number(l.end),
      renders: `${l.renderCount} of ${l.renderCap}`,
      price: `${usdc.format(l.pricePerRender)} USDC per render`,
      creator: l.creator,
      licensee: l.licensee,
    },
    creator: c ? { address: c.address, trust: c.trust, verifiedAt: c.verifiedAt, upgradedAt: c.upgradedAt } : null,
    revoked: rev ? { at: rev.timestamp, tx: rev.tx, how: rev.how } : null,
    preview: null,
    notes: [...notes, `Licence length ${formatDuration(l.end - l.start)}.`],
  };
}

export async function verifyFile(bytes: Uint8Array, mime: string): Promise<Verification> {
  const assetHash = `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
  const manifest = await readManifest(bytes, mime);
  return verifyHash(assetHash, manifest);
}
