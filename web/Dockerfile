# The web app as one long-lived container (Railway, Fly.io or any Docker host). Build context: web/.
# Data and the face models live on a volume mounted at /data, so they survive redeploys.
FROM node:22.23.3-bookworm-slim

# curl: the face-model download and the history warm-up in scripts/start.sh.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# pnpm 12 honours allowBuilds in pnpm-workspace.yaml, so the C2PA native binding's install script runs.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Public values are compiled into the browser bundle, so they must be set before the build (Railway
# passes service variables to ARGs of the same name).
ARG NEXT_PUBLIC_DYNAMIC_ENV_ID
ARG NEXT_PUBLIC_RP_ID
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_ARC_RPC_URL=https://rpc.mainnet.arc.io
ENV NEXT_PUBLIC_DYNAMIC_ENV_ID=$NEXT_PUBLIC_DYNAMIC_ENV_ID \
    NEXT_PUBLIC_RP_ID=$NEXT_PUBLIC_RP_ID \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_ARC_RPC_URL=$NEXT_PUBLIC_ARC_RPC_URL
RUN pnpm build

ENV NODE_ENV=production \
    STORE_DRIVER=local \
    STORE_DIR=/data/vault \
    DB_DIR=/data/db \
    RENDERS_DIR=/data/renders \
    INDEX_CACHE_DIR=/data \
    FACE_MODELS_DIR=/data/models \
    INDEX_SCAN_BUDGET_MS=20000
EXPOSE 3000
CMD ["sh", "scripts/start.sh"]
