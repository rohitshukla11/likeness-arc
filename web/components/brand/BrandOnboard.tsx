"use client";

/**
 * Brand onboarding in three steps, under one progress bar:
 *   1. Sign in: email through Dynamic; the wallet is created automatically and gas arrives in the background.
 *   2. Your company: name, website, work email, optional logo, intended uses and expected volume. The
 *      domain check proves the work email (the Dynamic sign-in email, or a code sent to it); the badge
 *      "Verified domain" is computed by the server, only when that email's domain matches the website.
 *   3. Agree and fund: the brand policy, signed by the wallet; then the USDC balance and how to fund it.
 * Where the brand is comes from the server, so a refresh resumes at the right step.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, erc20Abi, formatEther, formatUnits, http, type Hex } from "viem";
import { actionMessage } from "@/lib/auth";
import {
  BADGE_LABEL,
  BRAND_POLICY_POINTS,
  BRAND_POLICY_VERSION,
  BRAND_USES,
  FREE_EMAIL_DOMAINS,
  MONTHLY_RENDERS,
  brandPolicyHash,
  brandProfileFields,
  emailDomain,
  emailMatchesWebsite,
  websiteDomain,
} from "@/lib/brand-policy";
import { explorer, arcMainnet, USDC } from "@/lib/chain";
import { api, reason } from "@/lib/client/tx";
import { sha256Hex } from "@/lib/crypto/envelope";
import { dynamicSessionToken, useDynamicState } from "@/app/providers";
import { Details, pillClass, StatusPill } from "@/components/ds";
import { IconCheck } from "@/components/ds/icons";
import { Note, Tx, inputClass } from "@/components/ui";
import { Progress, SignIn } from "@/components/onboard/OnboardFlow";
import { useWallet, type ActiveWallet } from "@/components/wallet/WalletProvider";

const pub = createPublicClient({ chain: arcMainnet, transport: http() });
const STEPS = ["Sign in", "Your company", "Agree and fund"] as const;

type Brand = { name: string; website: string; workEmailDomain: string | null; badge: "verified-domain" | "unverified"; uses: string[]; monthlyRenders: string; logo: string | null; policySigned: boolean };
type Proof = { emailDomain: string; method: "dynamic-signin" | "email-code" } | null;

export function BrandOnboard() {
  const { wallet } = useWallet();
  const dynamic = useDynamicState();
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [brand, setBrand] = useState<Brand | null | undefined>(undefined);
  const [complete, setComplete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dripTx, setDripTx] = useState<Hex | null>(null);
  const [dripError, setDripError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wallet) return;
    const r = await api<{ brand: Brand | null; complete: boolean }>(`/api/brands?address=${wallet.address}`);
    setBrand(r.brand);
    setComplete(r.complete);
  }, [wallet]);
  useEffect(() => {
    setBrand(undefined);
    load().catch(() => setBrand(null));
  }, [load]);

  // USDC for gas, once, in the background, for a new empty email wallet (same limits as for creators).
  const dripped = useRef<string | null>(null);
  const drip = useCallback(async (address: `0x${string}`) => {
    setDripError(null);
    try {
      if ((await pub.getBalance({ address })) > 0n) return;
      const r = await fetch("/api/drip", { method: "POST", body: JSON.stringify({ address }) });
      const j = (await r.json()) as { hash?: Hex; error?: string };
      if (!r.ok || !j.hash) throw new Error(j.error ?? `drip failed (${r.status})`);
      setDripTx(j.hash);
    } catch (e) {
      setDripError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (!wallet || wallet.kind === "dev" || dripped.current === wallet.address) return;
    dripped.current = wallet.address;
    void drip(wallet.address);
  }, [wallet, drip]);

  const step = !wallet ? 1 : brand === undefined ? null : !brand || editing ? 2 : 3;

  return (
    <div className="flex flex-col gap-[18px]">
      <Progress step={complete && step === 3 ? 4 : (step ?? 2)} steps={STEPS} />
      <section aria-live="polite" className="rounded-[20px] bg-white p-5 sm:p-6">
        {step === null && (
          <p role="status" className="m-0 text-[16px] text-grey">
            Picking up where you left off…
          </p>
        )}
        {step === 1 &&
          (dynamic === "ready" ? (
            <SignIn />
          ) : (
            <Note>{dynamic === "off" ? "Sign-in is off on this server (NEXT_PUBLIC_DYNAMIC_ENV_ID)." : "Loading sign-in…"}</Note>
          ))}
        {step === 2 && wallet && (
          <CompanyStep
            wallet={wallet}
            initial={brand ?? null}
            onSaved={async () => {
              setEditing(false);
              await load();
            }}
          />
        )}
        {step === 3 && wallet && brand && (
          <AgreeAndFund
            wallet={wallet}
            brand={brand}
            complete={complete}
            next={next}
            onEdit={() => setEditing(true)}
            onSigned={async () => {
              await load();
            }}
            onDone={() => router.push(next && next.startsWith("/") ? next : "/dashboard")}
          />
        )}
      </section>
      {dripError && wallet && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-[15px] text-bad">
          We couldn&apos;t send your wallet gas ({dripError}).
          <button type="button" onClick={() => void drip(wallet.address)} className={pillClass("outline", "min-h-11 px-4 text-[14px]")}>
            Retry
          </button>
        </p>
      )}
      <Details summary="Details">
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
          <dt className="text-grey">Wallet</dt>
          <dd className="m-0 break-all font-mono text-[13px]">{wallet ? wallet.address : "not signed in"}</dd>
          <dt className="text-grey">Gas drip</dt>
          <dd className="m-0">{dripTx ? <Tx hash={dripTx} /> : dripError ? `failed: ${dripError}` : "—"}</dd>
          <dt className="text-grey">Policy version</dt>
          <dd className="m-0">{BRAND_POLICY_VERSION}</dd>
          <dt className="text-grey">Business verification</dt>
          <dd className="m-0">KYB (Didit) is not run yet; no badge claims it.</dd>
        </dl>
      </Details>
    </div>
  );
}

// ---------------------------------------------------------------- 2. your company

async function shrinkLogo(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("logo could not be read"))), "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(""));
}

function CompanyStep({ wallet, initial, onSaved }: { wallet: ActiveWallet; initial: Brand | null; onSaved: () => Promise<void> }) {
  const dynamic = useDynamicState();
  const [name, setName] = useState(initial?.name ?? "");
  const [website, setWebsite] = useState(initial?.website ?? "");
  const [email, setEmail] = useState("");
  const [uses, setUses] = useState<string[]>(initial?.uses ?? []);
  const [monthly, setMonthly] = useState(initial?.monthlyRenders ?? MONTHLY_RENDERS[0]);
  const [logo, setLogo] = useState<string | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(initial?.logo ?? null);
  const [proof, setProof] = useState<Proof>(null);
  const [codes, setCodes] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ proof: Proof; codes: boolean }>(`/api/brands/email?address=${wallet.address}`)
      .then((r) => {
        setProof(r.proof);
        setCodes(r.codes);
      })
      .catch(() => {});
  }, [wallet.address]);

  const sign = async (action: string, fields: Record<string, string>) => {
    const message = actionMessage(action, fields);
    return { message, signature: await wallet.client.signMessage({ account: wallet.client.account, message }) };
  };

  async function proveWithSignIn() {
    setBusy(true);
    setError(null);
    try {
      const token = dynamicSessionToken();
      if (!token) throw new Error("no Dynamic sign-in session in this browser; sign in with your work email first");
      setProof(await api<Proof>("/api/brands/email", { method: "POST", body: JSON.stringify({ address: wallet.address, step: "dynamic", token }) }));
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  }
  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const auth = await sign("verify work email", { wallet: wallet.address.toLowerCase(), email: email.trim().toLowerCase() });
      await api("/api/brands/email", { method: "POST", body: JSON.stringify({ address: wallet.address, step: "send", email: email.trim(), auth }) });
      setCodeSent(true);
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirmCode() {
    setBusy(true);
    setError(null);
    try {
      setProof(await api<Proof>("/api/brands/email", { method: "POST", body: JSON.stringify({ address: wallet.address, step: "confirm", code }) }));
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const logoSha = logo ? await sha256Hex(Uint8Array.from(atob(logo), (c) => c.charCodeAt(0))) : null;
      const fields = brandProfileFields({ name: name.trim(), website: website.trim(), uses, monthlyRenders: monthly, logoSha256: logoSha });
      const auth = await sign("save brand profile", { wallet: wallet.address.toLowerCase(), ...fields });
      await api("/api/brands", { method: "POST", body: JSON.stringify({ address: wallet.address, auth, name: name.trim(), website: website.trim(), uses, monthlyRenders: monthly, logo }) });
      await onSaved();
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  }

  const site = websiteDomain(website);
  const typedDomain = emailDomain(email);
  const free = !!typedDomain && FREE_EMAIL_DOMAINS.has(typedDomain);
  const proofMatches = !!proof && emailMatchesWebsite(`x@${proof.emailDomain}`, website);
  const badge = proofMatches ? "verified-domain" : "unverified";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[18px] font-bold">Your company</h2>
        <p className="m-0 max-w-2xl text-[15px] text-grey">Creators see your name, logo and badge before they approve a licence.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-grey">Company name</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" placeholder="Brew & Co." />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-grey">Website</span>
          <input className={inputClass} value={website} onChange={(e) => setWebsite(e.target.value)} inputMode="url" autoComplete="url" placeholder="brewandco.example" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-grey">Work email</span>
          <input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" placeholder="you@brewandco.example" />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-grey">Logo (optional)</span>
          <div className="flex items-center gap-3">
            {logoPreview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoPreview} alt="Your logo" width={44} height={44} className="h-11 w-11 rounded-lg border border-field bg-white object-contain" />
            )}
            <label className={pillClass("outline", "cursor-pointer")}>
              Choose a file
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const b64 = await shrinkLogo(f);
                  setLogo(b64);
                  setLogoPreview(`data:image/png;base64,${b64}`);
                }}
              />
            </label>
          </div>
        </div>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-[14px] font-medium text-grey">Intended uses</legend>
        <div className="flex flex-wrap gap-2">
          {BRAND_USES.map((u) => {
            const on = uses.includes(u);
            return (
              <button
                key={u}
                type="button"
                aria-pressed={on}
                onClick={() => setUses(on ? uses.filter((x) => x !== u) : [...uses, u])}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 text-[14px] font-semibold ${on ? "border-ink bg-ink text-lime" : "border-field bg-white text-ink hover:border-grey"}`}
              >
                {u}
              </button>
            );
          })}
        </div>
      </fieldset>
      <label className="flex max-w-xs flex-col gap-1.5">
        <span className="text-[14px] font-medium text-grey">Expected renders a month</span>
        <select className={inputClass} value={monthly} onChange={(e) => setMonthly(e.target.value)}>
          {MONTHLY_RENDERS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>

      <section aria-labelledby="domain-title" className="flex flex-col gap-3 rounded-[20px] border border-field p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="domain-title" className="m-0 text-[17px] font-semibold">
            Domain check
          </h3>
          <StatusPill kind={badge === "verified-domain" ? "licensed" : "waiting"}>{BADGE_LABEL[badge]}</StatusPill>
        </div>
        {proof ? (
          <p className="m-0 flex flex-wrap items-center gap-2 text-[15px]">
            <IconCheck size={16} stroke="#3B6E25" /> You proved an email at <b>{proof.emailDomain}</b> ({proof.method === "dynamic-signin" ? "your sign-in" : "emailed code"}).{" "}
            {site ? (proofMatches ? `It matches ${site}.` : `It does not match ${site}, so you show as an unverified brand.`) : "Add your website to compare."}
          </p>
        ) : (
          <p className="m-0 text-[15px] text-grey">Prove your work email to show as a verified domain. Free email domains (Gmail and others) are fine, but show as an unverified brand.</p>
        )}
        {free && <p className="m-0 text-[14px] text-wait">{typedDomain} is a free email domain: you can continue, as an unverified brand.</p>}
        <div className="flex flex-wrap gap-3">
          {dynamic === "ready" && wallet.kind === "dynamic" && (
            <button type="button" onClick={proveWithSignIn} disabled={busy} className={pillClass("outline")}>
              Use my sign-in email
            </button>
          )}
          {codes ? (
            !codeSent ? (
              <button type="button" onClick={sendCode} disabled={busy || !typedDomain} className={pillClass("outline")}>
                Email me a code
              </button>
            ) : (
              <span className="flex flex-wrap gap-2">
                <label htmlFor="work-code" className="sr-only">
                  Code from the email
                </label>
                <input id="work-code" className={`${inputClass} tnum max-w-[10rem]`} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
                <button type="button" onClick={confirmCode} disabled={busy || code.trim().length !== 6} className={pillClass("ink")}>
                  Confirm
                </button>
              </span>
            )
          ) : (
            <p className="m-0 text-[13px] text-grey">Email codes aren&apos;t set up on this server, so a different work email can&apos;t be checked here. Sign in with your work email to verify your domain.</p>
          )}
        </div>
        <p className="m-0 text-[13px] text-grey">Business verification (KYB with Didit) is planned. It is not checked yet, and no badge claims it.</p>
      </section>

      <button type="button" onClick={save} disabled={busy || name.trim().length < 2 || !site || uses.length === 0} className={pillClass("ink", "self-start")}>
        {busy ? "Saving…" : "Save and continue"}
      </button>
      <p className="m-0 text-[13px] text-grey">Your wallet signs these details.</p>
      {error && <Note tone="down">{error}</Note>}
    </div>
  );
}

// ---------------------------------------------------------------- 3. agree and fund

function AgreeAndFund({
  wallet,
  brand,
  complete,
  next,
  onEdit,
  onSigned,
  onDone,
}: {
  wallet: ActiveWallet;
  brand: Brand;
  complete: boolean;
  next: string | null;
  onEdit: () => void;
  onSigned: () => Promise<void>;
  onDone: () => void;
}) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [gas, setGas] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const [u, m] = await Promise.all([
      pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] }),
      pub.getBalance({ address: wallet.address }),
    ]);
    setUsdc(u);
    setGas(formatEther(m));
  }, [wallet.address]);
  useEffect(() => {
    refresh().catch(() => {});
    const t = setInterval(() => refresh().catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function signPolicy() {
    setBusy(true);
    setError(null);
    try {
      const message = actionMessage("agree to the brand policy", { wallet: wallet.address.toLowerCase(), version: BRAND_POLICY_VERSION, "text sha256": await brandPolicyHash() });
      const signature = await wallet.client.signMessage({ account: wallet.client.account, message });
      await api("/api/brands/policy", { method: "POST", body: JSON.stringify({ address: wallet.address, auth: { message, signature } }) });
      await onSigned();
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {brand.logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logo} alt="" width={40} height={40} className="h-10 w-10 rounded-lg border border-field bg-white object-contain" />
        )}
        <b className="text-[17px]">{brand.name}</b>
        <StatusPill kind={brand.badge === "verified-domain" ? "licensed" : "waiting"}>{BADGE_LABEL[brand.badge]}</StatusPill>
        <button type="button" onClick={onEdit} className="min-h-11 text-[14px] font-semibold text-wait underline">
          Edit details
        </button>
      </div>

      <section aria-labelledby="policy-title" className="flex flex-col gap-3">
        <h2 id="policy-title" className="m-0 text-[18px] font-bold">
          Brand policy
        </h2>
        <ol className="m-0 max-w-3xl list-decimal space-y-2 pl-5 text-[15px] text-[#3E4148]">
          {BRAND_POLICY_POINTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
        {complete ? (
          <p className="m-0 flex items-center gap-2 text-[15px] text-ok">
            <IconCheck size={16} /> Signed by your wallet (version {BRAND_POLICY_VERSION}).
          </p>
        ) : (
          <>
            <label className="flex min-h-11 items-start gap-3 text-[15px]">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#121316]" />
              <span>We agree to the Likeness brand policy above.</span>
            </label>
            <button type="button" onClick={signPolicy} disabled={!agree || busy} className={pillClass("ink", "self-start")}>
              {busy ? "Signing…" : "Agree and sign"}
            </button>
          </>
        )}
      </section>

      <section aria-labelledby="fund-title" className="flex flex-col gap-3 rounded-[20px] bg-paper p-5">
        <h2 id="fund-title" className="m-0 text-[17px] font-semibold">
          Fund your wallet
        </h2>
        <p className="m-0 text-[15px] text-grey">Licences are paid per render from USDC you deposit into escrow.</p>
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 text-[15px] sm:grid-cols-[8rem_1fr]">
          <dt className="text-grey">USDC</dt>
          <dd className="tnum m-0 text-[20px] font-bold">{usdc === null ? "…" : formatUnits(usdc, 6)}</dd>
          <dt className="text-grey">USDC (gas)</dt>
          <dd className="tnum m-0">{gas ?? "…"}</dd>
          <dt className="text-grey">Your address</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2">
            <a href={explorer.address(wallet.address)} target="_blank" rel="noreferrer" className="break-all font-mono text-[13px]">
              {wallet.address}
              <span className="sr-only"> (opens Arc Explorer)</span>
            </a>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(wallet.address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className={pillClass("outline", "min-h-11 px-4 text-[13px]")}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </dd>
        </dl>
        <p className="m-0 text-[13px] text-grey">
          Send USDC on Arc mainnet to this address from a wallet or exchange that supports Arc, or bridge it from another chain with Circle&apos;s
          CCTP (
          <a href="https://docs.arc.io/integrate/exchanges/cctp-bridging" target="_blank" rel="noreferrer" className="underline">
            how<span className="sr-only"> (opens docs.arc.io)</span>
          </a>
          ). On Arc, USDC also pays gas: one balance covers both. Keep it small: deposits are capped at 2 USDC per licence here. The balance
          above updates by itself.
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={onDone} disabled={!complete} className={pillClass("ink")}>
          {next ? "Back to the creator" : "Go to my dashboard"}
        </button>
        <Link href="/market" className={pillClass("outline")}>
          Browse creators
        </Link>
      </div>
      {error && <Note tone="down">{error}</Note>}
    </div>
  );
}
