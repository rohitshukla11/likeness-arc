import type { Metadata } from "next";
import Link from "next/link";
import { isAddress, type Address } from "viem";
import { RequestLicence } from "@/components/market/RequestLicence";
import { SamplesGallery } from "@/components/profile/SamplesGallery";
import { BrandGate } from "@/components/brand/BrandGate";
import { AiTag, AppPage, btnClass, Card, Details, EmptyState, NoticePage, Silhouette, silhouetteFor, TagChip } from "@/components/ds";
import { IconArrowLeft, VerifiedMark } from "@/components/ds/icons";
import { Addr, Note, Tx, TrustBadge, fmtDay, shortAddr } from "@/components/ui";
import { categoryLabels, regionLabels } from "@/lib/categories";
import { explorer } from "@/lib/chain";
import { formatDuration, usdc, DEMO_CREATOR_NAME, DEMO_TRUST_LABEL } from "@/lib/licensing";
import { publicProfile } from "@/lib/server/profiles";
import { readCreatorWithHistory } from "@/lib/server/protocol";
import { LEVEL_SUMMARY, LIVENESS_NOTE } from "@/lib/verification";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/market/[address]">): Promise<Metadata> {
  const { address } = await params;
  return { title: isAddress(address) ? `Creator ${shortAddr(address)}` : "Creator" };
}

