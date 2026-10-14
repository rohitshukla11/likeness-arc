"use client";

/**
 * A creator's terms: allowed uses, regions, price per render, maximum duration and renders, and
 * whether requests inside these terms are approved automatically. Banned uses are shown locked: the
 * contract rejects them for every licence, whatever is set here.
 */
import { useState } from "react";
import { ALL_REGIONS, BANNED, CATEGORIES, REGIONS, isAllowedSet } from "@/lib/categories";
import { usdc, type Terms } from "@/lib/licensing";
import { Button, Field, inputClass } from "./ui";

/** A new creator's terms: Advertising and Social, worldwide, 0.10 USDC, 10 renders, 7 days, ask me each time. */
export const STARTER_TERMS: Terms = {
  categories: (1 << 8) | (1 << 9),
  regions: ALL_REGIONS,
  maxDuration: BigInt(7 * 86_400),
  maxRenders: 10,
  pricePerRender: 100_000n, // 0.10 USDC: small mainnet defaults
  autoApprove: false,
};

export function validateTerms(t: Terms): string | null {
  if (!isAllowedSet(t.categories)) return "pick at least one allowed use";
  if (!t.regions) return "pick at least one region";
  if (t.maxDuration < 86_400n || t.maxDuration > 365n * 86_400n) return "maximum duration must be 1 to 365 days";
  if (t.maxRenders < 1) return "allow at least one render per licence";
  if (t.pricePerRender <= 0n) return "price must be above zero";
  return null;
}

export function TermsEditor({
  initial,
  submitLabel,
  onSubmit,
  busy,
}: {
  initial: Terms;
  submitLabel: string;
  onSubmit: (t: Terms) => void;
  busy?: boolean;
}) {
  const [t, setT] = useState<Terms>(initial);
  const [price, setPrice] = useState(usdc.format(initial.pricePerRender));
  const [error, setError] = useState<string | null>(null);
  const toggle = (field: "categories" | "regions", bit: number) => setT((x) => ({ ...x, [field]: x[field] ^ bit }));

  function submit() {
    let next: Terms;
    try {
      next = { ...t, pricePerRender: usdc.parse(price) };
    } catch {
      return setError("price must be a USDC amount, e.g. 2.50");
    }
    const problem = validateTerms(next);
    setError(problem);
    if (!problem) onSubmit(next);
  }

  return (
    <div className="space-y-6">
      <Field label="Allowed uses" group>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <Chip key={c.key} on={!!(t.categories & c.bit)} onClick={() => toggle("categories", c.bit)}>
              {c.label}
            </Chip>
          ))}
          {BANNED.map((c) => (
            <span key={c.key} title="Banned on chain for every licence" className="inline-flex min-h-11 items-center rounded-full border border-divider px-4 text-[13px] text-grey line-through">
              {c.label}
            </span>
          ))}
        </div>
      </Field>
      <Field label="Regions" group>
        <div className="flex flex-wrap gap-2">
          {REGIONS.map((r) => (
            <Chip key={r.key} on={!!(t.regions & r.bit)} onClick={() => toggle("regions", r.bit)}>
              {r.label}
            </Chip>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Price per render (USDC)">
          <input className={inputClass} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Max licence length (days)">
          <input
            className={inputClass}
            type="number"
            min={1}
            max={365}
            value={Number(t.maxDuration / 86_400n)}
            onChange={(e) => setT({ ...t, maxDuration: BigInt(Math.max(0, Math.floor(Number(e.target.value)))) * 86_400n })}
          />
        </Field>
        <Field label="Max renders per licence">
          <input className={inputClass} type="number" min={1} value={t.maxRenders} onChange={(e) => setT({ ...t, maxRenders: Math.max(0, Math.floor(Number(e.target.value))) })} />
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" className="h-5 w-5 accent-[#121316]" checked={t.autoApprove} onChange={(e) => setT({ ...t, autoApprove: e.target.checked })} />
        <span>Approve requests inside these terms automatically</span>
      </label>
      <p className="m-0 text-[13px] text-grey">Requests outside these terms always come to you to sign. You can revoke any licence in one click.</p>
      <div className="flex flex-wrap items-center gap-4">
        <Button kind="ink" onClick={submit} disabled={busy}>
          {submitLabel}
        </Button>
        {error && <span role="alert" className="text-[15px] text-bad">{error}</span>}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex min-h-11 items-center rounded-full border px-4 text-[14px] font-semibold ${on ? "border-ink bg-ink text-lime" : "border-field bg-white text-ink hover:border-grey"}`}
    >
      {children}
    </button>
  );
}
