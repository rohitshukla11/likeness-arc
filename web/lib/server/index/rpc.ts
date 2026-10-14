import "server-only";
/**
 * The RPC fallback for the indexer: scans the four contracts' logs from the deployment block,
 * 9,999 blocks per eth_getLogs call (Arc's public endpoint allows 10,000), and caches the decoded
 * rows plus a cursor in STORE_DIR/../index-<chain>.json so later reads only fetch new blocks.
 * Current state (status, terms, balances) is always read from the contracts, never from this cache.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { parseEventLogs, type Address, type Hex, type Log } from "viem";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { LicenseRegistryAbi } from "@/lib/abi/LicenseRegistry";
import { deployment, requireAddress } from "@/lib/deployment";
import { isLocalFork, pub, rpcUrl, singleton } from "../chain";
import { fileGet, filePut, localDir } from "../files";
import { emptyHistory, type History } from "./types";

// Blocks per eth_getLogs (Arc's public endpoint allows 10,000; about 85 minutes at 2 blocks/s) and
// requests in flight. On Vercel the outgoing IP is shared with other apps, so the public RPC's per-IP limit is hit sooner: ask less at once.
const chunk = () => BigInt(process.env.INDEX_LOG_CHUNK ?? 9_999);
const concurrency = () => Number(process.env.INDEX_SCAN_CONCURRENCY ?? (process.env.VERCEL ? 2 : 8));
const abi = [...CreatorRegistryAbi, ...LicenseRegistryAbi, ...LicenseEscrowAbi];

function cacheFile(): string {
  // One cache per RPC endpoint and start block: a local fork and the public testnet must never share
  // rows, and each new fork (same local URL, later start block) starts from an empty cache.
  const tag = createHash("sha256").update(`${rpcUrl()}|${startBlock()}`).digest("base64url").slice(0, 16);
  return `index-${deployment.chainId}-${tag}.json`;
}

// The cache is kept with the other files (./files): on disk locally, in private Blob on Vercel, so a
// fresh serverless instance does not rescan from the deployment block.
const cachePaths = (name: string) => [`cache/${name}`, path.join(/*turbopackIgnore: true*/ localDir("INDEX_CACHE_DIR", ""), name)] as const;
const SAVE_EVERY = 5 * 60_000;
const HEAD_MARGIN = 2n;

/** Milliseconds one call may spend scanning: 20 s on Vercel (a function has minutes, a page view less), unbounded locally. */
const scanBudget = () => Number(process.env.INDEX_SCAN_BUDGET_MS ?? (process.env.VERCEL ? 20_000 : 0));

/** The cache's file name for the current RPC and start block (scripts/seed-index-cache.ts uploads it). */
export const indexCacheName = () => cacheFile();
const lastSaved = new Map<string, number>();

function startBlock(): bigint {
  return BigInt(process.env.INDEX_START_BLOCK ?? deployment.startBlock ?? 0);
}

type State = { history: History; scanning: Promise<History> | null; loaded: boolean };
const state = singleton<Map<string, State>>("rpc-index", () => new Map());

async function load(file: string): Promise<History> {
  try {
    const raw = await fileGet(...cachePaths(file));
    if (!raw) throw new Error("no cache");
    const h = JSON.parse(raw.toString("utf8")) as History;
    if (h.source === "rpc" && typeof h.head === "number" && h.head >= Number(startBlock()) - 1) {
      // Caches written before AttestationUpdated was tracked: no updateAttestation had been sent yet
      // when that field was added (2026-10-10), so an empty list is exact, and a rescan is avoided.
      h.attestationUpdates ??= [];
      return h;
    }
  } catch {}
  return emptyHistory("rpc", Number(startBlock()) - 1);
}

const lower = (a: string) => a.toLowerCase() as Address;

function apply(h: History, logs: Log[], times: Map<bigint, number>) {
  const events = parseEventLogs({ abi, logs, strict: false });
  for (const e of events) {
    const at = {
      block: Number(e.blockNumber),
      timestamp: times.get(e.blockNumber!) ?? 0,
      tx: e.transactionHash as Hex,
      logIndex: Number(e.logIndex),
    };
    const a = e.args as Record<string, unknown>;
    const src = lower(e.address);
    switch (e.eventName) {
      case "CreatorRegistered":
        h.creators.push({ ...at, creator: lower(a.creator as string), payout: lower(a.payout as string), referenceSetHash: a.referenceSetHash as Hex });
        break;
      case "AttestationUpdated":
        h.attestationUpdates.push({ ...at, creator: lower(a.creator as string), referenceSetHash: a.referenceSetHash as Hex, verifiedAt: Number(a.verifiedAt) });
        break;
      case "TermsSet":
        h.terms.push({ ...at, creator: lower(a.creator as string) });
        break;
      case "AllRevoked":
        h.revokeAlls.push({ ...at, creator: lower(a.creator as string), epoch: Number(a.epoch) });
        break;
      case "Suspended":
        h.suspensions.push({ ...at, creator: lower(a.creator as string), suspended: a.suspended as boolean, epoch: Number(a.epoch) });
        break;
      case "LicenceIssued":
        h.licences.push({
          ...at,
          id: String(a.id),
          creator: lower(a.creator as string),
          licensee: lower(a.licensee as string),
          category: Number(a.category),
          regions: Number(a.regions),
          end: Number(a.end),
          renderCap: Number(a.renderCap),
          pricePerRender: String(a.pricePerRender),
          purposeHash: a.purposeHash as Hex,
          autoApproved: a.autoApproved as boolean,
        });
        break;
      case "LicenceRevoked":
        h.revocations.push({ ...at, id: String(a.id), creator: lower(a.creator as string) });
        break;
      case "Deposited":
        h.deposits.push({ ...at, licenceId: String(a.licenceId), licensee: lower(a.licensee as string), amount: String(a.amount) });
        break;
      case "RenderPaid":
        h.renders.push({
          ...at,
          licenceId: String(a.licenceId),
          renderIndex: Number(a.renderIndex),
          assetHash: a.assetHash as Hex,
          agent: lower(a.agent as string),
          payout: lower(a.payout as string),
          creatorAmount: String(a.creatorAmount),
          fee: String(a.fee),
        });
        break;
      case "Refunded":
        h.refunds.push({ ...at, licenceId: String(a.licenceId), licensee: lower(a.licensee as string), amount: String(a.amount) });
        break;
    }
    void src;
  }
}

