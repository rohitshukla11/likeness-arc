"use client";

/**
 * Marketplace (App-Marketplace.dc.html): real, Didit-verified creators, with search, use and level
 * filters and a price sort. Sample thumbnails show only for a signed-in brand with a completed profile
 * and a brand session; everyone else sees locked tiles and the count.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppPage, btnClass, EmptyState } from "@/components/ds";
import { IconSearch } from "@/components/ds/icons";
import { CATEGORIES } from "@/lib/categories";
import { startBrandSession, storedBrandSession } from "@/lib/client/brand-session";
import { reason } from "@/lib/client/tx";
import { useBrandReady } from "@/components/brand/useBrandReady";
import { useWallet } from "@/components/wallet/WalletProvider";
import { CreatorCard, type MarketCreator, type SampleThumbs } from "./CreatorCard";

export type { MarketCreator } from "./CreatorCard";

const SAVED = "likeness:saved-creators";
/** Sample URLs live 15 minutes; reuse them for 12 so browsing doesn't spend the brand's hourly view budget. */
const THUMB_TTL = 12 * 60_000;
type Thumb = { id: string; scene: string; url: string };

function cachedThumbs(creator: string): Thumb[] | null {
  try {
    const c = JSON.parse(sessionStorage.getItem(`likeness:thumbs:${creator.toLowerCase()}`) ?? "null") as { at: number; items: Thumb[] } | null;
    return c && Date.now() - c.at < THUMB_TTL ? c.items : null;
  } catch {
    return null;
  }
}

