# How Likeness uses Mera: one passkey, many keys

**Bounty:** Mera, "One Passkey, Many Keys". **Video:** [youtu.be/xTEIn8F2gB4](https://youtu.be/xTEIn8F2gB4) · [Back to the README](../README.md)

## Status on the Arc mainnet deployment

- Mera's passkey PRF output is used as **encryption key material for a person's face**, never as a
  wallet or a login (the wallet is Dynamic's).
- The live namespace is **`likeness:reference`**: it derives the key that seals a creator's reference
  photos in the browser; the server stores only ciphertext.
- The **cross-device key test** is in the app (Become a creator → Details). It has not been re-run on the
  Arc deployment's domain yet.

The rest of this page describes only what the code does.

## Namespaces

Each namespace string is hashed with sha256 into the 32-byte PRF salt Mera requires
([`namespaces.ts`](../web/lib/crypto/namespaces.ts)). A different salt gives an unrelated PRF output, so
each namespace is its own key domain.

| Namespace | Derives | Used in | In the live app |
|---|---|---|---|
| `likeness:reference` | KEK (AES-256-GCM) that wraps the reference photos' data key; a public fingerprint | Onboarding (sealing the photos), Re-verify, public-photo picker, sample renders, the cross-device key test | Yes |
| `likeness:licence:<id>` | KEK (AES-256-GCM) for a per-licence copy of the data key | Creator dashboard, "Release photos to renderer" ([`KeyRelease.tsx`](../web/components/dashboard/KeyRelease.tsx)) | Deployed; see the limits below |
| `likeness:brand:<id>` | Defined in `namespaces.ts`, with an HKDF label for a per-brand seed (`brandIdentitySeed`) | Unit tests only | **No.** No app code calls it yet |

## Derivation steps

[`passkey.ts`](../web/lib/crypto/passkey.ts) is the only file that calls Mera:

1. `createPasskeyWithPrfOutput` (first time) or `getPasskeyPrfOutput` (any later time, any device) with
   `rpId` = `NEXT_PUBLIC_RP_ID` (the live app's domain) and the namespace's salt. The passkey is discoverable,
   so no credential ID needs to be supplied.
2. The 32-byte PRF output goes through WebCrypto HKDF-SHA256 (zero salt) under separate `info` labels
   ([`keys.ts`](../web/lib/crypto/keys.ts)):
   - `likeness/kek/v1` → a **non-extractable** AES-256-GCM `CryptoKey` (the KEK);
   - `likeness/fingerprint/v1` → 64 bits, shown base64url as the key fingerprint. It is a separate HKDF
     output, so it reveals nothing about the KEK, yet it matches exactly when the KEK matches.
3. The PRF output buffer is zeroed immediately after.

**Encryption versus derivation.** The KEK only wraps and unwraps: the photos themselves are encrypted
under a random 32-byte data key (DEK), and the DEK is wrapped under the KEK
([`envelope.ts`](../web/lib/crypto/envelope.ts)). Every ciphertext is AES-256-GCM with its context bound
as additional data (creator, item index, purpose, licence ID), so blobs can't be swapped. The fingerprint
is derivation only and is never used as a key.

## What is stored

| Item | Where |
|---|---|
| PRF output, KEKs, DEKs | Nowhere. Browser memory for one operation; byte buffers are zeroed. |
| Sealed reference set (ciphertext, IVs, wrapped DEK, sha256 of each plaintext photo) | The vault: private Vercel Blob. The server accepts only the sealed-envelope shape and writes each object once. |
| Per-licence copy of the DEK | The vault, wrapped under `likeness:licence:<id>` |
| Cross-device test note | The vault, sealed under the `likeness:reference` KEK |
| Credential ID | The browser's localStorage, as a hint that this browser already made a passkey for this wallet. It is an identifier, not key material. Vault object IDs are sha256 of it plus a name. |
| On chain | `referenceSetHash` (sha256 of the ciphertext manifest) |

No PRF output or derived key is written to the server, Blob, logs, localStorage, sessionStorage or
IndexedDB. The crypto, vault and keyring code has no logging.

## What the server sees in plaintext

The photos are decrypted outside the browser in these places, always in server memory and never
written to disk or logs:

- **Onboarding.** Before sealing, the browser sends the three captures to `/api/captures/verify` to be
  matched against the Didit liveness selfie. The server keeps only their sha256 digests (30 minutes, to
  check the sealed set against them).
- **Public profile photo.** The picker sends the chosen photo and the comparison photos to
  `/api/profiles/photo` for one face check.
- **Sample renders.** The browser wraps the DEK to the render service's sample key (X25519 ECIES,
  bound to a one-request context). The server opens the photos for that request, sends them to Gemini
  with the prompt, and zeroes them when the request ends.
- **Licensed renders.** On "Release photos to renderer", the browser wraps the DEK to an X25519 key the
  server creates for that licence ([`release.ts`](../web/lib/crypto/release.ts),
  [`keyring.ts`](../web/lib/server/keyring.ts)). The server checks that the release opens the reference
  set attested on chain, then keeps the licence's private key and the wrapped release in process
  memory while the licence is Active. For each render it unwraps the DEK, decrypts the photos, sends
  them to Gemini, and zeroes the DEK and photos when the render ends. The key is dropped when the
  licence is revoked, expires or is used up, or the process restarts.

## The cross-device key test

Open **Become a creator → Details → Cross-device key test** (`/onboard`). It works without signing in.

- **Create passkey** makes the passkey and derives the `likeness:reference` KEK.
- **Encrypt and store** seals a note under that KEK and stores it in the vault (one note per passkey).
- **Decrypt with passkey** works in a fresh browser profile: one passkey prompt derives the KEK, then
  the note is fetched by its vault ID and decrypted in the browser.

The panel shows the namespace, the key fingerprint, and what the server holds: the ciphertext's size
and the first 16 hex digits of its sha256. The same passkey in another browser shows the same
fingerprint, the same ciphertext hash, and the decrypted note. A browser without the passkey derives
nothing.

How it was checked:

- **Live run on the Arc deployment:** not yet.
- **Unit tests** ([`crypto.test.ts`](../web/lib/crypto/crypto.test.ts)): a fake authenticator with PRF =
  HMAC(credential secret, rpId ‖ salt), synced to a second instance, gets the same fingerprint and
  decrypts; a different passkey, namespace or rpId fails.
- **Browser test** on the production build with Chrome's virtual authenticator (PRF on): create → store
  → reload with no page state → "Decrypt with passkey" gives the same fingerprint, the same ciphertext
  hash and the note; a context without the passkey gets nothing. (Chrome's virtual authenticator can't
  copy a credential's PRF secret into a second profile, so the two-browser run is done by hand with a
  real synced passkey.)

PRF-capable providers: iCloud Keychain, Google Password Manager, 1Password, YubiKey. Not Chrome's local
profile authenticator, Bitwarden or Dashlane
([Mera authenticator support](https://mera.category.xyz/authenticator-support/)).

## Honest limits

- **Photos are decrypted on the server for a render.** They live in memory for one render request
  (or one sample request) and are dropped afterwards. There is **no TEE** yet; it's ordinary process
  memory, and the photos go to Gemini for the render.
- **The per-licence key lives in one instance's memory.** On Vercel, the service-key fetch, the release
  and the render can land on different instances, and a new instance doesn't have the key, so the
  creator may have to release again. The licence release with a real passkey has not been demonstrated
  on the live app; the fork tests run it with the seeded test creator, whose keys come from
  a dev secret through the same HKDF ([`devkeys.ts`](../web/lib/crypto/devkeys.ts)).
- **`likeness:brand:<id>` is not wired into the app.**
- **Keys are bound to the rpId** (the live app's domain); a passkey made on another host derives different keys.
