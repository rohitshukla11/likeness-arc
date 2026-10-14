import "server-only";
/**
 * Every external integration, whether it is configured, and what it turns on. Pages and /api/status
 * read this, so a missing credential shows up as "not configured", never as a pass.
 */
import { historySource } from "./index";
import { modelsFetchable, modelsPresent } from "./facemodels";
import { loadKey } from "./keys";
import { secretText } from "./secret";

export type Integration = {
  key: string;
  name: string;
  configured: boolean;
  turnsOn: string;
  env: string[];
  whenMissing: string;
};

const set = (...names: string[]) => names.every((n) => !!process.env[n]);
const secret = (valueVar: string, fileVar: string, fallback?: string) => secretText(valueVar, fileVar, fallback) !== null;

export function integrations(): Integration[] {
  return [
    {
      key: "dynamic",
      name: "Dynamic (sign-in, embedded wallets)",
      configured: set("NEXT_PUBLIC_DYNAMIC_ENV_ID"),
      turnsOn: "Email sign-in and embedded wallets on Arc mainnet for creators and brands",
      env: ["NEXT_PUBLIC_DYNAMIC_ENV_ID"],
      whenMissing: "Wallets are off; only seeded dev wallets (DEV_WALLETS=1) can act in the UI",
    },
    {
      key: "gas-drip",
      name: "Gas top-up for new wallets",
      configured: secret("DRIP_PRIVATE_KEY", "DRIP_KEY_FILE"),
      turnsOn: `A one-time gas top-up (${process.env.DRIP_AMOUNT_USDC ?? "0.05"} USDC, native) to each new, empty wallet, so creators and brands can transact`,
      env: ["DRIP_PRIVATE_KEY or DRIP_KEY_FILE", "DRIP_AMOUNT_USDC", "DRIP_PER_IP_PER_HOUR", "DRIP_PER_HOUR"],
      whenMissing: "New wallets get no gas: registering and paying fail until the wallet holds USDC for gas",
    },
    {
      key: "dynamic-delegation",
      name: "Dynamic delegated access",
      // Off on the Arc mainnet deployment: Dynamic's delegated access is sandbox-only without an
      // Enterprise plan. It needs an explicit DYNAMIC_DELEGATION_ENABLED=1 on top of its credentials.
      configured:
        process.env.DYNAMIC_DELEGATION_ENABLED === "1" &&
        set("NEXT_PUBLIC_DYNAMIC_ENV_ID", "DYNAMIC_API_KEY", "DYNAMIC_WEBHOOK_SECRET") &&
        secret("DYNAMIC_DELEGATION_PRIVATE_KEY_PEM", "DYNAMIC_DELEGATION_PRIVATE_KEY_FILE"),
      turnsOn: "One-click renders: the brand's embedded wallet sends payRender through the render service, under the payRender-only policy",
      env: ["DYNAMIC_DELEGATION_ENABLED=1 (off on Arc mainnet)", "DYNAMIC_API_KEY", "DYNAMIC_WEBHOOK_SECRET", "DYNAMIC_DELEGATION_PRIVATE_KEY_FILE or _PEM"],
      whenMissing: "Brands confirm each payRender in their own wallet; seeded test brands can use dev delegation (DEV_DELEGATION=1)",
    },
    {
      key: "dynamic-agent",
      name: "Dynamic server wallet (render agent)",
      configured: set("NEXT_PUBLIC_DYNAMIC_ENV_ID", "DYNAMIC_API_KEY") && secret("DYNAMIC_AGENT_JSON", "DYNAMIC_AGENT_FILE", "../.secrets/dynamic-agent.json"),
      turnsOn: "The render agent's Render signatures come from a Dynamic server wallet",
      env: ["DYNAMIC_API_KEY", "DYNAMIC_AGENT_FILE (written by pnpm agent:dynamic) or DYNAMIC_AGENT_JSON"],
      whenMissing: "The render agent signs with a local key (RENDER_AGENT_KEY_FILE)",
    },
    {
      key: "didit",
      name: "Didit (ID document, liveness, face match)",
      configured: set("DIDIT_API_KEY") && !!(process.env.VERIFICATION_LEVEL === "full" ? process.env.DIDIT_WORKFLOW_ID_FULL : process.env.DIDIT_WORKFLOW_ID_FREE),
      turnsOn: `Creator verification at level ${process.env.VERIFICATION_LEVEL === "full" ? "full (active liveness; photos matched by Didit)" : "free (passive liveness; photos matched on this server)"}: 18+ from the ID's date of birth, liveness, selfie-to-ID face match`,
      env: ["DIDIT_API_KEY", "VERIFICATION_LEVEL (free | full)", "DIDIT_WORKFLOW_ID_FREE", "DIDIT_WORKFLOW_ID_FULL", "DIDIT_WEBHOOK_SECRET (optional; the server also polls)"],
      whenMissing: "Liveness not configured and ID check not performed: no creator can be attested as verified",
    },
    {
      key: "face-models",
      name: "Local face matcher (free level)",
      // Present on disk, or fetched (sha256-pinned) on first use where the host can't ship them (Vercel).
      configured: modelsPresent() || modelsFetchable(),
      turnsOn: "At VERIFICATION_LEVEL=free, matching the three reference photos to the Didit liveness selfie on this server (YuNet + AuraFace, in memory)",
      env: ["pnpm face:models", "FACE_MODELS_DIR", "FACE_MODELS_FETCH (on by default on Vercel)", "LOCAL_FACE_MATCH_THRESHOLD"],
      whenMissing: "Free-level creators cannot get their reference photos matched, so they cannot register",
    },
    {
      key: "gemini",
      name: "Google Gemini (renders and prompt filter)",
      configured: set("GEMINI_API_KEY"),
      turnsOn: "Real renders from the creator's reference photos (Gemini image model, SynthID-watermarked) and the LLM banned-use prompt filter",
      env: ["GEMINI_API_KEY", "GEMINI_IMAGE_MODEL", "GEMINI_FILTER_MODEL"],
      whenMissing: "TEST RENDER from the DevRenderer; LLM filter not configured: prompts are checked by local keyword rules only",
    },
    {
      key: "envio",
      name: "Envio HyperIndex",
      configured: historySource() === "envio",
      turnsOn: "Marketplace, dashboards and history served from the indexer",
      env: ["ENVIO_GRAPHQL_URL or ENVIO_PG_URL", "ENVIO_API_TOKEN (indexer/.env, for HyperSync)"],
      whenMissing: "History comes from cached RPC log scans (100 blocks per call)",
    },
    {
      key: "render-agent",
      name: "Render agent key",
      configured: !!loadKey("RENDER_AGENT_KEY_FILE", "RENDER_AGENT_PRIVATE_KEY") || secret("DYNAMIC_AGENT_JSON", "DYNAMIC_AGENT_FILE", "../.secrets/dynamic-agent.json"),
      turnsOn: "Signing Render attestations so payRender can pay out",
      env: ["RENDER_AGENT_KEY_FILE or RENDER_AGENT_PRIVATE_KEY"],
      whenMissing: "No renders can be paid",
    },
    {
      key: "c2pa",
      name: "C2PA signing certificate",
      configured: secret("C2PA_CERT_PEM", "C2PA_CERT_FILE", "../.secrets/c2pa/signer.pem") && secret("C2PA_KEY_PEM", "C2PA_KEY_FILE", "../.secrets/c2pa/signer.key"),
      turnsOn: "C2PA manifests in every render (currently a TEST certificate, not on the C2PA trust list)",
      env: ["C2PA_CERT_FILE and C2PA_KEY_FILE, or C2PA_CERT_PEM and C2PA_KEY_PEM"],
      whenMissing: "Renders are refused: every output must carry a manifest",
    },
    {
      key: "email-codes",
      name: "Work-email codes (Resend)",
      configured: set("RESEND_API_KEY"),
      turnsOn: "Brands can verify a work email other than their sign-in email with a 6-digit code",
      env: ["RESEND_API_KEY", "MAIL_FROM (optional)"],
      whenMissing: "Only the email a brand signs in with (proven by Dynamic) can verify its domain; otherwise it shows as an unverified brand",
    },
    {
      key: "brand-kyb",
      name: "Brand KYB (Didit)",
      configured: false,
      turnsOn: "Business verification of brands, beyond the domain check",
      env: ["not built yet"],
      whenMissing: "Not run: brand badges cover the email domain only, and nothing claims a business check",
    },
  ];
}

export function isConfigured(key: string): boolean {
  return integrations().find((i) => i.key === key)?.configured ?? false;
}
