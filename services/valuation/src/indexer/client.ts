/**
 * Thin client for services/indexer (docs/api.md). Every call is best-effort: a missing indexer, a timeout or an
 * unexpected shape yields null plus a reason, and the caller says so in its `basis`.
 */
import type { Hex } from "viem";

export interface IndexedSwap {
  at: number;
  sqrtPriceX96: bigint;
  amount0: bigint;
  amount1: bigint;
}

export interface IndexerPool {
  poolId: Hex | null;
  sqrtPriceX96: bigint | null;
  liquidity: bigint | null;
  swaps: IndexedSwap[];
}

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface IndexerResult<T> {
  value: T | null;
  reason: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function big(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

function parseSwaps(v: unknown): IndexedSwap[] {
  if (!Array.isArray(v)) return [];
  const out: IndexedSwap[] = [];
  for (const raw of v) {
    const r = asRecord(raw);
    if (r === null) continue;
    const at = typeof r.at === "number" ? r.at : Number(r.at);
    const sqrtPriceX96 = big(r.sqrtPriceX96);
    const amount0 = big(r.amount0) ?? 0n;
    const amount1 = big(r.amount1) ?? 0n;
    if (!Number.isFinite(at) || sqrtPriceX96 === null) continue;
    out.push({ at, sqrtPriceX96, amount0, amount1 });
  }
  return out;
}

/** What the service needs from the indexer; IndexerClient implements it and tests substitute a fake. */
export interface Indexer {
  health(): Promise<IndexerResult<{ ok: boolean; indexedBlock: number | null }>>;
  pool(poolNameOrId?: string): Promise<IndexerResult<IndexerPool>>;
}

export class IndexerClient implements Indexer {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly timeoutMs = 3000
  ) {}

  private async get(path: string): Promise<IndexerResult<unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}${path}`, { signal: ctrl.signal });
      if (!res.ok) return { value: null, reason: `indexer returned ${res.status} for ${path}` };
      return { value: await res.json(), reason: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { value: null, reason: `indexer unreachable at ${this.baseUrl} (${msg})` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** services/indexer serves its JSON health at /health/indexer (Ponder owns /health); older builds used /health. */
  async health(): Promise<IndexerResult<{ ok: boolean; indexedBlock: number | null }>> {
    let r = await this.get("/health/indexer");
    if (asRecord(r.value) === null) r = await this.get("/health");
    const rec = asRecord(r.value);
    if (rec === null) return { value: null, reason: r.reason ?? "bad /health shape" };
    return { value: { ok: rec.ok === true, indexedBlock: typeof rec.indexedBlock === "number" ? rec.indexedBlock : null }, reason: null };
  }

  /**
   * GET /pool, optionally scoped to a pool. docs/api.md defines PoolSummary; a `swaps` array (the indexer's swaps
   * table: pool, at, amount0, amount1, sqrtPriceX96) is read when present and treated as absent otherwise.
   */
  async pool(poolNameOrId?: string): Promise<IndexerResult<IndexerPool>> {
    const r = await this.get(poolNameOrId === undefined ? "/pool" : `/pool?pool=${encodeURIComponent(poolNameOrId)}`);
    const rec = asRecord(r.value);
    if (rec === null) return { value: null, reason: r.reason ?? "bad /pool shape" };
    const summary = asRecord(rec.pool);
    const poolId = summary !== null && typeof summary.poolId === "string" ? (summary.poolId.toLowerCase() as Hex) : null;
    if (poolNameOrId !== undefined && poolId !== null && poolNameOrId.startsWith("0x") && poolId !== poolNameOrId.toLowerCase()) {
      return { value: null, reason: `indexer /pool serves ${poolId}, not ${poolNameOrId}` };
    }
    return {
      value: {
        poolId,
        sqrtPriceX96: summary === null ? null : big(summary.sqrtPriceX96),
        liquidity: summary === null ? null : big(summary.liquidity),
        swaps: parseSwaps(rec.swaps)
      },
      reason: null
    };
  }
}
