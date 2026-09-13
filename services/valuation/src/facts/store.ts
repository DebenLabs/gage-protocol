/**
 * Hourly samples persisted as JSON so the 7-day market-cap median and the 30-day drawdown build up over time.
 * Writes are atomic (temp file + rename); samples older than 31 days are pruned.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Hex } from "viem";

export interface PoolSample {
  at: number;
  block: number;
  sqrtPriceX96: string;
  liquidity: string;
}

export interface TokenSample {
  at: number;
  /** Whole USDG per whole token, decimal string. Market caps below remain raw USDG. */
  priceUSDG: string;
  /** USDG raw units */
  mcapUSDG: string;
}

interface StoreFile {
  version: 1;
  pools: Record<string, PoolSample[]>;
  tokens: Record<string, TokenSample[]>;
}

const RETENTION_SECONDS = 31 * 86_400;

export class SampleStore {
  private data: StoreFile = { version: 1, pools: {}, tokens: {} };

  constructor(private readonly file: string | null) {
    if (file !== null && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreFile>;
        if (parsed.version === 1) this.data = { version: 1, pools: parsed.pools ?? {}, tokens: parsed.tokens ?? {} };
      } catch {
        // a corrupt store starts over; samples are a convenience, never a source of truth
      }
    }
  }

  static inMemory(): SampleStore {
    return new SampleStore(null);
  }

  addPoolSample(poolId: Hex, sample: PoolSample): void {
    const list = this.data.pools[poolId.toLowerCase()] ?? [];
    list.push(sample);
    this.data.pools[poolId.toLowerCase()] = list;
  }

  addTokenSample(token: string, sample: TokenSample): void {
    const list = this.data.tokens[token.toLowerCase()] ?? [];
    list.push(sample);
    this.data.tokens[token.toLowerCase()] = list;
  }

  /** Repair only an exact reviewed legacy seed; preserve unrelated observations at the same timestamp. */
  seedTokenSample(token: string, original: TokenSample, normalized: TokenSample): void {
    const list = this.data.tokens[token.toLowerCase()] ?? [];
    const existing = list.find(s => s.at === original.at);
    if (!existing) this.addTokenSample(token, normalized);
    else if (existing.priceUSDG === original.priceUSDG && existing.mcapUSDG === original.mcapUSDG) existing.priceUSDG = normalized.priceUSDG;
  }

  poolSamples(poolId: Hex, since: number): PoolSample[] {
    return (this.data.pools[poolId.toLowerCase()] ?? []).filter((s) => s.at >= since);
  }

  tokenSamples(token: string, since: number): TokenSample[] {
    return (this.data.tokens[token.toLowerCase()] ?? []).filter((s) => s.at >= since).sort((a, b) => a.at - b.at);
  }

  /** Oldest sample time for a token, or null. */
  oldestTokenSample(token: string): number | null {
    const list = this.data.tokens[token.toLowerCase()] ?? [];
    return list.length === 0 ? null : Math.min(...list.map((s) => s.at));
  }

  prune(now: number): void {
    const cutoff = now - RETENTION_SECONDS;
    for (const [k, v] of Object.entries(this.data.pools)) this.data.pools[k] = v.filter((s) => s.at >= cutoff);
    for (const [k, v] of Object.entries(this.data.tokens)) this.data.tokens[k] = v.filter((s) => s.at >= cutoff);
  }

  save(): void {
    if (this.file === null) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  counts(): { pools: number; tokens: number; samples: number } {
    const samples = Object.values(this.data.pools).reduce((a, l) => a + l.length, 0) + Object.values(this.data.tokens).reduce((a, l) => a + l.length, 0);
    return { pools: Object.keys(this.data.pools).length, tokens: Object.keys(this.data.tokens).length, samples };
  }
}

/** Median of the last seven days of market-cap samples; null until the samples span seven days. */
export function mcapMedian7d(store: SampleStore, token: string, now: number, medianFn: (v: bigint[]) => bigint | null): { median: bigint | null; samples: number; spanDays: number } {
  const since = now - 7 * 86_400;
  const samples = store.tokenSamples(token, since);
  const oldest = store.oldestTokenSample(token);
  const spanDays = oldest === null ? 0 : (now - oldest) / 86_400;
  // one hour of tolerance so a sampler tick that lands just after the boundary still counts
  if (samples.length === 0 || spanDays < 7 - 1 / 24) return { median: null, samples: samples.length, spanDays };
  return { median: medianFn(samples.map((s) => BigInt(s.mcapUSDG))), samples: samples.length, spanDays };
}