export function Marketplace({ creators, source }: { creators: MarketCreator[]; source: string }) {
  const { wallet } = useWallet();
  // "Request licence" goes to brand onboarding first when this wallet has no completed brand profile.
  const brandReady = useBrandReady();
  const requestHref = (a: string) => (brandReady ? `/market/${a}#request` : `/brand/onboard?next=${encodeURIComponent(`/market/${a}#request`)}`);
  const [q, setQ] = useState("");
  const [use, setUse] = useState<string>("all");
  const [level, setLevel] = useState<"any" | "full">("any");
  const [sort, setSort] = useState<"price" | "newest">("price");
  const [saved, setSaved] = useState<string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, SampleThumbs>>({});
  const [unlocking, setUnlocking] = useState<string | null>(null);

  useEffect(() => {
    try {
      setSaved(JSON.parse(localStorage.getItem(SAVED) ?? "[]"));
    } catch {}
  }, []);
  const toggleSave = (a: string) =>
    setSaved((s) => {
      const next = s.includes(a) ? s.filter((x) => x !== a) : [...s, a];
      try {
        localStorage.setItem(SAVED, JSON.stringify(next));
      } catch {}
      return next;
    });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return creators
      .filter((c) => use === "all" || c.uses.includes(use))
      .filter((c) => level === "any" || c.liveness === "Full")
      .filter((c) => !needle || [c.address, c.region, ...c.uses, ...c.tags].some((x) => x.toLowerCase().includes(needle)))
      .sort((a, b) => (sort === "price" ? Number(BigInt(a.priceUnits) - BigInt(b.priceUnits)) : b.registeredAt - a.registeredAt));
  }, [creators, q, use, level, sort]);

  // A brand session from earlier in this tab opens the thumbnails without asking for another signature.
  useEffect(() => {
    setToken(wallet && brandReady ? storedBrandSession(wallet.address) : null);
  }, [wallet, brandReady]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    for (const c of shown.slice(0, 12)) {
      if (c.samples === 0) continue;
      const hit = cachedThumbs(c.address);
      if (hit) {
        setThumbs((t) => ({ ...t, [c.address]: { state: "shown", items: hit } }));
        continue;
      }
      setThumbs((t) => (t[c.address]?.state === "shown" ? t : { ...t, [c.address]: { state: "loading" } }));
      fetch(`/api/samples?creator=${c.address}`, { headers: { "x-likeness-brand": token }, cache: "no-store" })
        .then(async (r) => {
          const j = (await r.json()) as { samples?: Thumb[]; error?: string };
          if (!r.ok) throw new Error(j.error ?? `samples ${r.status}`);
          const items = (j.samples ?? []).slice(0, 3).map(({ id, scene, url }) => ({ id, scene, url }));
          try {
            sessionStorage.setItem(`likeness:thumbs:${c.address.toLowerCase()}`, JSON.stringify({ at: Date.now(), items }));
          } catch {}
          if (live) setThumbs((t) => ({ ...t, [c.address]: { state: "shown", items } }));
        })
        .catch((e) => live && setThumbs((t) => ({ ...t, [c.address]: { state: "error", message: reason(e) } })));
    }
    return () => {
      live = false;
    };
  }, [token, shown]);

  const thumbsFor = (c: MarketCreator): SampleThumbs =>
    thumbs[c.address] ?? { state: "locked", reason: !wallet ? "signed-out" : !brandReady ? "no-brand" : "no-session" };

  async function unlock() {
    if (!wallet) return;
    setUnlocking("Sign in your wallet to open sample renders…");
    try {
      setToken(await startBrandSession(wallet));
      setUnlocking(null);
    } catch (e) {
      setUnlocking(reason(e));
    }
  }
  const anySamples = creators.some((c) => c.samples > 0);

  return (
    <AppPage
      title="Marketplace"
      description="Verified creators on Arc mainnet. Every licence is approved by the person in it."
      actions={
        <>
          <form role="search" onSubmit={(e) => e.preventDefault()} className="flex h-11 w-full max-w-full items-center sm:w-[380px] gap-2 rounded-[12px] border border-field bg-white px-3.5">
            <IconSearch size={17} stroke="#5F636B" />
            <label htmlFor="creator-search" className="sr-only">
              Search creators by use, region or address
            </label>
            <input
              id="creator-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by use, region or address"
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-[14px] outline-none placeholder:text-grey"
            />
          </form>
          <Link href="/#how" className={btnClass("outline")}>
            How licensing works
          </Link>
        </>
      }
    >
      {creators.length === 0 ? (
        <EmptyState
          title="No creators listed yet"
          action={
            <Link href="/onboard" className={btnClass("ink")}>
              Become a creator
            </Link>
          }
        >
          Every creator here passes an ID check, a liveness selfie and a face match, and adds a public photo, before they are listed.
        </EmptyState>
      ) : (
        <>
          <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
            {[{ key: "all", label: "All uses" }, ...CATEGORIES.map((c) => ({ key: c.label, label: c.label }))].map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={use === f.key}
                onClick={() => setUse(f.key)}
                className={`min-h-11 rounded-full px-4 text-[14px] font-medium ${use === f.key ? "bg-ink text-white" : "border border-field bg-white text-ink hover:border-grey"}`}
              >
                {f.label}
              </button>
            ))}
            <span className="flex-1" />
            <span className="flex flex-wrap items-center gap-2">
              <label htmlFor="level" className="text-[13px] text-grey">
                Verification
              </label>
              <select id="level" value={level} onChange={(e) => setLevel(e.target.value as "any" | "full")} className="min-h-11 rounded-[12px] border border-field bg-white px-2.5 text-[14px]">
                <option value="any">Any level</option>
                <option value="full">Full (active liveness)</option>
              </select>
              <label htmlFor="sort" className="text-[13px] text-grey">
                Sort
              </label>
              <select id="sort" value={sort} onChange={(e) => setSort(e.target.value as "price" | "newest")} className="min-h-11 rounded-[12px] border border-field bg-white px-2.5 text-[14px]">
                <option value="price">Price, low to high</option>
                <option value="newest">Newest</option>
              </select>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 text-[13px] text-grey" aria-live="polite">
              {shown.length} of {creators.length} verified creator{creators.length === 1 ? "" : "s"} · from {source}
            </p>
            {wallet && brandReady && !token && anySamples && (
              <button type="button" onClick={unlock} className={btnClass("outline", "min-h-9 px-3 text-[13px]")}>
                Show samples
              </button>
            )}
            {unlocking && (
              <span role="status" className="text-[13px] text-wait">
                {unlocking}
              </span>
            )}
          </div>

          {shown.length === 0 ? (
            <EmptyState
              title="No creators match these filters"
              action={
                <button
                  type="button"
                  onClick={() => {
                    setQ("");
                    setUse("all");
                    setLevel("any");
                  }}
                  className={btnClass("outline")}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 xl:grid-cols-4">
              {shown.map((c) => (
                <CreatorCard key={c.address} c={c} saved={saved.includes(c.address)} onSave={() => toggleSave(c.address)} requestHref={requestHref(c.address)} thumbs={thumbsFor(c)} />
              ))}
            </div>
          )}
        </>
      )}
    </AppPage>
  );
}
