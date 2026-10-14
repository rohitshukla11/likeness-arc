"use client";

/**
 * Generate under a licence. Shows every check before the button, which renderer and prompt filter
 * will run (and when they are test stand-ins), then renders, embeds the C2PA manifest and pays the
 * creator in one payRender transaction, either delegated (one click) or from the brand's wallet.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { actionMessage } from "@/lib/auth";
import { api, reason, write } from "@/lib/client/tx";
import { categoryLabels } from "@/lib/categories";
import { deployment } from "@/lib/deployment";
import { usdc, type Licence } from "@/lib/licensing";
import { AppPage, btnClass, Card, EmptyState, ErrorCard, NoticePage, Skeleton } from "@/components/ds";
import { IconCheck, IconCross } from "@/components/ds/icons";
import { Badge, Field, Note, StatusBadge, Tx, inputClass } from "@/components/ui";
import { useWallet } from "@/components/wallet/WalletProvider";

type Json<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };
type Row = Json<Licence> & { escrow: { balance: string } };
type Pre = {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  release: { released: boolean };
  renderer: { primary: string; test: boolean };
  llmFilter: string;
  delegation: { provider: string; capUsdc: string; spentUsdc: string; ready: boolean } | null;
  c2pa: string;
};
type Result = {
  record: {
    assetHash: Hex;
    licenceId: string;
    renderIndex: number;
    provider: string;
    model: string;
    test: boolean;
    tx?: Hex;
    gasUsed?: string;
    confirmMs?: number;
    paidBy?: string;
    download?: string;
    filter: { layers: { name: string; ran: boolean; note?: string }[] };
  };
  authorisation?: { licenceId: string; assetHash: Hex; agent: Hex; deadline: string; agentSig: Hex; renderIndex: number };
  attempts?: string[];
};

async function sha256Hex(text: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A generic starting prompt (no brand or product names); the brand edits it before generating. */
const DEFAULT_PROMPT = "Smiling in a sunlit café holding a ceramic coffee cup, product shot for a spring campaign";

export default function GeneratePage() {
  return (
    <Suspense>
      <Generate />
    </Suspense>
  );
}

