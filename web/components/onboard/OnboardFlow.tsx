"use client";

/**
 * Creator onboarding in three steps, under one progress bar:
 *   1. Sign in: email through Dynamic; the embedded wallet is created once the code is verified, and
 *      A little USDC for gas is topped up in the background (nothing is shown unless that fails).
 *   2. Verify it's you: one screen with the consent and "Agree and verify", which signs the consent
 *      with the wallet and starts the Didit session; the server reads Didit's decision.
 *   3. Protect your photos: three guided photos, each matched to the liveness selfie, then "Protect
 *      with Face ID and register": passkey, encryption in this browser, ciphertext upload,
 *      attestation, CreatorRegistry.register with the starter terms.
 * Where the creator is comes from the server and the chain, so a refresh resumes at the right step.
 * Everything technical sits in the collapsed Details panel.
 */
import { isMeraError } from "@category-labs/mera";
import {
  useCreateWaasWalletAccounts,
  useGetWalletAccounts,
  useLogout,
  useSendEmailOTP,
  useUser,
  useVerifyOTP,
} from "@dynamic-labs-sdk/react-hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { actionMessage } from "@/lib/auth";
import { categoryLabels } from "@/lib/categories";
import { explorer, arcMainnet } from "@/lib/chain";
import { api, reason, write } from "@/lib/client/tx";
import { CONSENT_POINTS, CONSENT_VERSION, DIDIT_LINKS, consentTextHash } from "@/lib/consent";
import { referenceSetHash, sealReferenceSet, sha256Hex, type ReferenceSet } from "@/lib/crypto/envelope";
import { createPasskey, namespaceKey } from "@/lib/crypto/passkey";
import { vaultId, vaultPut } from "@/lib/crypto/vault";
import { deployment } from "@/lib/deployment";
import { diditFailure } from "@/lib/didit-messages";
import { formatDuration, usdc } from "@/lib/licensing";
import { useDynamicState } from "@/app/providers";
import { CreatorFace, Details, pillClass } from "@/components/ds";
import { PublicPhotoPicker } from "@/components/profile/PublicPhotoPicker";
import { IconCheck, IconShield, VerifiedMark } from "@/components/ds/icons";
import { KeysPanel } from "@/components/KeysPanel";
import { STARTER_TERMS } from "@/components/TermsEditor";
import { Note, Tx, fmtDate, inputClass, shortAddr } from "@/components/ui";
import { useWallet, type ActiveWallet } from "@/components/wallet/WalletProvider";
import { CaptureStep, type PhotoState } from "./CaptureStep";

const pub = createPublicClient({ chain: arcMainnet, transport: http() });

/** Set when this tab registers the wallet, so a refresh of the done screen stays on it. */
const DONE_KEY = "likeness:onboard:done";
/** Remembers that this browser created a Likeness passkey for this wallet, so it is reused. */
const passkeyKey = (address: string) => `likeness:passkey:${address.toLowerCase()}`;

type Didit = {
  state: "none" | "pending" | "approved" | "declined";
  level?: "free" | "full";
  sessionStatus?: string;
  reasons?: string[];
  environment?: string;
  checks?: { livenessMethod?: string } | null;
};
type Attested = { provider: string; liveness: string; level: string };
type Facts = {
  balance?: string;
  dripTx?: string;
  fingerprint?: string;
  attested?: Attested;
  registerTx?: string;
  registerMs?: number;
  registeredAt?: number;
  /** "passive" or "active", from the attestation. */
  liveness?: string;
};

const storage = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  },
};

