#!/bin/sh
# Copy this machine's configuration to the linked Vercel project (Production) for the Arc mainnet
# deployment: public settings and API keys from web/.env.local, signing keys and the C2PA chain from the
# secrets folder (default ../.secrets, i.e. ~/likeness-arc/.secrets). Values are read from the files and
# piped to the Vercel CLI; none is printed.
#
#   cd web && npx vercel login && npx vercel link     # once, in your own terminal
#   sh scripts/vercel-env.sh https://your-domain
#
# It sets NEXT_PUBLIC_APP_URL and NEXT_PUBLIC_RP_ID from the URL, shows the linked project's name and
# asks you to type it back before writing anything. It never sets DYNAMIC_DELEGATION_ENABLED or any
# Dynamic delegation or server-wallet secret: delegated access stays off on Arc mainnet.
# Then redeploy without the build cache (NEXT_PUBLIC_* values are compiled into the page).
set -eu
URL="${1:?usage: sh scripts/vercel-env.sh https://your-domain}"
HOST="$(printf '%s' "$URL" | sed -E 's#^https?://##; s#/.*$##')"
# Passkeys bind to the RP ID: the parent domain covers both example.com and www.example.com
# (a *.vercel.app host is used as is).
case "$HOST" in
  *.vercel.app) RP_ID="$HOST" ;;
  *) RP_ID="$(printf '%s' "$HOST" | sed -E 's#^www\.##')" ;;
esac
VERCEL="npx --yes vercel@63.1.2"
[ -f .env.local ] || { echo "run from web/ (no .env.local here)"; exit 1; }
SECRETS="${SECRETS_DIR:-../.secrets}"
[ -d "$SECRETS" ] || { echo "no secrets folder at $SECRETS"; exit 1; }

# Which project is this? `vercel link` writes web/.vercel/project.json, or ../.vercel/repo.json when
# linked from the repository root. Show it and ask, so nothing is written to the wrong one.
if [ -f .vercel/project.json ]; then
  PROJECT="$(sed -nE 's/.*"projectName" *: *"([^"]*)".*/\1/p' .vercel/project.json)"
elif [ -f ../.vercel/repo.json ]; then
  PROJECT="$(python3 -c 'import json;print(next((p["name"] for p in json.load(open("../.vercel/repo.json")).get("projects",[]) if p.get("directory")=="web"),""))')"
else
  echo "not linked: run 'npx vercel link' in web/ first"; exit 1
fi
echo "Linked Vercel project: ${PROJECT:-(name not recorded)}"
echo "Site URL:              https://$HOST   (passkey RP ID: $RP_ID)"
echo "Secrets folder:        $(cd "$SECRETS" && pwd)"
printf "Write the Production environment variables to this project? Type the project name to confirm: "
read -r ANSWER < /dev/tty
if [ -z "$PROJECT" ] || [ "$ANSWER" != "$PROJECT" ]; then echo "Not confirmed; nothing was written."; exit 1; fi

local_value() { grep -E "^$1=" .env.local | tail -1 | cut -d= -f2- || true; }

set_value() { # name value [sensitive]
  if [ -z "$2" ]; then echo "skip $1 (no value)"; return; fi
  printf '%s' "$2" | $VERCEL env add "$1" production --force ${3:+--sensitive} >/dev/null 2>&1 && echo "set  $1" || echo "FAIL $1"
}
set_file() { # name file
  if [ ! -s "$2" ]; then echo "skip $1 (no $2)"; return; fi
  $VERCEL env add "$1" production --force --sensitive < "$2" >/dev/null 2>&1 && echo "set  $1" || echo "FAIL $1"
}

# Public (compiled into the page)
set_value NEXT_PUBLIC_RP_ID "$RP_ID"
set_value NEXT_PUBLIC_APP_URL "https://$HOST"
set_value NEXT_PUBLIC_DYNAMIC_ENV_ID "$(local_value NEXT_PUBLIC_DYNAMIC_ENV_ID)"
set_value NEXT_PUBLIC_ARC_RPC_URL "$(local_value NEXT_PUBLIC_ARC_RPC_URL)"

# Storage on Vercel: private Blob (connect a Blob store to the project for its token)
set_value STORE_DRIVER blob

# Server signing keys and the C2PA chain, from the secrets folder
set_file ATTESTER_PRIVATE_KEY "$SECRETS/attester.key"
set_file RENDER_AGENT_PRIVATE_KEY "$SECRETS/render-agent.key"
set_file DRIP_PRIVATE_KEY "$SECRETS/drip.key"
set_file C2PA_CERT_PEM "$SECRETS/c2pa/signer.pem"
set_file C2PA_KEY_PEM "$SECRETS/c2pa/signer.key"

# Integrations and settings, from .env.local
for name in DIDIT_API_KEY GEMINI_API_KEY ARC_RPC_URL DIDIT_WEBHOOK_SECRET; do
  set_value "$name" "$(local_value "$name")" sensitive
done
for name in VERIFICATION_LEVEL DIDIT_WORKFLOW_ID_FREE DIDIT_WORKFLOW_ID_FULL DIDIT_CAPTURE_MATCH_THRESHOLD \
  LOCAL_FACE_MATCH_THRESHOLD SAMPLE_FACE_MATCH_THRESHOLD DRIP_AMOUNT_USDC DRIP_PER_IP_PER_HOUR DRIP_PER_HOUR \
  RENDERS_PER_DAY GEMINI_IMAGE_MODEL GEMINI_IMAGE_SIZE GEMINI_FILTER_MODEL ENVIO_GRAPHQL_URL; do
  set_value "$name" "$(local_value "$name")"
done

echo "done. Redeploy without the build cache, then open https://$HOST/status"
