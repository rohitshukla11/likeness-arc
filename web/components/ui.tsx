/**
 * Small app primitives, in the Likeness design system (app/globals.css, components/ds). Older pages
 * and panels use these; they render as white cards and pills on the off-white panel.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { explorer } from "@/lib/chain";
import { DEMO_TRUST_LABEL, type LicenceStatus, type Trust } from "@/lib/licensing";
import { LIVENESS_NOTE } from "@/lib/verification";
import { btnClass, StatusPill, type PillKind } from "./ds";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[20px] bg-white p-[18px] text-[14px] text-ink sm:px-5 ${className}`}>{children}</section>;
}

export function H2({ children }: { children: ReactNode }) {
  return <h2 className="m-0 text-[18px] font-bold leading-tight">{children}</h2>;
}

type Tone = "up" | "down" | "warn" | "blue" | "dim";
const pillOf: Record<Tone, PillKind> = { up: "licensed", down: "revoked", warn: "waiting", blue: "waiting", dim: "neutral" };

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <StatusPill kind={pillOf[tone]} title={title}>
      {children}
    </StatusPill>
  );
}

export function TrustBadge({ trust }: { trust: Trust }) {
  if (trust.level === "verified")
    return (
      <span className="inline-flex flex-wrap gap-1.5">
        <StatusPill kind="licensed" title={`Didit: ID 18+, liveness, selfie-to-ID face match. Providers: ${trust.liveness}, ${trust.age}.`}>
          Verified human{trust.sandbox ? " · Didit sandbox" : ""}
        </StatusPill>
        <StatusPill kind={trust.livenessMethod === "passive" || trust.livenessMethod === "unknown" ? "waiting" : "licensed"} title={LIVENESS_NOTE[trust.livenessMethod]}>
          {trust.livenessMethod === "flash" ? "active" : trust.livenessMethod} liveness
        </StatusPill>
      </span>
    );
  if (trust.level === "unverified-test")
    return (
      <StatusPill kind="waiting" title="A throwaway test creator. No liveness or ID check was run.">
        Unverified test creator
      </StatusPill>
    );
  if (trust.level === "demo")
    return (
      <StatusPill kind="waiting" title="A scripted demo creator: a synthetic, non-real face, attested without an ID or liveness check. Not listed in the marketplace.">
        {DEMO_TRUST_LABEL}
      </StatusPill>
    );
  return (
    <StatusPill kind="revoked" title={`Liveness: ${trust.liveness || "none"}. Age: ${trust.age || "none"}.`}>
      Unknown attestation
    </StatusPill>
  );
}

export const STATUS_LABEL: Record<LicenceStatus, string> = { Active: "Licensed", Revoked: "Revoked", Expired: "Expired", Exhausted: "Used up", Unknown: "Unknown" };

export function StatusBadge({ status }: { status: LicenceStatus }) {
  const kind: PillKind = status === "Active" ? "licensed" : status === "Revoked" ? "revoked" : "expired";
  return <StatusPill kind={kind}>{STATUS_LABEL[status]}</StatusPill>;
}

export function Button({
  children,
  onClick,
  disabled,
  kind = "primary",
  type = "button",
  label,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "danger" | "ghost" | "ink";
  type?: "button" | "submit";
  label?: string;
}) {
  const k = ({ primary: "lime", secondary: "outline", danger: "danger", ghost: "ghost", ink: "ink" } as const)[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled} aria-label={label} className={btnClass(k)}>
      {children}
    </button>
  );
}

export function Tx({ hash, ms }: { hash: string; ms?: number }) {
  return (
    <a className="font-mono text-[13px] text-wait underline-offset-2 hover:underline" href={explorer.tx(hash)} target="_blank" rel="noreferrer">
      {hash.slice(0, 10)}…{hash.slice(-6)}
      <span className="sr-only"> (opens Arc Explorer)</span>
      {ms !== undefined && <span className="text-grey"> · confirmed in {ms} ms</span>}
    </a>
  );
}

export function Addr({ a, href }: { a: string; href?: string }) {
  const short = `${a.slice(0, 6)}…${a.slice(-4)}`;
  return href ? (
    <Link href={href} className="tnum font-mono underline-offset-2 hover:underline">
      {short}
    </Link>
  ) : (
    <a href={explorer.address(a)} target="_blank" rel="noreferrer" className="tnum font-mono underline-offset-2 hover:underline">
      {short}
      <span className="sr-only"> (opens Arc Explorer)</span>
    </a>
  );
}

export function Note({ tone = "warn", children }: { tone?: Tone; children: ReactNode }) {
  const c = tone === "warn" || tone === "blue" ? "text-wait" : tone === "down" ? "text-bad" : tone === "up" ? "text-ok" : "text-grey";
  return <p className={`m-0 text-[15px] ${c}`}>{children}</p>;
}

/** A labelled control. `group` is for a set of buttons (chips): a fieldset, so the label never clicks the first one. */
export function Field({ label, children, hint, group }: { label: string; children: ReactNode; hint?: string; group?: boolean }) {
  if (group)
    return (
      <fieldset className="m-0 min-w-0 space-y-1.5 border-0 p-0">
        <legend className="mb-1.5 p-0 text-[14px] font-medium text-grey">{label}</legend>
        {children}
        {hint && <span className="block text-[13px] text-grey">{hint}</span>}
      </fieldset>
    );
  return (
    <label className="block space-y-1.5">
      <span className="text-[14px] font-medium text-grey">{label}</span>
      {children}
      {hint && <span className="block text-[13px] text-grey">{hint}</span>}
    </label>
  );
}

export const inputClass = "w-full min-h-11 rounded-[14px] border border-field bg-white px-4 py-2 text-[15px] text-ink placeholder:text-grey";

export const fmtDate = (unix: number | bigint) => new Date(Number(unix) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export const fmtDay = (unix: number | bigint) =>
  new Date(Number(unix) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
