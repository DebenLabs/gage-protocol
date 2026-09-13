/** Small statistics helpers: median, realised volatility on irregular samples, drawdown. */

export function medianBig(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

export interface PricePoint {
  /** unix seconds */
  at: number;
  /** strictly positive price, any consistent unit */
  price: number;
}

export interface RealisedVol {
  /** variance of log price per second */
  variancePerSecond: number;
  /** annualised volatility as a fraction, e.g. 0.8 = 80% */
  annualised: number;
  samples: number;
  spanSeconds: number;
}

const YEAR_SECONDS = 365 * 24 * 3600;

/**
 * Realised variance per second from log returns over irregular intervals: sum(r_i^2) / sum(dt_i), the zero-mean
 * estimator. Needs at least `minReturns` returns spanning at least `minSpanSeconds`.
 */
export function realisedVolatility(points: readonly PricePoint[], minReturns = 24, minSpanSeconds = 2 * 24 * 3600): RealisedVol | null {
  const sorted = [...points].filter((p) => p.price > 0 && Number.isFinite(p.price)).sort((a, b) => a.at - b.at);
  let sumSq = 0;
  let sumDt = 0;
  let returns = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const dt = cur.at - prev.at;
    if (dt <= 0) continue;
    const r = Math.log(cur.price / prev.price);
    sumSq += r * r;
    sumDt += dt;
    returns += 1;
  }
  if (returns < minReturns || sumDt < minSpanSeconds) return null;
  const variancePerSecond = sumSq / sumDt;
  return {
    variancePerSecond,
    annualised: Math.sqrt(variancePerSecond * YEAR_SECONDS),
    samples: sorted.length,
    spanSeconds: sorted[sorted.length - 1]!.at - sorted[0]!.at
  };
}

/** Volatility of log price over a horizon: sigma * sqrt(T). */
export function horizonSigma(variancePerSecond: number, horizonSeconds: number): number {
  return Math.sqrt(variancePerSecond * horizonSeconds);
}

/** Largest peak-to-trough fall as a fraction of the peak (0 = none, 0.5 = halved). */
export function maxDrawdown(points: readonly PricePoint[]): number | null {
  const sorted = [...points].filter((p) => p.price > 0).sort((a, b) => a.at - b.at);
  if (sorted.length < 2) return null;
  let peak = sorted[0]!.price;
  let worst = 0;
  for (const p of sorted) {
    if (p.price > peak) peak = p.price;
    const dd = (peak - p.price) / peak;
    if (dd > worst) worst = dd;
  }
  return worst;
}