function Generate() {
  const { wallet } = useWallet();
  const params = useSearchParams();
  const [licences, setLicences] = useState<Row[]>([]);
  const [id, setId] = useState<string>(params.get("licence") ?? "");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [pre, setPre] = useState<Pre | null>(null);
  const [mode, setMode] = useState<"delegated" | "wallet">("delegated");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<React.ReactNode>(null);
  const [result, setResult] = useState<Result | null>(null);

  // A failed load is shown as such (with Retry), never as "no licence".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!wallet) return;
    setLoadError(null);
    api<{ licences: Row[] }>(`/api/licences?licensee=${wallet.address}`)
      .then((j) => {
        setLicences(j.licences);
        if (!id && j.licences.find((l) => l.status === "Active")) setId(j.licences.find((l) => l.status === "Active")!.id);
      })
      .catch((e) => setLoadError(reason(e)));
  }, [wallet, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = useCallback(
    async (withPrompt: boolean) => {
      if (!wallet || !id) return;
      const p = await api<Pre>("/api/generate/preflight", { method: "POST", body: JSON.stringify({ licenceId: id, licensee: wallet.address, prompt: withPrompt ? prompt : undefined }) });
      setPre(p);
      setMode(p.delegation?.ready ? "delegated" : "wallet");
      return p;
    },
    [wallet, id, prompt],
  );
  useEffect(() => {
    check(false).catch((e) => setError(reason(e)));
  }, [wallet, id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStep("Checking the prompt…");
      const p = await check(true);
      if (!p?.ok) throw new Error("A check failed; see the list.");
      setStep("Sign the render request in your wallet…");
      const message = actionMessage("render", { licence: id, "prompt sha256": await sha256Hex(prompt), mode });
      const auth = { message, signature: await wallet.client.signMessage({ account: wallet.client.account, message }) };
      setStep(mode === "delegated" ? "Rendering, signing the manifest, paying the creator…" : "Rendering and signing the manifest…");
      const r = await fetch("/api/generate", { method: "POST", body: JSON.stringify({ licenceId: id, prompt, mode, auth }), headers: { "content-type": "application/json" } });
      const j = await r.json();
      if (!r.ok) {
        const failed = (j.details?.checks as Pre["checks"] | undefined)?.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
        throw new Error(failed?.length ? failed.join(" · ") : j.error);
      }
      let res = j as Result;
      if (mode === "wallet" && res.authorisation) {
        const a = res.authorisation;
        setStep("Confirm payRender in your wallet: it pays the creator and anchors the receipt…");
        const sent = await write(wallet, {
          address: deployment.LicenseEscrow!,
          abi: LicenseEscrowAbi,
          functionName: "payRender",
          args: [BigInt(a.licenceId), a.assetHash, a.agent, BigInt(a.deadline), a.agentSig],
        });
        const record = await api<Result["record"]>(`/api/renders/${a.assetHash}/claim`, { method: "POST", body: JSON.stringify({ tx: sent.hash }) });
        res = { ...res, record: { ...record, tx: sent.hash, confirmMs: sent.ms, gasUsed: sent.receipt.gasUsed.toString() } };
      }
      setResult(res);
      setStep(null);
      setReload((n) => n + 1);
      await check(false);
    } catch (e) {
      setError(reason(e));
      setStep(null);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet)
    return (
      <NoticePage
        title="Generate"
        description="Render under a licence. Each render pays the creator and anchors a receipt on Arc."
        action={
          <Link href="/onboard" className={btnClass("ink")}>
            Sign in
          </Link>
        }
      />
    );

  const active = licences.filter((l) => l.status === "Active");
  const selected = licences.find((l) => l.id === id);
  const left = selected ? selected.renderCap - selected.renderCount : 0;

  return (
    <AppPage
      title="Generate"
      description="Render under a licence. Each render pays the creator and anchors a receipt on Arc."
      actions={
        <Link href="/dashboard" className={btnClass("outline")}>
          Your licences
        </Link>
      }
    >
      {loadError && (
        <ErrorCard
          action={
            <button type="button" onClick={() => setReload((n) => n + 1)} className={btnClass("outline")}>
              Retry
            </button>
          }
        >
          Couldn&apos;t load your licences: {loadError}
        </ErrorCard>
      )}
      {!loadError && active.length === 0 && (
        <EmptyState
          title="No active licence for this wallet"
          action={
            <Link href="/market" className={btnClass("ink")}>
              Find a creator
            </Link>
          }
        >
          Request a licence from a creator in the marketplace, fund its escrow, then come back here.
        </EmptyState>
      )}
      {active.length > 0 && (
        <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-[18px]">
            <Card title="Brief">
              <Field label="Licence">
                <select className={inputClass} value={id} onChange={(e) => setId(e.target.value)}>
                  {active.map((l) => (
                    <option key={l.id} value={l.id}>
                      #{l.id} · {categoryLabels(l.category).join()} · {l.renderCount}/{l.renderCap} renders · ${usdc.format(BigInt(l.pricePerRender))} each
                    </option>
                  ))}
                </select>
              </Field>
              {selected && (
                <p className="m-0 text-[13px] text-grey">
                  {left} of {selected.renderCap} renders left · ${usdc.format(BigInt(selected.escrow.balance))} in escrow
                </p>
              )}
              <Field label="Prompt" hint="Banned everywhere: political, adult, minors, impersonation, deception.">
                <textarea className={`${inputClass} min-h-32 rounded-[14px] py-3`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={DEFAULT_PROMPT} />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={btnClass("lime")} disabled={busy || !id || prompt.trim().length < 3} onClick={go}>
                  Generate{selected ? ` · $${usdc.format(BigInt(selected.pricePerRender))}` : ""}
                </button>
                {step && (
                  <span role="status" className="text-[14px] text-wait">
                    {step}
                  </span>
                )}
              </div>
              {error && <Note tone="down">{error}</Note>}
              {selected && selected.status !== "Active" && <StatusBadge status={selected.status} />}
            </Card>
            {result && <RenderResult result={result} c2pa={pre?.c2pa ?? null} />}
          </div>

          {selected && pre ? (
            <Card tone="ink" title="Before you render" label="Checks">
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[14px]">
                {pre.checks.map((c) => (
                  <Check key={c.name} ok={c.ok} name={c.name} detail={c.detail} />
                ))}
                <Check
                  ok={pre.release.released}
                  name="Reference photos released by the creator"
                  detail={pre.release.released ? undefined : "the creator must release them from their dashboard (keys live only in this server's memory)"}
                />
              </ul>
              <dl className="m-0 grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-ink-line pt-3 text-[13px]">
                <dt className="text-grey-dark">Renderer</dt>
                <dd className="m-0 min-w-0 break-words">{pre.renderer.test ? <Badge tone="warn">TEST RENDER (no model key)</Badge> : pre.renderer.primary}</dd>
                <dt className="text-grey-dark">Prompt filter</dt>
                <dd className="m-0 min-w-0 break-words">{pre.llmFilter.startsWith("LLM filter not configured") ? <Badge tone="warn">{pre.llmFilter}</Badge> : pre.llmFilter}</dd>
                <dt className="text-grey-dark">C2PA</dt>
                <dd className="m-0">{pre.c2pa === "test certificate" ? <Badge tone="warn">TEST certificate</Badge> : <Badge tone="down">missing</Badge>}</dd>
                <dt>
                  <label htmlFor="pay-mode" className="text-grey-dark">
                    Payment
                  </label>
                </dt>
                <dd className="m-0 min-w-0">
                  <select id="pay-mode" className="min-h-11 w-full rounded-[12px] border-0 bg-white px-2.5 text-[13px] text-ink" value={mode} onChange={(e) => setMode(e.target.value as "delegated" | "wallet")}>
                    <option value="delegated" disabled={!pre.delegation?.ready}>
                      Delegated, one click{pre.delegation ? ` (${pre.delegation.provider === "dev-local" ? "DEV delegation" : "Dynamic"})` : " (not set up)"}
                    </option>
                    <option value="wallet">Confirm payRender in my wallet</option>
                  </select>
                </dd>
              </dl>
            </Card>
          ) : (
            <Skeleton className="h-80" />
          )}
        </div>
      )}
    </AppPage>
  );
}

function Check({ ok, name, detail }: { ok: boolean; name: string; detail?: string }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? "bg-lime text-ink" : "bg-coral text-ink"}`}>
        {ok ? <IconCheck size={12} /> : <IconCross size={12} />}
      </span>
      <span className="min-w-0">
        <span className="sr-only">{ok ? "Passed: " : "Not passed: "}</span>
        {name}
        {detail && <span className="block break-words text-[12px] text-grey-dark">{detail}</span>}
      </span>
    </li>
  );
}

function RenderResult({ result: { record: r, attempts }, c2pa }: { result: Result; c2pa: string | null }) {
  return (
    <Card label="Your render" title={`Licence #${r.licenceId}, render ${r.renderIndex}`} action={r.test ? <Badge tone="warn">TEST RENDER</Badge> : undefined}>
      {r.download ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.download} alt={`Render ${r.renderIndex} under licence ${r.licenceId}`} className="w-full rounded-[14px] bg-paper" />
      ) : (
        <Note>File held until payment is on chain.</Note>
      )}
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
        <span className="font-semibold">Render {r.renderIndex}</span>
        <span aria-hidden="true">·</span>
        {r.tx ? (
          <span>
            payRender <Tx hash={r.tx} ms={r.confirmMs} />
          </span>
        ) : (
          <span className="text-grey">payment not on chain yet</span>
        )}
        {c2pa && c2pa !== "missing" && (
          <>
            <span aria-hidden="true">·</span>
            <span>C2PA attached{c2pa === "test certificate" ? " (test certificate)" : ""}</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {r.download && (
          <a className={btnClass("lime")} href={r.download} download>
            Download
          </a>
        )}
        <Link className={btnClass("outline")} href={`/verify?hash=${r.assetHash}`}>
          Verify this file
        </Link>
      </div>
      <details className="text-[13px] [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center font-semibold">More about this render ▾</summary>
        <dl className="m-0 grid grid-cols-[7rem_minmax(0,1fr)] gap-y-1.5">
          <dt className="text-grey">Renderer</dt>
          <dd className="m-0">
            {r.provider} · {r.model}
          </dd>
          <dt className="text-grey">Asset hash</dt>
          <dd className="m-0 break-all font-mono text-[12px]">{r.assetHash}</dd>
          <dt className="text-grey">Gas used</dt>
          <dd className="tnum m-0">{r.gasUsed ?? "—"}</dd>
          <dt className="text-grey">Paid by</dt>
          <dd className="m-0">{r.paidBy ?? "—"}</dd>
          <dt className="text-grey">Filter</dt>
          <dd className="m-0">{r.filter.layers.map((l) => (l.ran ? l.name : l.note)).join(" · ")}</dd>
        </dl>
        {attempts && attempts.length > 1 && <p className="m-0 mt-2 text-grey">Renderer attempts: {attempts.join(" → ")}</p>}
      </details>
    </Card>
  );
}
