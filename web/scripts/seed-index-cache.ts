/**
 * Upload this machine's RPC history cache to a deployment's private Blob store, so a new Vercel
 * deployment starts caught up instead of scanning over a million blocks through the public RPC.
 *
 *   BLOB_READ_WRITE_TOKEN=... pnpm index:seed-blob
 *
 * It first brings the local cache (web/.data) up to the current block, then uploads it under the
 * name the deployment looks for. That name depends on the RPC URL and start block, so run this with
 * the same ARC_RPC_URL / NEXT_PUBLIC_ARC_RPC_URL as the deployment. The cache holds only public
 * chain events.
 */
import { put } from "@vercel/blob";
import { readFileSync } from "node:fs";
import path from "node:path";
import { indexCacheName, rpcHistory } from "@/lib/server/index/rpc";

if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("set BLOB_READ_WRITE_TOKEN (the deployment's Blob store token)");
if (process.env.STORE_DRIVER === "blob") throw new Error("run with the local store: this reads the cache from web/.data");

async function main() {
  const h = await rpcHistory();
  const name = indexCacheName();
  const file = path.resolve(process.cwd(), process.env.INDEX_CACHE_DIR ?? ".data", name);
  const body = readFileSync(file, "utf8");
  const r = await put(`cache/${name}`, body, { access: "private", contentType: "application/json", allowOverwrite: true });
  console.log(`uploaded ${r.pathname}: history to block ${h.head}, ${h.creators.length} creators, ${(body.length / 1024).toFixed(0)} KiB`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
