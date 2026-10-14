"use client";

/**
 * Verify (Verify.dc.html): anyone drops a file (hashed and its C2PA manifest read on the server, not
 * stored) or pastes its sha256, and sees Licensed, Revoked ("licensed when made, since revoked"),
 * Expired or Unknown, with the creator, the licensee and the checks behind the answer.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useBrandCards, useProfiles } from "@/lib/client/profiles";
import { AppPage, BrandChip, btnClass, Card, CreatorFace, ErrorCard, StatusPill } from "@/components/ds";
import { IconCheck, IconCross, IconQuestion, IconUpload } from "@/components/ds/icons";
import { fmtDate, fmtDay, Tx, inputClass } from "@/components/ui";
import type { Trust } from "@/lib/licensing";

type V = {
  verdict: "Licensed" | "Expired" | "Revoked" | "Unknown" | "ProfilePhoto" | "Sample";
  headline: string;
  assetHash: string;
  receipt: { licenceId: string; renderIndex: number; renderedAt: number; tx?: string } | null;
  manifest:
    | { present: false; error?: string }
    | {
        present: true;
        licence: { licenceId: string; renderIndex: number; renderer: { provider: string; model: string; test: boolean }; createdAt: string } | null;
        signer: { issuer?: string; commonName?: string };
        signatureValid: boolean;
        trustedSigner: boolean;
      }
    | null;
  manifestMatches: boolean | null;
  licence: { id: string; status: string; use: string; regions: string; start: number; end: number; renders: string; price: string; creator: string; licensee: string } | null;
  creator: { address: string; trust: Trust; verifiedAt: number; upgradedAt?: number } | null;
  revoked: { at: number; tx: string; how: string } | null;
  preview?: { kind: "profile-photo" | "sample-render"; status: "pending" | "live" | "removed"; publishedAt: number; removedAt?: number; aiGenerated?: boolean } | null;
  notes: string[];
};

const LOOK = {
  Licensed: { tone: "lime", bg: "bg-lime", stroke: "#DCF37B", stamp: "Licensed", icon: IconCheck },
  Revoked: { tone: "coral", bg: "bg-coral", stroke: "#F7A4A1", stamp: "Licensed when made, since revoked", icon: IconCross },
  Expired: { tone: "grey", bg: "bg-[#D9DCE2]", stroke: "#D9DCE2", stamp: "Expired", icon: IconQuestion },
  Unknown: { tone: "grey", bg: "bg-[#D9DCE2]", stroke: "#D9DCE2", stamp: "Unknown", icon: IconQuestion },
  ProfilePhoto: { tone: "lavender", bg: "bg-lavender", stroke: "#ECE6FD", stamp: "Profile photo", icon: IconQuestion },
  Sample: { tone: "lavender", bg: "bg-lavender", stroke: "#ECE6FD", stamp: "Sample render", icon: IconQuestion },
} as const;

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}

function Verify() {
  const params = useSearchParams();
  const [hash, setHash] = useState(params.get("hash") ?? "");
  const [result, setResult] = useState<V | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ url: string; size: number; type: string } | null>(null);

  const run = useCallback(async (f: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setBrand(null);
    try {
      const r = await f();
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setResult(j);
      if (j.licence?.id)
        fetch(`/api/licences/${j.licence.id}`, { cache: "no-store" })
          .then((x) => x.json())
          .then((d) => setBrand(d.brief?.brand ?? null))
          .catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const byHash = useCallback((h: string) => run(() => fetch(`/api/verify?hash=${h.trim()}`, { cache: "no-store" })), [run]);
  useEffect(() => {
    const h = params.get("hash");
    if (h) void byHash(h);
  }, [params, byHash]);

  function onFile(f: File | undefined) {
    if (!f) return;
    setFile({ url: URL.createObjectURL(f), size: f.size, type: f.type });
    const form = new FormData();
    form.append("file", f);
    void run(() => fetch("/api/verify", { method: "POST", body: form }));
  }

  const look = result ? LOOK[result.verdict] : null;
  const faces = useProfiles(result?.creator ? [result.creator.address] : []);
  const brands = useBrandCards(result?.licence ? [result.licence.licensee] : []);
  const Icon = look?.icon ?? IconUpload;
  const m = result?.manifest && result.manifest.present ? result.manifest : null;
  const l = result?.licence;

  return (
    <AppPage title="Verify a file" description="Check whether the person in an image licensed it. Anyone can use this; no account needed.">
      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex min-w-0 flex-col gap-[14px]">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onFile(e.dataTransfer.files[0]);
            }}
            className="flex min-h-16 cursor-pointer items-center gap-3 rounded-[16px] border-2 border-dashed border-[#B9BEC6] bg-white px-3.5 text-[14px] font-semibold focus-within:outline focus-within:outline-[3px] focus-within:outline-violet"
          >
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-lime text-ink">
              <IconUpload size={20} />
            </span>
            <span className="flex-1">{busy ? "Checking…" : "Drop an image or choose a file"}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) void byHash(hash);
            }}
            className="flex flex-wrap items-center gap-2 text-[14px]"
          >
            <label htmlFor="hash" className="text-grey">
              or check a sha256
            </label>
            <input id="hash" className={`${inputClass} min-w-0 flex-[1_1_220px] font-mono text-[13px]`} placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} />
            <button type="submit" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())} className={btnClass("ink")}>
              Look up
            </button>
          </form>
          <figure className="m-0 flex flex-col gap-2 rounded-[20px] bg-white p-3">
            {file ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={file.url} alt="The checked image" className="max-h-[560px] w-full rounded-[14px] bg-paper object-contain" />
            ) : (
              <div className={`flex items-center justify-center rounded-[14px] bg-paper p-4 text-center text-[14px] text-grey ${result ? "min-h-28" : "aspect-[4/5] max-h-[420px]"}`}>
                {result ? "Checked by hash only, no file" : "The image you check appears here. Nothing is stored."}
              </div>
            )}
            {result && (
              <figcaption className="tnum break-all font-mono text-[12px] text-grey">
                asset {result.assetHash.slice(0, 6)}…{result.assetHash.slice(-4)}
                {file ? ` · ${Math.round(file.size / 1024)} KB · ${file.type.replace("image/", "").toUpperCase()}` : ""}
              </figcaption>
            )}
          </figure>
        </div>

        <div className="flex min-w-0 flex-col gap-[14px]">
          <section aria-label="Result" aria-live="polite" className={`flex items-center gap-4 rounded-[20px] px-5 py-[18px] ${look?.bg ?? "bg-white"}`}>
            <span aria-hidden="true" className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-ink">
              <Icon size={24} stroke={look?.stroke ?? "#DCF37B"} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {result ? (
                <>
                  <span className="text-[26px] font-bold leading-tight">{look!.stamp}</span>
                  <span className="text-[14px]">{subline(result)}</span>
                </>
              ) : (
                <>
                  <span className="text-[26px] font-bold leading-tight">{busy ? "Checking…" : "Ready when you are"}</span>
                  <span className="text-[14px] text-grey">We hash the file, read its content credential, and look up its receipt on Arc. Nothing is stored.</span>
                </>
              )}
            </div>
            {l && <span className="hidden shrink-0 rounded-full bg-ink px-3 py-1 text-[12px] font-semibold text-white sm:inline">Licence #{l.id.padStart(4, "0")}</span>}
          </section>

          {error && (
            <ErrorCard
              action={
                <button type="button" onClick={() => setError(null)} className={btnClass("outline")}>
                  Dismiss
                </button>
              }
            >
              {error}
            </ErrorCard>
          )}

          {!result && !error && (
            <p className="m-0 text-[14px] text-grey">
              Every render made through Likeness carries a C2PA content credential and an on-chain receipt keyed by the file&apos;s sha256. Edited or re-encoded copies
              come back Unknown.
            </p>
          )}

          {result && (
            <>
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-3">
                <div className="flex min-w-0 flex-col gap-2 rounded-[18px] bg-white p-4">
                  <span className="text-[13px] text-grey">Creator</span>
                  {result.creator ? (
                    <>
                      <Link href={`/market/${result.creator.address}`} className="flex min-w-0 items-center gap-2.5 font-semibold text-ink no-underline">
                        <CreatorFace seed={result.creator.address} photo={faces[result.creator.address.toLowerCase()]?.photo} size={36} />
                        <span className="tnum truncate">
                          {result.creator.address.slice(0, 6)}…{result.creator.address.slice(-4)}
                        </span>
                      </Link>
                      <TrustPill trust={result.creator.trust} />
                    </>
                  ) : (
                    <span className="text-[14px] text-grey">No licensed creator for this file</span>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-2 rounded-[18px] bg-white p-4">
                  <span className="text-[13px] text-grey">Licensee</span>
                  {l ? (
                    <span className="text-[14px]">
                      <BrandChip brand={brands[l.licensee.toLowerCase()]} fallback={brand ?? `${l.licensee.slice(0, 6)}…${l.licensee.slice(-4)}`} />
                    </span>
                  ) : (
                    <span className="text-[14px] text-grey">None on record</span>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-1.5 rounded-[18px] bg-white p-4">
                  <span className="text-[13px] text-grey">{l ? `Licence #${l.id.padStart(4, "0")} now` : "Licence now"}</span>
                  <span className="text-[20px] font-bold">{l ? (l.status === "Exhausted" ? "Used up" : l.status) : "None"}</span>
                  <span className="text-[12px] text-grey">{licenceDetail(result)}</span>
                </div>
              </div>

              {(result.receipt || result.preview) && (
                <section aria-label="Details" className="rounded-[18px] bg-white px-[18px] py-4">
                  <dl className="m-0 grid grid-cols-1 gap-x-[18px] gap-y-2.5 text-[13px] sm:grid-cols-3">
                    {result.receipt ? (
                      <>
                        <div>
                          <dt className="text-grey">Use</dt>
                          <dd className="m-0 mt-0.5 font-semibold">{l?.use ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-grey">Made</dt>
                          <dd className="m-0 mt-0.5 font-semibold">{fmtDate(result.receipt.renderedAt)}</dd>
                        </div>
                        <div>
                          <dt className="text-grey">Render</dt>
                          <dd className="m-0 mt-0.5 font-semibold">
                            #{result.receipt.renderIndex}
                            {l ? ` · ${l.price}` : ""}
                          </dd>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <dt className="text-grey">Kind</dt>
                          <dd className="m-0 mt-0.5 font-semibold">{result.preview!.kind === "profile-photo" ? (result.preview!.aiGenerated ? "AI-generated profile image" : "Profile photo") : "Sample render"}</dd>
                        </div>
                        <div>
                          <dt className="text-grey">Published</dt>
                          <dd className="m-0 mt-0.5 font-semibold">{fmtDate(Math.floor(result.preview!.publishedAt / 1000))}</dd>
                        </div>
                        <div>
                          <dt className="text-grey">Now</dt>
                          <dd className="m-0 mt-0.5 font-semibold">{result.preview!.status === "removed" ? "Taken down by the creator" : "Live"}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                </section>
              )}

              <ul className="on-dark m-0 grid list-none grid-cols-1 gap-x-5 gap-y-3 rounded-[18px] bg-ink p-[18px] text-[14px] text-white sm:grid-cols-2">
                <Check ok={!!m?.signatureValid}>
                  {m
                    ? m.signatureValid
                      ? <>Content credential intact{m.trustedSigner ? "" : <span className="text-grey-dark"> · test certificate</span>}</>
                      : "Content credential does not validate"
                    : result.manifest === null
                      ? "Content credential not read (checked by hash)"
                      : "No content credential in this file"}
                </Check>
                <Check ok={!!result.receipt}>
                  {result.receipt ? (
                    <>
                      Receipt recorded on Arc
                      {result.receipt.tx && (
                        <>
                          {" "}
                          <a href={`https://explorer.arc.io/tx/${result.receipt.tx}`} target="_blank" rel="noreferrer" className="text-lime underline-offset-2 hover:underline">
                            view tx<span className="sr-only"> (opens Arc Explorer)</span>
                          </a>
                        </>
                      )}
                    </>
                  ) : (
                    "No receipt on Arc for these exact bytes"
                  )}
                </Check>
                <Check ok={result.creator?.trust.level === "verified"}>
                  {result.creator?.trust.level === "verified" ? "Creator attested by Didit, 18+" : "No Didit-attested creator"}
                </Check>
                {(() => {
                  // Renders and samples are declared AI-generated in their credential; a profile photo is declared a camera photo unless made from a sample.
                  const ai = !!m?.signatureValid && (!!m.licence || result.verdict === "Sample" || !!result.preview?.aiGenerated);
                  const photo = !!m?.signatureValid && result.verdict === "ProfilePhoto" && !ai;
                  return <Check ok={ai || photo}>{ai ? "Marked as AI-generated" : photo ? "Marked as a photo, not AI-generated" : "No AI-generated marking read"}</Check>;
                })()}
              </ul>

              {result.manifest?.present && (
                <Card title="Content credential (C2PA)">
                  <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 text-[14px] sm:grid-cols-[8rem_1fr]">
                    <dt className="text-grey">Signature</dt>
                    <dd className="m-0">{result.manifest.signatureValid ? <StatusPill kind="licensed">valid</StatusPill> : <StatusPill kind="revoked">does not validate</StatusPill>}</dd>
                    <dt className="text-grey">Signed by</dt>
                    <dd className="m-0 flex flex-wrap items-center gap-2">
                      {result.manifest.signer.commonName ?? "unknown"}
                      {!result.manifest.trustedSigner && <StatusPill kind="waiting">test certificate, not on the C2PA trust list</StatusPill>}
                    </dd>
                    <dt className="text-grey">Claims</dt>
                    <dd className="m-0">
                      {result.manifest.licence
                        ? `Licence #${result.manifest.licence.licenceId}, render ${result.manifest.licence.renderIndex}${result.manifestMatches === false ? " (does not match the receipt)" : result.manifestMatches ? " (matches the receipt)" : ""}`
                        : "No licence claim"}
                    </dd>
                    {result.manifest.licence && (
                      <>
                        <dt className="text-grey">Renderer</dt>
                        <dd className="m-0">
                          {result.manifest.licence.renderer.test ? (
                            <StatusPill kind="waiting">TEST RENDER (no model)</StatusPill>
                          ) : (
                            `${result.manifest.licence.renderer.provider} · ${result.manifest.licence.renderer.model}`
                          )}
                        </dd>
                      </>
                    )}
                  </dl>
                </Card>
              )}
              {result.manifest && !result.manifest.present && result.manifest.error && <p className="m-0 text-[13px] text-grey">No C2PA manifest in this file ({result.manifest.error}).</p>}
              {result.revoked && (
                <p className="m-0 text-[13px] text-grey">
                  Revoked {fmtDate(result.revoked.at)}: <Tx hash={result.revoked.tx} />
                </p>
              )}
              {result.notes.length > 0 && (
                <ul className="m-0 list-disc space-y-1 pl-5 text-[13px] text-grey">
                  {result.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </AppPage>
  );
}

function subline(v: V): string {
  switch (v.verdict) {
    case "Licensed":
      return "Made under an active licence the person in it approved, paid for and recorded on Arc.";
    case "Revoked":
      return "Licensed when it was made. The creator revoked the licence afterwards, so it should not be used in new placements.";
    case "Expired":
      return "Licensed when it was made. The licence period has ended.";
    case "ProfilePhoto":
      return `${v.preview?.aiGenerated ? "AI-generated profile image" : "Profile photo"} of a Likeness creator: a preview, not a licensed asset.${v.preview?.status === "removed" ? " The creator has since taken it down." : ""}`;
    case "Sample":
      return `Sample render: not a licence to use this face.${v.preview?.status === "removed" ? " The creator has since taken it down." : ""}`;
    default:
      return v.headline;
  }
}

function licenceDetail(v: V): string {
  const l = v.licence;
  if (!l) return "No licence is recorded for these bytes.";
  if (v.revoked) return `By the ${v.revoked.how === "suspension" ? "platform (creator suspended)" : "creator"}, ${fmtDate(v.revoked.at)}`;
  if (l.status === "Active") {
    const [used, cap] = l.renders.split(" of ").map(Number);
    return `Until ${fmtDay(l.end)} · ${cap - used} render${cap - used === 1 ? "" : "s"} left`;
  }
  return `Ended ${fmtDay(l.end)}`;
}

function TrustPill({ trust }: { trust: Trust }) {
  if (trust.level === "verified")
    return (
      <span className="self-start">
        <StatusPill kind="waiting">Verified · {trust.livenessMethod === "passive" ? "passive" : "active"}</StatusPill>
      </span>
    );
  return (
    <span className="self-start">
      <StatusPill kind="revoked">{trust.level === "unverified-test" ? "Unverified test creator" : "Unknown attestation"}</StatusPill>
    </span>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ok ? "bg-lime" : "bg-[#3A3D44]"}`}>
        {ok ? <IconCheck size={14} stroke="#121316" /> : <IconCross size={12} stroke="#B9BCC4" />}
      </span>
      <span>
        <span className="sr-only">{ok ? "Passed: " : "Not passed: "}</span>
        {children}
      </span>
    </li>
  );
}
