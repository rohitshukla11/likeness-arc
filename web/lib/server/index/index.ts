import "server-only";
/**
 * Where protocol history comes from:
 *  - the Envio HyperIndex in indexer/, through ENVIO_GRAPHQL_URL (Hasura) or ENVIO_PG_URL (its
 *    Postgres, for a local run without Docker). The indexer itself syncs through HyperSync when
 *    ENVIO_API_TOKEN is set and through the Arc RPC otherwise;
 *  - when neither URL is set, or the indexer is unreachable, the cached RPC log scan in ./rpc.ts.
 * Every answer carries its source and the UI shows which one served it.
 */
import { envioHistory } from "./envio";
import { rpcHistory } from "./rpc";
import type { History } from "./types";

export type { History } from "./types";

export function historySource(): "envio" | "rpc" {
  return process.env.ENVIO_GRAPHQL_URL || process.env.ENVIO_PG_URL ? "envio" : "rpc";
}

export async function history(): Promise<History> {
  if (historySource() === "envio") {
    try {
      return await envioHistory({ graphql: process.env.ENVIO_GRAPHQL_URL, pg: process.env.ENVIO_PG_URL });
    } catch (e) {
      console.warn(JSON.stringify({ service: "index", result: "envio-unreachable-fallback-rpc", error: (e as Error).message.slice(0, 200) }));
    }
  }
  return rpcHistory();
}
