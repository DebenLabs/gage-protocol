// Pure derivations behind `/stats`: calendar weeks, medians, basis-point ratios, the deal's phase on the
// Dashboard, and a price graph that values one token in another through the indexed v4 pools.
import { zeroAddress, type Address, type Hex } from "viem";

import { BPS, isExpired } from "./derive";
import { Q192, WAD } from "./pool";

export const HOUR = 3_600n;
export const DAY = 86_400n;
export const WEEK = 7n * DAY;
/** 1970-01-05 00:00 UTC, the first Monday of the unix era. */
const MONDAY_EPOCH = 345_600n;

/** Monday 00:00 UTC of the week containing `t`. */
export function weekStart(t: bigint): bigint {
  const offset = (((t - MONDAY_EPOCH) % WEEK) + WEEK) % WEEK;
  return t - offset;
}

/** The last `n` week starts, ascending, ending with the week containing `now`. */
export function lastWeeks(now: bigint, n: number): bigint[] {
  const current = weekStart(now);
  const out: bigint[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(current - BigInt(i) * WEEK);
  return out;
}

/** Median of a sample; the mean of the two middle values (floored) for an even count; null for an empty sample. */
export function median(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  const hi = sorted[mid];
  if (hi === undefined) return null;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1];
  return lo === undefined ? hi : (lo + hi) / 2n;
}

/** `part / whole` in basis points, null when the whole is zero. */
export function ratioBps(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  return Number((part * BPS) / whole);
}

/** Change from `before` to `now` in basis points, null when there is no `before` to compare against. */
export function changeBps(now: bigint, before: bigint): number | null {
  if (before <= 0n) return null;
  return Number(((now - before) * BPS) / before);
}

export type DealPhase = "LISTED" | "FUNDED" | "RECLAIMABLE" | "CLAIMABLE" | null;

type PhaseInput = {
  state: "LISTED" | "FUNDED" | "RECLAIMED" | "CLAIMED" | "CANCELLED";
  listingExpiry: bigint;
  expiry: bigint | null;
  graceEnd: bigint | null;
};

/**
 * The Dashboard's four live buckets. LISTED is a listing still taking bids; FUNDED runs until expiry; RECLAIMABLE
 * is the grace window, where only the borrower can act; CLAIMABLE is past grace, waiting on the lender. Settled
 * deals and expired listings fall in none (null).
 */
export function dealPhase(d: PhaseInput, now: bigint): DealPhase {
  if (d.state === "LISTED") return d.listingExpiry !== 0n && isExpired(d.listingExpiry, now) ? null : "LISTED";
  if (d.state !== "FUNDED" || d.expiry === null || d.graceEnd === null) return null;
  if (!isExpired(d.expiry, now)) return "FUNDED";
  return isExpired(d.graceEnd, now) ? "CLAIMABLE" : "RECLAIMABLE";
}

// ----------------------------------------------------------------- price graph

export type PoolPrice = { currency0: Address; currency1: Address; sqrtPriceX96: bigint };

/** currency1 raw units per currency0 raw unit, scaled by 1e18. */
export function rawPrice1Per0Wad(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * WAD) / Q192;
}

type Edge<P> = { to: Address; priceWad: bigint; pool: P };
type Path<P> = { priceWad: bigint; pools: P[] };

/**
 * Values one token in another by walking the indexed pools: a direct pool first, else the fewest hops (a meme
 * through its stock pool, GAGE through ETH). Prices are raw-per-raw, so decimals never enter; the caller scales
 * for display with `scaleDecimals`. `route` names the pools a price crosses, so a caller can replay their swaps.
 */
export class PriceGraph<P extends PoolPrice = PoolPrice> {
  private readonly edges = new Map<Address, Edge<P>[]>();

  constructor(pools: readonly P[], private readonly wrappedNative?: Address) {
    for (const pool of pools) {
      if (pool.sqrtPriceX96 === 0n) continue;
      const price1Per0 = rawPrice1Per0Wad(pool.sqrtPriceX96);
      if (price1Per0 === 0n) continue;
      this.add(pool.currency0, pool.currency1, price1Per0, pool);
      this.add(pool.currency1, pool.currency0, (WAD * WAD) / price1Per0, pool);
    }
  }

  /** Only the deployment's canonical wrapper is interchangeable with native ETH, at 1:1. */
  private canonical(token: Address): Address {
    const lower = token.toLowerCase() as Address;
    return lower === this.wrappedNative?.toLowerCase() ? zeroAddress : lower;
  }

