# Deploying the Arc mainnet edition to Vercel

[Back to the README](../README.md)

A **new** Vercel project from `rohitshukla11/likeness-arc`, serving the Arc mainnet deployment
(contracts in [`deployments/arc-mainnet.json`](../deployments/arc-mainnet.json)). Nothing here touches
any other Vercel project or store.

## 1. Project and storage

1. Vercel → **Add New → Project** → import `rohitshukla11/likeness-arc`. Set **Root Directory** to `web`;
   keep the framework as Next.js. Install and build commands come from `web/vercel.json`; Node 22 from
   `web/package.json`. Keep Fluid compute on. Don't deploy yet, or let the first deploy fail: the public
   variables must be set first.
2. **Storage → Create → Blob**, **private**, connected to this project only (a **new** store). Vercel adds
   the store's credentials to the project (`BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` with OIDC); the
   app's Blob client uses either.
3. Put the API keys in `~/likeness-arc/web/.env.local` (never committed; start from `.env.example`):
   `NEXT_PUBLIC_DYNAMIC_ENV_ID`, `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID_FREE`, `VERIFICATION_LEVEL=free`,
   `GEMINI_API_KEY` (a billed key), and optionally `NEXT_PUBLIC_ARC_RPC_URL=https://rpc.mainnet.arc.io`.
4. In your own terminal:

   ```sh
   cd ~/likeness-arc/web
   npx vercel login
   npx vercel link                              # choose the NEW project from step 1
   sh scripts/vercel-env.sh https://<your-domain>
   ```

   The script shows the linked project's name and asks you to type it back before writing. It sets
   `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_RP_ID` from the URL, reads keys from `~/likeness-arc/.secrets`
   and `web/.env.local`, and pipes them to the Vercel CLI without printing them.
5. **Redeploy without the build cache** (Deployments → ⋯ → Redeploy, untick "Use existing Build Cache"):
   `NEXT_PUBLIC_*` values are compiled into the page.

Passkeys are bound to `NEXT_PUBLIC_RP_ID`. With a custom domain, use it from the start; a
`*.vercel.app` URL works too, but passkeys made there won't work on a custom domain added later.

## 2. Dynamic

In the Dynamic dashboard, for the environment whose ID is `NEXT_PUBLIC_DYNAMIC_ENV_ID`:

- **Chains → EVM → add a custom network:**

  | Field | Value |
  |---|---|
  | Chain ID / network ID | `5042` |
  | Name | `Arc` |
  | Native currency | `USDC`, symbol `USDC`, **18 decimals** |
  | RPC URL | `https://rpc.mainnet.arc.io` |
  | Block explorer | `https://explorer.arc.io` |

  The app also passes these values itself (`transformers.networksData`) and pins Arc as its only network.
- **Allowed origins** (Developers → Security / CORS): `https://<your-domain>` (and `https://www.<your-domain>`
  if used), the project's `https://<project>.vercel.app`, and `http://localhost:3000` for local runs.
- **Delegated access: leave off.** This deployment never sets `DYNAMIC_DELEGATION_ENABLED`.

## 3. Check

Open `https://<your-domain>/api/status`. Healthy looks like:

- `"chain": "Arc mainnet"`;
- `configured: true` for `dynamic`, `gas-drip`, `didit`, `face-models`, `gemini`, `render-agent` and `c2pa`;
- `dynamic-delegation: false`, `dynamic-agent: false` (off by design), `envio: false` (history comes from
  the RPC); `email-codes` and `brand-kyb` may be false.

`/status` shows the same, plus the four contracts with Arc explorer links. The face-matcher models are
fetched (sha256-pinned) on first use on Vercel.

## Environment variables

🔒 secret (set as sensitive). "Script" means `scripts/vercel-env.sh` sets it.

| Variable | Secret | Required | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | | yes | `https://<your-domain>` (script) |
| `NEXT_PUBLIC_RP_ID` | | yes | the domain without `www.` (script) |
| `NEXT_PUBLIC_DYNAMIC_ENV_ID` | | yes | Dynamic environment ID (script, from `.env.local`) |
| `NEXT_PUBLIC_ARC_RPC_URL` | | optional | Browser RPC; defaults to `https://rpc.mainnet.arc.io` |
| `ARC_RPC_URL` | 🔒 | optional | Server RPC; defaults to the browser one |
| `STORE_DRIVER` | | yes | `blob` (script) |
| Blob credentials | 🔒 | yes | Added by connecting the Blob store |
| `ATTESTER_PRIVATE_KEY` | 🔒 | yes | From `.secrets/attester.key` (script) |
| `RENDER_AGENT_PRIVATE_KEY` | 🔒 | yes | From `.secrets/render-agent.key`, registered on the escrow (script) |
| `DRIP_PRIVATE_KEY` | 🔒 | yes | From `.secrets/drip.key`, the gas top-up wallet (script) |
| `DRIP_AMOUNT_USDC`, `DRIP_PER_IP_PER_HOUR`, `DRIP_PER_HOUR` | | optional | Defaults 0.05, 2, 10 |
| `RENDERS_PER_DAY` | | optional | Site-wide Gemini renders per UTC day; default 20 |
| `C2PA_CERT_PEM`, `C2PA_KEY_PEM` | 🔒 | yes | Test signing chain from `.secrets/c2pa` (script) |
| `DIDIT_API_KEY` | 🔒 | yes | (script, from `.env.local`) |
| `VERIFICATION_LEVEL` | | yes | `free` |
| `DIDIT_WORKFLOW_ID_FREE` | | yes | The published free-level workflow |
| `DIDIT_WEBHOOK_SECRET` | 🔒 | optional | Only with a Didit webhook; otherwise the server polls |
| `LOCAL_FACE_MATCH_THRESHOLD`, `SAMPLE_FACE_MATCH_THRESHOLD` | | optional | Defaults 0.55 and 0.45 |
| `GEMINI_API_KEY` | 🔒 | yes | Billed key; without it renders are refused |
| `GEMINI_IMAGE_MODEL`, `GEMINI_IMAGE_SIZE`, `GEMINI_FILTER_MODEL` | | optional | |
| `DYNAMIC_DELEGATION_ENABLED` | | **leave unset** | Delegated access stays off on Arc mainnet |
| `DYNAMIC_API_KEY`, `DYNAMIC_WEBHOOK_SECRET`, `DYNAMIC_DELEGATION_PRIVATE_KEY_PEM`, `DYNAMIC_AGENT_JSON` | | **leave unset** | Delegated access and the Dynamic server-wallet agent are not used |
| `DEV_WALLETS`, `DEV_DELEGATION`, `DEV_RENDERER`, `TEST_BRAND` | | **leave unset** | Local test features |
| `NEXT_PUBLIC_HIDE_DEV_OVERLAY` | | **leave unset** | Development only |
