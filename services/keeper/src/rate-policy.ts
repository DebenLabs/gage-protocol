import type { PriceSample } from "./state.js";

export const TARGET_BPS = 6_000;
// Keep new postings below the refresh threshold, with room for small price moves.
export const MAX_POST_BPS = 6_250n;
export const ALERT_BPS = 6_250n;
export const REFRESH_BPS = 6_500n;
export const STOP_BPS = 7_000n;
export const WINDOW = 86_400;
export const MAX_AGE = 600;
export const MAX_GAP = 900;
const WAD = 10n ** 18n;

export interface Rates {
  rate7: bigint; rate21: bigint; priceUSDGPerSGAGE: bigint; lenderShareBps: number; set: boolean;
}

/** The value of the uncapped-by-budget allocation per fee, in basis points at spot. */
export function rewardValueBps(r: Rates, spot: bigint): bigint {
  if (!r.set || (r.rate7 === 0n && r.rate21 === 0n)) return 0n;
  if (r.priceUSDGPerSGAGE <= 0n || spot <= 0n) throw Error("invalid-reward-price");
  const rate = r.rate7 > r.rate21 ? r.rate7 : r.rate21;
  const cap = 8n * 10n ** 23n / r.priceUSDGPerSGAGE;
  return (rate < cap ? rate : cap) * spot * 10_000n / (WAD * 1_000_000n);
}

/** Strict 24h sample validation; never labels a single fresh spot as a TWAP. */
export function validatedPrice(samples: readonly PriceSample[], now: number, spot: bigint, allowDownside = false) {
  if (!Number.isSafeInteger(now) || spot <= 0n) throw Error("price-invalid");
  const start = now - WINDOW;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (!Number.isSafeInteger(p.t) || p.t > now || !/^\d+$/.test(p.priceUSDGPerSGAGE) || BigInt(p.priceUSDGPerSGAGE) <= 0n) throw Error("price-sample-invalid");
    if (i > 0 && p.t === sorted[i - 1]!.t) throw Error("price-sample-duplicate");
  }
  const latest = sorted.at(-1);
  if (!latest || now - latest.t > MAX_AGE) throw Error("price-history-stale");
  const before = sorted.filter(s => s.t <= start).at(-1);
  const points = [...(before ? [before] : []), ...sorted.filter(s => s.t > start)];
  if (points.length < 2) throw Error("price-history-insufficient");
  let weighted = 0n;
  let covered = 0;
  let maxGap = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const end = points[i + 1]?.t ?? now;
    const gap = end - p.t;
    maxGap = Math.max(maxGap, gap);
    if (gap > MAX_GAP) throw Error("price-history-gap");
    const dt = end - Math.max(p.t, start);
    weighted += BigInt(p.priceUSDGPerSGAGE) * BigInt(dt);
    covered += dt;
  }
  if (covered * 100 < WINDOW * 95) throw Error("price-history-coverage");
  const twap = (weighted + BigInt(covered) - 1n) / BigInt(covered);
  const downsideDivergence = spot * 100n < twap * 80n;
  if (spot * 100n > twap * 120n || (downsideDivergence && !allowDownside)) throw Error("price-spot-twap-divergence");
  const price = spot > twap ? spot : twap;
  if (price >= 1n << 128n) throw Error("price-out-of-range");
  return { price, twap, spot, downsideDivergence, samples: points.length, coverageSeconds: covered, maxGapSeconds: maxGap, source: "validated-twap" as const };
}