  private add(from: Address, to: Address, priceWad: bigint, pool: P): void {
    from = this.canonical(from);
    to = this.canonical(to);
    this.edges.set(from, [...(this.edges.get(from) ?? []), { to, priceWad, pool }]);
  }

  /** The fewest-hop path from `from` to `to`: its price and the pools crossed in order; null beyond `maxHops`. */
  private search(from: Address, to: Address, maxHops: number): Path<P> | null {
    // Canonicalise without consuming a pool hop, including intermediate WETH pool currencies.
    from = this.canonical(from);
    to = this.canonical(to);
    if (from === to) return { priceWad: WAD, pools: [] };
    let frontier: ({ token: Address } & Path<P>)[] = [{ token: from, priceWad: WAD, pools: [] }];
    const seen = new Set<Address>([from]);
    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const next: typeof frontier = [];
      for (const { token, priceWad, pools } of frontier) {
        for (const edge of this.edges.get(token) ?? []) {
          const combined = (priceWad * edge.priceWad) / WAD;
          const crossed = [...pools, edge.pool];
          if (edge.to === to) return { priceWad: combined, pools: crossed };
          if (seen.has(edge.to)) continue;
          seen.add(edge.to);
          next.push({ token: edge.to, priceWad: combined, pools: crossed });
        }
      }
      frontier = next;
    }
    return null;
  }

  /** `to` raw per `from` raw, 1e18-scaled; null when no path of at most `maxHops` pools exists. */
  priceWad(from: Address, to: Address, maxHops = 3): bigint | null {
    return this.search(from, to, maxHops)?.priceWad ?? null;
  }

  /** The pools `priceWad` crosses from `from` to `to`, in order (none for the same token); null when unpriced. */
  route(from: Address, to: Address, maxHops = 3): P[] | null {
    return this.search(from, to, maxHops)?.pools ?? null;
  }

  /** `amount` raw units of `from`, in raw units of `to`; null when the pair cannot be priced. */
  value(amount: bigint, from: Address, to: Address): bigint | null {
    const price = this.priceWad(from, to);
    return price === null ? null : (amount * price) / WAD;
  }
}

export type PoolSwap = { poolId: Hex; at: bigint; sqrtPriceX96: bigint };
export type PricePoint = { t: bigint; priceWad: bigint };

/**
 * A price series: `price` of the pools' state at each of `times` (ascending), starting from `start` (the pools as
 * of the first time) and replaying `swapRows` (ascending) as they happen. A time the pools cannot price is left out.
 */
export function replayPrices<P extends PoolPrice & { poolId: Hex }>(
  start: readonly P[],
  swapRows: readonly PoolSwap[],
  times: readonly bigint[],
  price: (pools: readonly P[]) => bigint | null,
): PricePoint[] {
  const state = new Map(start.map((p) => [p.poolId, p]));
  const out: PricePoint[] = [];
  let next = 0;
  for (const t of times) {
    while (next < swapRows.length) {
      const s = swapRows[next];
      if (s === undefined || s.at > t) break;
      const pool = state.get(s.poolId);
      if (pool !== undefined) state.set(s.poolId, { ...pool, sqrtPriceX96: s.sqrtPriceX96 });
      next++;
    }
    const wad = price([...state.values()]);
    if (wad !== null) out.push({ t, priceWad: wad });
  }
  return out;
}

/** Turns a raw-per-raw WAD price into a unit-per-unit WAD price for display. */
export function scaleDecimals(priceWad: bigint, fromDecimals: number, toDecimals: number): bigint {
  const shift = fromDecimals - toDecimals;
  return shift >= 0 ? priceWad * 10n ** BigInt(shift) : priceWad / 10n ** BigInt(-shift);
}

/** Splits `total` into per-token shares in basis points; the largest share absorbs the rounding so they sum to 10000. */
export function sharesBps<K>(parts: readonly [K, bigint][]): [K, number][] {
  const total = parts.reduce((acc, [, v]) => acc + v, 0n);
  if (total <= 0n) return parts.map(([k]) => [k, 0]);
  const shares = parts.map(([k, v]) => [k, Number((v * BPS) / total)] as [K, number]);
  const sum = shares.reduce((acc, [, s]) => acc + s, 0);
  if (sum !== 10_000 && shares.length > 0) {
    let largest = 0;
    shares.forEach(([, s], i) => {
      const top = shares[largest];
      if (top !== undefined && s > top[1]) largest = i;
    });
    const top = shares[largest];
    if (top !== undefined) top[1] += 10_000 - sum;
  }
  return shares;
}
