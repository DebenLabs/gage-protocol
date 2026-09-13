/**
 * Pure arithmetic for the weekly proposal: pool prices from sqrtPriceX96, a sampled time-weighted average, and
 * the rate that makes a term budget last the week under the 80% rule.
 */
import type { Address } from "viem";
import type { PriceSample } from "./state.js";

export interface Rational {
  num: bigint;
  den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function reduce(r: Rational): Rational {
  if (r.den === 0n) throw new Error("zero denominator");
  const g = gcd(r.num, r.den);
  return g <= 1n ? r : { num: r.num / g, den: r.den / g };
}

export function mul(a: Rational, b: Rational): Rational {
  return reduce({ num: a.num * b.num, den: a.den * b.den });
}

const Q192 = 1n << 192n;

/** Raw units of currency1 per raw unit of currency0, from a v4 slot0. */
export function poolPrice(sqrtPriceX96: bigint): Rational {
  return reduce({ num: sqrtPriceX96 * sqrtPriceX96, den: Q192 });
}

/** Price of `token` in raw units of the pool's other currency. */
export function priceOfIn(
  token: Address,
  pool: { currency0: Address; currency1: Address },
  sqrtPriceX96: bigint,
): Rational {
  const p = poolPrice(sqrtPriceX96);
  if (token.toLowerCase() === pool.currency0.toLowerCase()) return p;
  if (token.toLowerCase() === pool.currency1.toLowerCase()) return reduce({ num: p.den, den: p.num });
  throw new Error(`token ${token} is not in the pool`);
}

/** Floor of a rational scaled by `scale`. */
export function toScaled(r: Rational, scale: bigint): bigint {
  return (r.num * scale) / r.den;
}

export interface Twap {
  /** USDG raw units per 1e18 sGAGE. */
  price: bigint;
  samples: number;
  /** Seconds of the window the samples cover. */
  coverageSeconds: number;
  source: "twap" | "spot";
}

/**
 * Time-weighted average of a step function: each sample holds until the next one, the last one until `now`.
 * Samples older than the window are clipped to its start. Returns `undefined` with no samples.
 */
export function timeWeightedAverage(samples: readonly PriceSample[], windowStart: number, now: number): Twap | undefined {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const inWindow = sorted.filter((s) => s.t >= windowStart);
  const before = sorted.filter((s) => s.t < windowStart).at(-1);
  const points = before === undefined ? inWindow : [{ ...before, t: windowStart }, ...inWindow];
  if (points.length === 0) return undefined;
  let weighted = 0n;
  let total = 0n;
  for (let i = 0; i < points.length; i += 1) {
    const cur = points[i]!;
    const next = points[i + 1];
    const end = next === undefined ? now : next.t;
    const dt = BigInt(Math.max(0, end - cur.t));
    weighted += BigInt(cur.priceUSDGPerSGAGE) * dt;
    total += dt;
  }
  if (total === 0n) {
    const last = points.at(-1)!;
    return { price: BigInt(last.priceUSDGPerSGAGE), samples: points.length, coverageSeconds: 0, source: "spot" };
  }
  return {
    price: weighted / total,
    samples: points.length,
    coverageSeconds: Number(total),
    source: points.length > 1 ? "twap" : "spot",
  };
}

export interface RateInput {
  /** sGAGE wei budgeted to each term for the target epoch. */
  budget7: bigint;
  budget21: bigint;
  /** Fees expected over a full week per term, USDG raw units. */
  fees7: bigint;
  fees21: bigint;
  /** 10^USDG decimals. */
  usdgUnit: bigint;
  /** USDG raw units per 1e18 sGAGE. */
  priceUSDGPerSGAGE: bigint;
  maxRewardShareBps: number;
}

export interface RateProposal {
  rate7: bigint;
  rate21: bigint;
  /** Highest rate at which `reward <= maxShare × fee` holds at the posted price. */
  rateCap: bigint;
  capped7: boolean;
  capped21: boolean;
  notes: string[];
}

const WAD = 10n ** 18n;
const UINT128_MAX = (1n << 128n) - 1n;

/**
 * rate = budget / fees (sGAGE per USDG_UNIT of fee) so the term's budget is exactly consumed by a week of fees
 * like last week's, capped so that `fee × rate <= maxShare × fee × 1e18 / price` for every deal.
 */
export function proposeRates(i: RateInput): RateProposal {
  if (i.priceUSDGPerSGAGE <= 0n) throw new Error("price must be positive");
  const rateCap = (BigInt(i.maxRewardShareBps) * WAD * i.usdgUnit) / (10_000n * i.priceUSDGPerSGAGE);
  const notes: string[] = [];
  const one = (budget: bigint, fees: bigint, term: string): { rate: bigint; capped: boolean } => {
    if (fees === 0n) {
      notes.push(`no ${term} fees in the basis window: rate set to the cap`);
      return { rate: rateCap, capped: true };
    }
    const uncapped = (budget * i.usdgUnit) / fees;
    if (uncapped > rateCap) {
      notes.push(`${term} budget exceeds ${i.maxRewardShareBps / 100}% of expected fees at this price: capped`);
      return { rate: rateCap, capped: true };
    }
    return { rate: uncapped, capped: false };
  };
  const r7 = one(i.budget7, i.fees7, "7-day");
  const r21 = one(i.budget21, i.fees21, "21-day");
  if (r7.rate > UINT128_MAX || r21.rate > UINT128_MAX) throw new Error("rate does not fit uint128");
  return { rate7: r7.rate, rate21: r21.rate, rateCap, capped7: r7.capped, capped21: r21.capped, notes };
}

/** Scales a partial-window sum up to a full window. Pure; returns the input when the window is complete. */
export function extrapolate(sum: bigint, elapsedSeconds: number, windowSeconds: number): bigint {
  if (elapsedSeconds <= 0) return sum;
  if (elapsedSeconds >= windowSeconds) return sum;
  return (sum * BigInt(windowSeconds)) / BigInt(elapsedSeconds);
}