async function scan(h: History, file: string): Promise<History> {
  const client = pub();
  let head: bigint;
  try {
    // Arc's public endpoint is load-balanced: a backend a block or two behind answers -32014 for the
    // newest blocks, so the scan stops just short of the reported head and picks them up next time
    // (not on a local fork, which has one backend).
    head = (await client.getBlockNumber({ cacheTime: 0 })) - (isLocalFork() ? 0n : HEAD_MARGIN);
  } catch (e) {
    console.error(JSON.stringify({ service: "index", error: `head: ${(e as Error).message.split("\n")[0]}` }));
    return h;
  }
  const from = BigInt(h.head) + 1n;
  if (from > head) return h;
  const address = [requireAddress("CreatorRegistry"), requireAddress("LicenseRegistry"), requireAddress("LicenseEscrow")];

  const ranges: [bigint, bigint][] = [];
  const CHUNK = chunk();
  for (let b = from; b <= head; b += CHUNK) ranges.push([b, b + CHUNK - 1n > head ? head : b + CHUNK - 1n]);
  // A long gap (a fresh deployment with no cache) is scanned in slices: stop at the budget, keep what
  // was read, and continue on the next call. History is then complete up to h.head, never beyond it.
  const started = Date.now();
  let to = from - 1n;
  const logs: Log[] = [];
  // A batch that still fails after the client's retries (a rate-limited RPC) ends this call's scan: what
  // was read before it is kept, and the next call continues from there. Pages are never failed by it.
  const n = concurrency();
  for (let i = 0; i < ranges.length; i += n) {
    const slice = ranges.slice(i, i + n);
    let batch: Log[][];
    try {
      batch = (await Promise.all(slice.map(([fromBlock, toBlock]) => client.getLogs({ address, fromBlock, toBlock })))) as Log[][];
    } catch (e) {
      console.error(JSON.stringify({ service: "index", error: `logs from ${slice[0][0]}: ${(e as Error).message.split("\n").find((l) => l.startsWith("Details:")) ?? (e as Error).message.split("\n")[0]}` }));
      break;
    }
    for (const b of batch) logs.push(...b);
    to = slice[slice.length - 1][1];
    if (scanBudget() && Date.now() - started > scanBudget()) break;
  }
  if (to < from) return h;
  logs.sort((x, y) => Number(x.blockNumber! - y.blockNumber!) || Number(x.logIndex! - y.logIndex!));

  // Arc's RPC returns blockTimestamp on each log; anything else falls back to the block header.
  // Arc timestamps are non-decreasing (blocks can share one), so rows are ordered by block and log index.
  const times = new Map<bigint, number>();
  for (const l of logs) {
    const ts = (l as Log & { blockTimestamp?: Hex | bigint }).blockTimestamp;
    if (ts !== undefined) times.set(l.blockNumber!, Number(ts));
  }
  const missing = [...new Set(logs.map((l) => l.blockNumber!))].filter((b) => !times.has(b));
  for (const b of missing) times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));

  apply(h, logs, times);
  h.head = Number(to);
  // Save when there are new events, else at most every few minutes (each save is a Blob write on Vercel).
  if (logs.length > 0 || Date.now() - (lastSaved.get(file) ?? 0) > SAVE_EVERY) {
    await filePut(...cachePaths(file), JSON.stringify(h), { contentType: "application/json", overwrite: true }).catch(() => {});
    lastSaved.set(file, Date.now());
  }
  return h;
}

/** History up to the current head. Concurrent callers share one scan. */
export async function rpcHistory(): Promise<History> {
  const file = cacheFile();
  let s = state.get(file);
  if (!s) {
    s = { history: emptyHistory("rpc"), scanning: null, loaded: false };
    state.set(file, s);
  }
  if (!s.loaded) {
    s.history = await load(file);
    s.loaded = true;
  }
  s.history.attestationUpdates ??= []; // see load()
  // Every caller gets a scan that starts no earlier than its call, queued behind any scan in flight
  // (which may have started before the block the caller cares about). A scan with no new blocks is
  // one eth_blockNumber call.
  const current = s;
  const mine: Promise<History> = (current.scanning ?? Promise.resolve(current.history))
    .catch(() => current.history)
    .then(() => scan(current.history, file))
    .catch(() => current.history)
    .then((h) => (current.history = h))
    .finally(() => {
      if (current.scanning === mine) current.scanning = null;
    });
  current.scanning = mine;
  return mine;
}