export function OnboardFlow() {
  const { wallet } = useWallet();
  const dynamic = useDynamicState();
  const router = useRouter();
  const [facts, setFacts] = useState<Facts>({});
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [consented, setConsented] = useState<boolean | null>(null);
  const [didit, setDidit] = useState<Didit | null>(null);
  const [dripError, setDripError] = useState<string | null>(null);
  const [photoStep, setPhotoStep] = useState<{ photos: Uint8Array[]; set: ReferenceSet; hash?: Hex } | null>(null);
  const [publicPhoto, setPublicPhoto] = useState<string | null>(null);
  useEffect(() => {
    if (!photoStep || photoStep.hash) return;
    void referenceSetHash(photoStep.set).then((hash) => setPhotoStep((p) => (p ? { ...p, hash: hash as Hex } : p)));
  }, [photoStep]);
  const note = useCallback((f: Facts) => setFacts((x) => ({ ...x, ...f })), []);

  // Where this wallet is, from the chain and the server: so a refresh or a new tab resumes correctly.
  useEffect(() => {
    if (!wallet) return;
    setRegistered(null);
    fetch(`/api/creators/${wallet.address}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return setRegistered(false);
        const { creator: c } = (await r.json()) as { creator: { registeredAt?: number; verifiedAt: number; trust: { livenessMethod?: string } } };
        note({ registeredAt: c.registeredAt ?? c.verifiedAt, liveness: c.trust.livenessMethod });
        setRegistered(true);
      })
      .catch(() => setRegistered(false));
    api<{ consented: boolean }>(`/api/consent?address=${wallet.address}`)
      .then((r) => setConsented(r.consented))
      .catch(() => setConsented(false));
    api<Didit>(`/api/didit/status?address=${wallet.address}`)
      .then(setDidit)
      .catch(() => setDidit({ state: "none" }));
    pub.getBalance({ address: wallet.address }).then((b) => note({ balance: formatEther(b) })).catch(() => {});
  }, [wallet, note]);

  const done = !!wallet && registered === true && storage.get(DONE_KEY) === wallet.address.toLowerCase();
  // Returning creators go straight to their dashboard.
  useEffect(() => {
    if (wallet && registered === true && !done) router.replace("/dashboard");
  }, [wallet, registered, done, router]);

  // A new, empty wallet gets a little USDC for gas in the background, once, with the drip's own limits.
  const drip = useCallback(
    async (address: `0x${string}`) => {
      setDripError(null);
      try {
        if ((await pub.getBalance({ address })) > 0n) return;
        const r = await fetch("/api/drip", { method: "POST", body: JSON.stringify({ address }) });
        const j = (await r.json()) as { hash?: Hex; error?: string };
        if (!r.ok || !j.hash) throw new Error(j.error ?? `drip failed (${r.status})`);
        note({ dripTx: j.hash });
        await pub.waitForTransactionReceipt({ hash: j.hash });
        note({ balance: formatEther(await pub.getBalance({ address })) });
      } catch (e) {
        setDripError(e instanceof Error ? e.message : String(e));
      }
    },
    [note],
  );
  const dripped = useRef<string | null>(null);
  useEffect(() => {
    if (!wallet || wallet.kind === "dev" || registered !== false || dripped.current === wallet.address) return;
    dripped.current = wallet.address;
    void drip(wallet.address);
  }, [wallet, registered, drip]);

  const resolving = !!wallet && (registered === null || consented === null || didit === null);
  const step: 1 | 2 | 3 | "done" | null = !wallet ? 1 : resolving || (registered && !done) ? null : done ? "done" : didit?.state === "approved" ? 3 : 2;

  return (
    <div className="flex flex-col gap-[18px]">
      <Progress step={step === "done" ? (photoStep ? 4 : 5) : (step ?? (wallet ? 2 : 1))} />

      <section aria-live="polite" className="rounded-[20px] bg-white p-5 sm:p-6">
        {step === null && (
          <p role="status" className="m-0 text-[16px] text-grey">
            {registered ? "You're already registered. Opening your dashboard…" : "Picking up where you left off…"}
          </p>
        )}
        {step === 1 &&
          (dynamic === "ready" ? (
            <SignIn />
          ) : (
            <Note>{dynamic === "off" ? "Sign-in is off on this server (NEXT_PUBLIC_DYNAMIC_ENV_ID)." : "Loading sign-in…"}</Note>
          ))}
        {step === 2 && wallet && <VerifyStep wallet={wallet} consented={!!consented} didit={didit!} onConsent={() => setConsented(true)} onDidit={setDidit} />}
        {step === 3 && wallet && !deployment.CreatorRegistry && <Note>The contracts are not deployed yet, so registration is off.</Note>}
        {step === 3 && wallet && deployment.CreatorRegistry && (
          <ProtectStep
            wallet={wallet}
            note={note}
            onRegistered={(photos, set) => {
              storage.set(DONE_KEY, wallet.address.toLowerCase());
              setPhotoStep({ photos, set });
              setRegistered(true);
            }}
          />
        )}
        {step === "done" && wallet && photoStep && (
          <PublicPhotoPicker
            wallet={wallet}
            referenceSetHash={photoStep.hash ?? ("0x" as Hex)}
            initial={{ photos: photoStep.photos, set: photoStep.set }}
            onDone={(url) => {
              setPublicPhoto(url);
              setPhotoStep(null);
            }}
            onSkip={() => {
              photoStep.photos.forEach((p) => p.fill(0));
              setPhotoStep(null);
            }}
          />
        )}
        {step === "done" && wallet && !photoStep && <Done wallet={wallet} liveness={facts.liveness} registeredAt={facts.registeredAt} photo={publicPhoto} />}
      </section>

      {dripError && wallet && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-[15px] text-bad">
          We couldn&apos;t send your wallet gas for registering ({dripError}).
          <button type="button" onClick={() => void drip(wallet.address)} className={pillClass("outline", "min-h-11 px-4 text-[14px]")}>
            Retry
          </button>
        </p>
      )}

      <Details summary="Details">
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
          <dt className="text-grey">Wallet</dt>
          <dd className="m-0 break-all font-mono text-[13px]">
            {wallet ? (
              <a href={explorer.address(wallet.address)} target="_blank" rel="noreferrer">
                {wallet.address}
                <span className="sr-only"> (opens Arc Explorer)</span>
              </a>
            ) : (
              "not signed in"
            )}
          </dd>
          <dt className="text-grey">Network</dt>
          <dd className="m-0">Arc mainnet (5042)</dd>
          <dt className="text-grey">USDC balance (gas)</dt>
          <dd className="tnum m-0">{facts.balance ? `${facts.balance} USDC` : "—"}</dd>
          <dt className="text-grey">Gas drip</dt>
          <dd className="m-0">{facts.dripTx ? <Tx hash={facts.dripTx} /> : dripError ? `failed: ${dripError}` : "—"}</dd>
          <dt className="text-grey">Passkey key fingerprint</dt>
          <dd className="tnum m-0 font-mono text-[13px]">{facts.fingerprint ?? "—"}</dd>
          <dt className="text-grey">Didit session</dt>
          <dd className="m-0">
            {didit ? `${didit.state}${didit.sessionStatus ? ` (${didit.sessionStatus})` : ""}${didit.environment === "sandbox" ? " · sandbox" : ""}` : "—"}
            {didit?.reasons?.length ? <span className="block text-[13px] text-grey">{didit.reasons.join("; ")}</span> : null}
          </dd>
          <dt className="text-grey">Verification level</dt>
          <dd className="m-0">{didit?.level ?? "—"}</dd>
          <dt className="text-grey">Attestation</dt>
          <dd className="m-0">{facts.attested ? `${facts.attested.provider}, liveness ${facts.attested.liveness}, level ${facts.attested.level}` : "—"}</dd>
          <dt className="text-grey">Registration</dt>
          <dd className="m-0">{facts.registerTx ? <Tx hash={facts.registerTx} ms={facts.registerMs} /> : "—"}</dd>
        </dl>
        {dynamic === "ready" && <SignOut />}
        <KeysPanel />
      </Details>
    </div>
  );
}

// ---------------------------------------------------------------- progress

const STEPS = ["Sign in", "Verify it's you", "Protect your photos", "Public photo"];

export function Progress({ step, steps = STEPS }: { step: number; steps?: readonly string[] }) {
  const STEPS = steps;
  const pct = Math.min(100, ((step - 1) / STEPS.length) * 100 + (step > STEPS.length ? 0 : 100 / STEPS.length / 2));
  return (
    <div className="flex flex-col gap-2.5 rounded-[20px] bg-white px-5 py-3.5">
      <ol aria-label="Onboarding steps" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px]">
        {STEPS.map((t, i) => {
          const n = i + 1;
          const isDone = step > n;
          const now = step === n;
          return (
            <li key={t} aria-current={now ? "step" : undefined} className={`flex items-center gap-2 font-semibold ${now ? "text-ink" : isDone ? "text-ok" : "text-grey"}`}>
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${now ? "bg-ink text-lime" : isDone ? "bg-ok-bg" : "bg-[#E3E6EC]"}`}>
                {isDone ? <IconCheck size={13} stroke="#3B6E25" /> : n}
              </span>
              {t}
              {isDone && <span className="sr-only">(done)</span>}
            </li>
          );
        })}
      </ol>
      <div role="progressbar" aria-label="Onboarding progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-1.5 overflow-hidden rounded-full bg-[#E3E6EC]">
        <div className="h-full rounded-full bg-ink transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 1. sign in

