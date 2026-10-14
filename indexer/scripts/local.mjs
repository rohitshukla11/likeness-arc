// Runs the indexer locally without Docker: an embedded PostgreSQL (npm `embedded-postgres`, real
// Postgres binaries in node_modules) on port 5433, then `envio start` against it with Hasura off.
//
//   pnpm local
//
// Data source: HyperSync when ENVIO_API_TOKEN is set (env or indexer/.env), with the Arc RPC as
// fallback; otherwise the RPC alone (100 blocks per eth_getLogs). The app reads the tables through
// ENVIO_PG_URL=postgres://postgres:testing@localhost:5433/envio-dev (printed below).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env.ENVIO_PG_PORT ?? 5433);
const DB = process.env.ENVIO_PG_DATABASE ?? "envio-dev";
const env = { ...process.env };
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}

const pg = new EmbeddedPostgres({ databaseDir: "./.pgdata", user: "postgres", password: "testing", port: PORT, persistent: true });
if (!existsSync("./.pgdata/PG_VERSION")) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase(DB);
} catch {
  // already exists
}

const hypersync = !!env.ENVIO_API_TOKEN;
Object.assign(env, {
  ENVIO_PG_HOST: "localhost",
  ENVIO_PG_PORT: String(PORT),
  ENVIO_PG_USER: "postgres",
  ENVIO_PG_PASSWORD: "testing",
  ENVIO_PG_DATABASE: DB,
  ENVIO_HASURA: "false",
  ENVIO_RPC_FOR: hypersync ? "fallback" : "sync",
});
console.log(`Postgres on :${PORT}. Data source: ${hypersync ? "HyperSync (ENVIO_API_TOKEN set), RPC fallback" : "Arc RPC (no ENVIO_API_TOKEN)"}.`);
console.log(`For the app: ENVIO_PG_URL=postgres://postgres:testing@localhost:${PORT}/${DB}`);

const child = spawn("npx", ["envio", "start"], { stdio: "inherit", env });
const stop = async () => {
  child.kill("SIGINT");
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", async (code) => {
  await pg.stop();
  process.exit(code ?? 0);
});