export default async function CreatorPage({ params }: PageProps<"/market/[address]">) {
  const { address } = await params;
  if (!isAddress(address)) return <NoticePage title="Not an address">That link does not point to a wallet address.</NoticePage>;
  const c = await readCreatorWithHistory(address as Address);
  if (!c) return <NoticePage title="Not a registered creator">No creator is registered at {shortAddr(address)}.</NoticePage>;
  const terms = { ...c.terms, maxDuration: c.terms.maxDuration.toString(), pricePerRender: c.terms.pricePerRender.toString() };
  const verified = c.trust.level === "verified";
  const profile = await publicProfile(c.address);
  const method = c.trust.level === "verified" ? c.trust.livenessMethod : null;

  const tags = [...profile.tags.tone, ...profile.tags.setting, ...(profile.tags.ageRange ? [profile.tags.ageRange] : [])];
  const name = c.trust.level === "demo" ? DEMO_CREATOR_NAME : shortAddr(c.address);

  return (
    <AppPage
      title={
        <span className="flex flex-wrap items-center gap-2.5">
          <span className="sr-only">Creator </span>
          <span className="tnum font-mono">{name}</span>
          {verified && <VerifiedMark size={22} />}
        </span>
      }
      description={verified ? `Verified ${fmtDay(c.verifiedAt)}${c.upgradedAt ? `, upgraded ${fmtDay(c.upgradedAt)}` : ""} · ${method === "passive" ? "passive" : "full"} liveness · Arc mainnet` : "Creator on Arc mainnet"}
      actions={
        <>
          <Link href="/market" className={btnClass("outline")}>
            <IconArrowLeft size={16} /> All creators
          </Link>
          {c.canLicense && (
            <a href="#request" className={btnClass("lime", "desk:hidden")}>
              Request licence
            </a>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-[18px]">
          <Card label="Profile">
            <div className="flex flex-col gap-5 sm:flex-row">
              <div className="relative w-full shrink-0 overflow-hidden rounded-[16px] sm:w-[260px]" style={{ background: silhouetteFor(c.address).tint }}>
                {profile.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.photo} alt={`${profile.photoAi ? "AI-generated public image" : "Public photo"} of creator ${name}`} className="aspect-[4/5] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[4/5] items-end justify-center">
                    <Silhouette fill={silhouetteFor(c.address).sil} width="80%" />
                  </div>
                )}
                {profile.photo && profile.photoAi && <AiTag className="absolute left-2.5 top-2.5" />}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <h2 className="tnum m-0 font-mono text-[20px] font-bold">{name}</h2>
                <TrustBadge trust={c.trust} />
                <div className="flex flex-wrap gap-1.5">
                  {categoryLabels(c.terms.categories).map((l) => (
                    <TagChip key={l}>{l}</TagChip>
                  ))}
                  {tags.map((t) => (
                    <span key={t} className="inline-flex items-center rounded-full border border-field px-2.5 py-1 text-[12px] capitalize text-grey">
                      {t}
                    </span>
                  ))}
                </div>
                <dl className="m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[14px]">
                  <dt className="text-grey">Regions</dt>
                  <dd className="m-0">{regionLabels(c.terms.regions).join(", ")}</dd>
                  <dt className="text-grey">Approval</dt>
                  <dd className="m-0">{c.terms.autoApprove ? "Instant inside these terms" : "Asks first"}</dd>
                  <dt className="text-grey">Samples</dt>
                  <dd className="m-0">{profile.samples} approved</dd>
                  <dt className="text-grey">Wallet</dt>
                  <dd className="m-0">
                    <a href={explorer.address(c.address)} target="_blank" rel="noreferrer" className="font-semibold text-wait underline">
                      Arc Explorer<span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </dd>
                </dl>
                {c.trust.level === "unverified-test" && <Note>This is a seeded test creator. No liveness or ID check was run; its images are synthetic placeholders.</Note>}
                {c.trust.level === "demo" && <Note>{DEMO_TRUST_LABEL}: a synthetic, non-real face attested by our attester without an ID check, used for the scripted end-to-end flow. Not listed in the marketplace.</Note>}
              </div>
            </div>
          </Card>

          <SamplesGallery creator={c.address} count={profile.samples} />

          <Details summary="Verification details">
            <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <dt className="text-grey">Liveness provider</dt>
              <dd className="m-0">
                <span className="font-mono">{c.trust.liveness}</span>
                {method && <span className="block text-[13px] text-grey">{LIVENESS_NOTE[method]}</span>}
              </dd>
              <dt className="text-grey">Age check provider</dt>
              <dd className="m-0 font-mono">{c.trust.age}</dd>
              {method && (
                <>
                  <dt className="text-grey">Verification level</dt>
                  <dd className="m-0">
                    {method === "passive" ? "free" : "full"}: {method === "passive" ? LEVEL_SUMMARY.free : LEVEL_SUMMARY.full}
                  </dd>
                </>
              )}
              <dt className="text-grey">Reference set hash</dt>
              <dd className="m-0 break-all font-mono text-[12px]">{c.referenceSetHash}</dd>
              {c.registeredTx && (
                <>
                  <dt className="text-grey">Registered</dt>
                  <dd className="m-0">
                    <Tx hash={c.registeredTx} />
                  </dd>
                </>
              )}
              {c.upgradedTx && (
                <>
                  <dt className="text-grey">Upgraded</dt>
                  <dd className="m-0">
                    <Tx hash={c.upgradedTx} />
                  </dd>
                </>
              )}
            </dl>
          </Details>
        </div>

        <div className="flex min-w-0 flex-col gap-[18px]">
          <Card tone="ink" title="Terms">
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2 text-[13px]">
              <dt className="text-grey-dark">Uses</dt>
              <dd className="m-0">{categoryLabels(c.terms.categories).join(", ")}</dd>
              <dt className="text-grey-dark">Price</dt>
              <dd className="tnum m-0">${usdc.format(c.terms.pricePerRender)} per render</dd>
              <dt className="text-grey-dark">Limits</dt>
              <dd className="m-0">
                {c.terms.maxRenders} renders, {formatDuration(c.terms.maxDuration)}
              </dd>
              <dt className="text-grey-dark">Approval</dt>
              <dd className="m-0">{c.terms.autoApprove ? "Automatic inside these terms" : "The creator signs every licence"}</dd>
              <dt className="text-grey-dark">Never</dt>
              <dd className="m-0">Political, adult, minors, impersonation, deception</dd>
              <dt className="text-grey-dark">Payout</dt>
              <dd className="m-0">
                <Addr a={c.payout} />
              </dd>
            </dl>
          </Card>
          <div className="flex flex-col gap-[18px] desk:sticky desk:top-6">
            {c.canLicense ? (
              <BrandGate creator={c.address}>
                <RequestLicence creator={c.address} terms={terms} />
              </BrandGate>
            ) : (
              <EmptyState title="Not accepting new licences">This creator is not accepting new licences right now. Existing licences keep their terms until they end.</EmptyState>
            )}
          </div>
        </div>
      </div>
    </AppPage>
  );
}