export function SignIn() {
  const user = useUser();
  const accounts = useGetWalletAccounts();
  const send = useSendEmailOTP();
  const verify = useVerifyOTP();
  const createWallet = useCreateWaasWalletAccounts();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const creating = useRef(false);
  const evm = accounts.data?.find((a) => a.chain === "EVM");
  const otp = send.data;

  // Signed in without a wallet yet: create it, no extra click.
  useEffect(() => {
    if (user.data && accounts.isFetched && !evm && !creating.current) {
      creating.current = true;
      createWallet.mutate({ chains: ["EVM"] }, { onSuccess: () => accounts.refetch() });
    }
  }, [user.data, accounts, evm, createWallet]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="m-0 text-[18px] font-bold">Sign in with your email</h2>
      <p className="m-0 max-w-2xl text-[15px] text-grey">We create your wallet on Arc as you sign in. No seed phrase, no extension.</p>
      {!user.data && !otp && (
        <form
          className="flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate({ email });
          }}
        >
          <label htmlFor="email" className="sr-only">
            Email
          </label>
          <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={`${inputClass} max-w-sm`} />
          <button type="submit" disabled={send.isPending} className={pillClass("ink")}>
            Email me a code
          </button>
        </form>
      )}
      {!user.data && otp && (
        <form
          className="flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate({ otpVerification: otp, verificationToken: code });
          }}
        >
          <label htmlFor="code" className="sr-only">
            Six-digit code
          </label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" className={`${inputClass} tnum max-w-[12rem]`} />
          <button type="submit" disabled={verify.isPending} className={pillClass("ink")}>
            Verify
          </button>
        </form>
      )}
      {user.data && !evm && (
        <p role="status" className="m-0 text-[15px]">
          Creating your wallet…
        </p>
      )}
      {(send.error || verify.error || createWallet.error) && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-[15px] text-bad">
          {(send.error ?? verify.error ?? createWallet.error)?.message}
          {createWallet.error && (
            <button
              type="button"
              onClick={() => createWallet.mutate({ chains: ["EVM"] }, { onSuccess: () => accounts.refetch() })}
              className={pillClass("outline", "min-h-11 px-4 text-[14px]")}
            >
              Retry
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function SignOut() {
  const logout = useLogout();
  return (
    <button type="button" onClick={() => logout.mutate()} className={pillClass("outline", "self-start")}>
      Sign out
    </button>
  );
}

// ---------------------------------------------------------------- 2. verify it's you

function VerifyStep({ wallet, consented, didit, onConsent, onDidit }: { wallet: ActiveWallet; consented: boolean; didit: Didit; onConsent: () => void; onDidit: (d: Didit) => void }) {
  const [adult, setAdult] = useState(false);
  const [biometric, setBiometric] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const waiting = didit.state === "pending";

  // While Didit is working, ask our server (which asks Didit) every few seconds.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      api<Didit>(`/api/didit/status?address=${wallet.address}`)
        .then(onDidit)
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [waiting, wallet.address, onDidit]);

  /** Sign the consent (unless this wallet already has), then start or resume the Didit session. */
  async function agreeAndVerify() {
    setBusy(true);
    setError(null);
    // Opened inside the click, so the browser does not block it as a pop-up.
    const tab = window.open("", "_blank");
    try {
      if (!consented) {
        const message = actionMessage("consent to identity verification and likeness licensing", {
          wallet: wallet.address.toLowerCase(),
          version: CONSENT_VERSION,
          "text sha256": await consentTextHash(),
        });
        const signature = await wallet.client.signMessage({ account: wallet.client.account, message });
        await api("/api/consent", { method: "POST", body: JSON.stringify({ address: wallet.address, auth: { message, signature } }) });
        onConsent();
      }
      const s = await api<{ state: string; url?: string }>("/api/didit/session", { method: "POST", body: JSON.stringify({ address: wallet.address }) });
      if (s.url) {
        setUrl(s.url);
        if (tab) {
          tab.opener = null;
          tab.location.href = s.url;
        }
      } else tab?.close();
      onDidit(await api<Didit>(`/api/didit/status?address=${wallet.address}`));
    } catch (e) {
      tab?.close();
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  }

  if (waiting)
    return (
      <div className="flex flex-col items-start gap-4">
        <h2 className="m-0 text-[18px] font-bold">Finish on your phone… we&apos;ll continue automatically</h2>
        <p className="m-0 max-w-2xl text-[15px] text-grey">
          Didit opened in a new tab. {didit.level === "full" ? "On a computer it shows a QR code: scan it and finish on your phone." : "Finish there with your camera, or scan its QR code to use your phone."} Show
          your ID, then take the selfie. This page moves on by itself when Didit is done.
        </p>
        <span role="status" className="inline-flex items-center gap-2 text-[14px] font-semibold text-wait">
          <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-violet motion-reduce:animate-none" />
          Waiting for Didit
        </span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className={pillClass("outline")}>
            Reopen Didit
          </a>
        ) : (
          <button type="button" onClick={agreeAndVerify} disabled={busy} className={pillClass("outline")}>
            Reopen Didit
          </button>
        )}
        {error && <Note tone="down">{error}</Note>}
      </div>
    );

  const failed = didit.state === "declined" ? diditFailure(didit.reasons, didit.sessionStatus) : null;
  return (
    <div className="flex flex-col gap-4">
      {failed && (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-[18px] bg-bad-bg p-4 text-bad">
          <b className="text-[16px]">{failed.title}</b>
          <span className="text-[15px]">{failed.help}</span>
        </div>
      )}
      <h2 className="m-0 text-[18px] font-bold">Verify it&apos;s you</h2>
      <p className="m-0 max-w-3xl text-[15px] text-grey">
        Didit checks your ID, takes a liveness selfie and matches it to your ID. It takes about two minutes. In short:
      </p>
      <ul className="m-0 max-w-3xl list-disc space-y-1 pl-5 text-[15px]">
        <li>We keep only the outcome (18 or over, checks passed), not your ID or your selfie, and we ask Didit to delete its copy once you&apos;re attested.</li>
        <li>Your photos are encrypted in this browser with your Face ID. We store only the locked copy.</li>
        <li>When you approve a licence, your photos are used for that licence only, to make images with Google&apos;s Gemini.</li>
        <li>Political, adult and deceptive uses are never allowed, and you can revoke any licence at any time.</li>
      </ul>
      <div className="flex max-w-3xl flex-col gap-2">
        <h3 id="consent-title" className="m-0 text-[15px] font-semibold">
          The consent your wallet signs
        </h3>
        <div role="region" aria-labelledby="consent-title" tabIndex={0} className="max-h-72 overflow-y-auto rounded-[16px] border border-field p-4">
          <ol className="m-0 list-decimal space-y-2 pl-5 text-[14px] text-[#3E4148]">
            {CONSENT_POINTS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </div>
      </div>
      <p className="m-0 text-[14px] text-grey">
        Didit&apos;s{" "}
        <a href={DIDIT_LINKS.privacy} target="_blank" rel="noreferrer" className="text-wait underline">
          verification privacy notice
        </a>{" "}
        and{" "}
        <a href={DIDIT_LINKS.terms} target="_blank" rel="noreferrer" className="text-wait underline">
          identity verification terms
        </a>
        . Consent version {CONSENT_VERSION}.
      </p>
      {consented ? (
        <p className="m-0 flex items-center gap-2 text-[15px] text-ok">
          <IconCheck size={16} /> Your wallet has already signed this consent.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 items-start gap-3 text-[15px]">
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#121316]" />
            <span>I am 18 or over, the face is my own, and I agree to the points above.</span>
          </label>
          <label className="flex min-h-11 items-start gap-3 text-[15px]">
            <input type="checkbox" checked={biometric} onChange={(e) => setBiometric(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#121316]" />
            <span>I agree to Didit processing my identity document and my face (biometric data) for this verification.</span>
          </label>
        </div>
      )}
      <button type="button" disabled={busy || (!consented && !(adult && biometric))} onClick={agreeAndVerify} className={pillClass("ink", "self-start")}>
        {busy ? "Starting…" : consented ? (failed ? "Try again" : "Verify with Didit") : failed ? "Agree and try again" : "Agree and verify"}
      </button>
      <p className="m-0 text-[13px] text-grey">{consented ? "Didit opens in a new tab." : "Your wallet signs this consent, then Didit opens in a new tab."}</p>
      {error && <Note tone="down">{error}</Note>}
    </div>
  );
}

// ---------------------------------------------------------------- 3. protect your photos

const MATCHER_OFF =
  "This server can't check photos at the free verification level: its local face matcher isn't installed (on Vercel it is too large to deploy). Registration can't finish here until the server runs at the full level, where Didit matches the photos.";

function passkeyError(e: unknown): string {
  if (isMeraError(e)) {
    if (e.code === "PRF_UNAVAILABLE")
      return "This browser or passkey manager can't make the kind of passkey Likeness needs (WebAuthn PRF). It works in Safari 18 or later and in Chrome 132 or later, with iCloud Keychain, Google Password Manager, 1Password or a YubiKey; not with Chrome's local profile passkeys, Bitwarden or Dashlane. Your photos are still here: switch, then try again.";
    if (e.code === "PASSKEY_OPERATION_FAILED") return "The Face ID prompt was cancelled. Nothing was saved, and your photos are still here: try again when you're ready.";
    if (e.code === "CRYPTO_UNAVAILABLE") return "This browser can't encrypt in the page (Web Crypto is unavailable). Use a current Safari or Chrome over https.";
  }
  if (e instanceof DOMException && e.name === "NotAllowedError") return "The Face ID prompt was cancelled. Nothing was saved, and your photos are still here: try again when you're ready.";
  return reason(e);
}

function ProtectStep({ wallet, note, onRegistered }: { wallet: ActiveWallet; note: (f: Facts) => void; onRegistered: (photos: Uint8Array[], set: ReferenceSet) => void }) {
  const [shots, setShots] = useState<(Uint8Array | null)[]>([null, null, null]);
  const [thumbs, setThumbs] = useState<(string | null)[]>([null, null, null]);
  const [states, setStates] = useState<PhotoState[]>(["empty", "empty", "empty"]);
  const [checking, setChecking] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Kept once uploaded, so a retry after a failed attestation or registration skips Face ID.
  const sealed = useRef<ReferenceSet | null>(null);
  const kept = useRef<Uint8Array[]>([]);

  useEffect(() => {
    try {
      setExisting(!!localStorage.getItem(passkeyKey(wallet.address)));
    } catch {}
  }, [wallet.address]);
  // Thumbnails are object URLs over the photos in memory; release them when the step goes away.
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  useEffect(() => () => thumbsRef.current.forEach((t) => t && URL.revokeObjectURL(t)), []);

  // At the free level the photos are matched on this server; say so up front if it can't.
  const [matcherOff, setMatcherOff] = useState(false);
  useEffect(() => {
    api<{ verificationLevel: string; integrations: { key: string; configured: boolean }[] }>("/api/status")
      .then((st) => setMatcherOff(st.verificationLevel === "free" && st.integrations.some((i) => i.key === "face-models" && !i.configured)))
      .catch(() => {});
  }, []);

  const allMatched = states.every((s) => s === "ok");
  // The camera's next photo: the first one not taken yet, else one that failed to match.
  const active = (() => {
    const empty = states.findIndex((s) => s === "empty");
    return empty >= 0 ? empty : states.findIndex((s) => s === "failed");
  })();

  async function check(all: Uint8Array[]) {
    setChecking(true);
    setMatchError(null);
    try {
      const photos = (await Promise.all(all.map(sha256Hex))).join(",");
      const message = actionMessage("verify reference photos", { wallet: wallet.address.toLowerCase(), photos });
      const auth = { message, signature: await wallet.client.signMessage({ account: wallet.client.account, message }) };
      const b64 = all.map((s) => btoa(Array.from(s, (c) => String.fromCharCode(c)).join("")));
      await api("/api/captures/verify", { method: "POST", body: JSON.stringify({ address: wallet.address, captures: b64, auth }) });
      setStates(["ok", "ok", "ok"]);
    } catch (e) {
      // The server checks the photos in order and names the first that fails ("photo 2 …"). Only a
      // problem with that photo itself is a retake; anything else (the matcher unavailable, Didit or
      // the network down) is shown as it is, with all three photos kept.
      const text = reason(e);
      const n = Number(/^photo (\d)/.exec(text)?.[1] ?? 0);
      const photoProblem = /does not match|no face found in the photo|the photo shows more than one face/.test(text);
      if (n >= 1 && n <= 3 && photoProblem) {
        const name = ["front", "slight left", "slight right"][n - 1];
        setStates(all.map((_, i) => (i < n - 1 ? "ok" : i === n - 1 ? "failed" : "taken")));
        setMatchError(
          /no face found/.test(text)
            ? `We couldn't find a face in the ${name} photo. Retake it with your face inside the outline.`
            : /more than one face/.test(text)
              ? `The ${name} photo shows more than one face. Retake it on your own.`
              : `The ${name} photo didn't match your selfie. Retake just that one; the others are kept.`,
        );
      } else if (/models missing/.test(text)) {
        setStates(["taken", "taken", "taken"]);
        setMatchError(MATCHER_OFF);
      } else {
        setStates(["taken", "taken", "taken"]);
        setMatchError(text);
      }
    } finally {
      setChecking(false);
    }
  }

  function capture(i: number, bytes: Uint8Array) {
    const next = shots.slice();
    next[i]?.fill(0);
    next[i] = bytes;
    setShots(next);
    setThumbs((t) => {
      const n = t.slice();
      if (n[i]) URL.revokeObjectURL(n[i]!);
      n[i] = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
      return n;
    });
    const st = states.slice();
    st[i] = "taken";
    setStates(st);
    if (next.every((s) => s)) void check(next as Uint8Array[]);
  }

  async function protect() {
    setBusy(true);
    setError(null);
    setLines([]);
    const say = (l: string) => setLines((x) => [...x, l]);
    try {
      if (!sealed.current) {
        say("Locking your photos to your Face ID…");
        const key = existing
          ? await namespaceKey({ kind: "reference" })
          : await createPasskey({ name: `likeness-${wallet.address.slice(2, 8)}`, displayName: "Likeness creator" }, { kind: "reference" });
        try {
          localStorage.setItem(passkeyKey(wallet.address), key.credentialId);
        } catch {}
        note({ fingerprint: key.fingerprint });
        const set = await sealReferenceSet(key.kek, wallet.address, shots as Uint8Array[]);
        say("Saving encrypted copy…");
        await vaultPut(vaultId(key.credentialId, `reference-set:${await referenceSetHash(set)}`), set);
        sealed.current = set;
        // Copies stay in this page's memory for "Choose your public photo", then are zeroed.
        kept.current = shots.map((s) => s!.slice());
        shots.forEach((s) => s?.fill(0));
        setShots([null, null, null]);
      }
      say("Registering you on Arc…");
      const a = await api<{ attestation: Record<string, unknown> & { verifiedAt: string }; deadline: string; signature: Hex; provider: string; liveness: string; level: string }>("/api/attest", {
        method: "POST",
        body: JSON.stringify({ address: wallet.address, referenceSet: sealed.current }),
      });
      note({ attested: { provider: a.provider, liveness: a.liveness, level: a.level }, liveness: a.liveness.split(":").pop() });
      const r = await write(wallet, {
        address: deployment.CreatorRegistry!,
        abi: CreatorRegistryAbi,
        functionName: "register",
        args: [wallet.address, { ...a.attestation, verifiedAt: BigInt(a.attestation.verifiedAt) } as never, BigInt(a.deadline), a.signature, STARTER_TERMS],
      });
      const block = await pub.getBlock({ blockNumber: r.receipt.blockNumber }).catch(() => null);
      note({ registerTx: r.hash, registerMs: r.ms, registeredAt: block ? Number(block.timestamp) : Math.floor(Date.now() / 1000) });
      onRegistered(kept.current, sealed.current!);
    } catch (e) {
      const text = passkeyError(e);
      if (/no matched reference photos/.test(text)) {
        // The photo check's record expired (30 minutes) or was used: start the photos again.
        sealed.current = null;
        thumbs.forEach((t) => t && URL.revokeObjectURL(t));
        setThumbs([null, null, null]);
        setShots([null, null, null]);
        setStates(["empty", "empty", "empty"]);
        setLines([]);
        setMatchError("Your photo check has expired. Take the three photos again; it only takes a moment.");
        return;
      }
      setError(/insufficient funds|exceeds the balance/i.test(text) ? "Your wallet has no USDC for gas yet. Use Retry under this card, then try again." : text);
    } finally {
      setBusy(false);
    }
  }

  const t = STARTER_TERMS;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-[18px] font-bold">Protect your photos</h2>
        <p className="m-0 max-w-3xl text-[15px] text-grey">
          Three quick photos. Each is matched to your Didit selfie, then encrypted in this browser under your Face ID before anything is saved.
        </p>
      </div>

      {matcherOff && <Note tone="down">{MATCHER_OFF}</Note>}
      {!sealed.current && <CaptureStep active={allMatched || checking || active < 0 ? null : active} states={states} thumbs={thumbs} busy={checking} cameraOn={!allMatched} onCapture={capture} />}
      {matchError && (
        <p role="alert" className="m-0 text-[15px] text-bad">
          {matchError}
        </p>
      )}

      {allMatched && (
        <div className="flex flex-col gap-4 border-t border-divider pt-5">
          <p className="m-0 max-w-3xl text-[15px] text-grey">
            You&apos;ll start on {categoryLabels(t.categories).join(" and ")}, worldwide, {usdc.format(t.pricePerRender)} USDC per render, up to {t.maxRenders} renders over{" "}
            {formatDuration(t.maxDuration)}, and you approve every licence yourself. Change any of it later from your dashboard.
          </p>
          <button type="button" disabled={busy} onClick={protect} className={pillClass("lime", "self-start px-6")}>
            <IconShield size={18} /> {busy ? "Working…" : sealed.current ? "Try registering again" : "Protect with Face ID and register"}
          </button>
          {!sealed.current && (
            <label className="flex min-h-11 items-center gap-3 text-[14px] text-grey">
              <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} className="h-5 w-5 accent-[#121316]" />
              Use the Likeness passkey I already have
            </label>
          )}
          {lines.length > 0 && (
            <ol role="status" className="m-0 flex list-none flex-col gap-1.5 p-0 text-[15px]">
              {lines.map((l, i) => (
                <li key={l} className="flex items-center gap-2">
                  {i < lines.length - 1 || (!busy && !error) ? <IconCheck size={15} stroke="#3B6E25" /> : <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-violet motion-reduce:animate-none" />}
                  {l}
                </li>
              ))}
            </ol>
          )}
          {error && <Note tone="down">{error}</Note>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- done

function Done({ wallet, liveness, registeredAt, photo }: { wallet: ActiveWallet; liveness?: string; registeredAt?: number; photo?: string | null }) {
  const level = liveness === "active" ? "Full: active liveness" : liveness === "passive" ? "Free: passive liveness" : "Verified";
  return (
    <div className="flex flex-col gap-5">
      <h2 className="m-0 text-[18px] font-bold">You&apos;re a verified creator</h2>
      <article aria-label="Your creator credential" className="relative flex max-w-md flex-col gap-3 overflow-hidden rounded-[22px] bg-ink p-6 text-white">
        <span className="flex items-center gap-3 text-[13px] font-semibold text-lime">
          <CreatorFace seed={wallet.address} photo={photo} size={48} />
          <span className="flex items-center gap-2">
            <VerifiedMark size={18} /> Likeness creator credential
          </span>
        </span>
        <dl className="m-0 grid grid-cols-[8rem_1fr] gap-y-2 text-[15px]">
          <dt className="text-grey-dark">Name</dt>
          <dd className="tnum m-0 font-mono">{shortAddr(wallet.address)}</dd>
          <dt className="text-grey-dark">Verification</dt>
          <dd className="m-0">{level}</dd>
          <dt className="text-grey-dark">Registered</dt>
          <dd className="m-0">{registeredAt ? fmtDate(registeredAt) : "—"}</dd>
        </dl>
      </article>
      <div className="flex flex-wrap gap-3">
        <Link href="/dashboard" className={pillClass("ink")}>
          Go to dashboard
        </Link>
        <Link href="/dashboard#terms" className={pillClass("outline")}>
          Review your terms
        </Link>
      </div>
    </div>
  );
}
