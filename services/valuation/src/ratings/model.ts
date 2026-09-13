/** A versioned stress heuristic. No fitted probability, user reputation or popularity enters this model. */
export const MODEL = "gage-stress-v3";
export const GRADES = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "CC", "C", "D"] as const;
export type Grade = typeof GRADES[number] | "NR";
export type Factor = { name: string; score: number | null; detail: string; value?: string | null };
export type StressLane = "STOCK" | "ETH" | "MEME";
export type MarketEvidence = {
  profile?: "token" | "stock" | "pool";
  lane?: StressLane | null;
  reportedDepth?: string | null;
  requireReportedDepth?: boolean;
  price: string | null; depth: string | null; mcap: string | null;
  ageDays: number | null;
  /** Annualised realised volatility of the local price as a fraction (0.5 = 50%); null or undefined until measured. */
  volatility?: number | null;
  topTen: number | null;
  at: number; decimals: number;
};
export type MarketRating = { grade: Grade; confidence: "low" | "moderate"; factors: Factor[]; reasons: string[] };
const clamp = (n: number) => Math.max(0, Math.min(100, n));
export function worse(a: Grade, b: Grade): Grade {
  return a === "NR" || b === "NR" ? "NR" : GRADES[Math.max(GRADES.indexOf(a), GRADES.indexOf(b))]!;
}
/** One band better, never above the provisional BBB ceiling. */
export function notchUp(g: Grade): Grade {
  return g === "NR" ? "NR" : GRADES[Math.max(GRADES.indexOf("BBB"), GRADES.indexOf(g) - 1)]!;
}
function logScore(raw: string | null, decimals: number, low: number, high: number): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw) / 10 ** decimals;
  return n > 0 && Number.isFinite(n) ? clamp(100 * Math.log(n / low) / Math.log(high / low)) : 0;
}
const gradeFor = (score: number): Grade => score >= 85 ? "BBB" : score >= 70 ? "BB" : score >= 55 ? "B" : score >= 35 ? "CCC" : score >= 15 ? "CC" : "C";
/** Annualised volatility: 15% scores 100, 1,500% scores 0, log scale between. */
export const VOLATILITY_ANCHORS = { calm: 0.15, wild: 15 } as const;
export const volatilityScore = (annualised: number): number =>
  clamp(100 * (1 - Math.log(Math.max(annualised, 1e-9) / VOLATILITY_ANCHORS.calm) / Math.log(VOLATILITY_ANCHORS.wild / VOLATILITY_ANCHORS.calm)));
const measuredVolatility = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v >= 0;
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

/**
 * Annualised volatility the loan stress applies per lane. The floor guards against a pool that prints few moves
 * (a stale stock-token pool can show 5% while the listed share moves 20%); the fallback applies while a market has
 * no measured history. Neither is an observed loss.
 */
export const LANE_VOLATILITY: Record<StressLane, { floor: number; fallback: number }> = {
  STOCK: { floor: 0.3, fallback: 0.45 }, ETH: { floor: 0.5, fallback: 0.8 }, MEME: { floor: 1, fallback: 3 },
};
export type StressVolatility = { annualised: number; source: "measured" | "floor" | "fallback" };
export function stressVolatility(lane: StressLane | null | undefined, measured: number | null | undefined): StressVolatility {
  const policy = LANE_VOLATILITY[lane ?? "MEME"];
  if (!measuredVolatility(measured)) return { annualised: policy.fallback, source: "fallback" };
  return measured >= policy.floor ? { annualised: measured, source: "measured" } : { annualised: policy.floor, source: "floor" };
}
const YEAR = 365 * 86_400;
/** Log-price standard deviation over a horizon: square-root-of-time scaling of the annualised figure. */
export const horizonSigma = (annualised: number, horizonSeconds: number): number => annualised * Math.sqrt(Math.max(0, horizonSeconds) / YEAR);
/** The price fall of a z standard-deviation move down over the horizon, as a fraction of the current price. */
export const shockFor = (sigma: number, z: number): number => 1 - Math.exp(-z * sigma);
/** How far the collateral can fall before the buyer's cost is uncovered, in standard deviations of the horizon. */
export function headroom(value: bigint, cost: bigint, sigma: number): number | null {
  if (cost <= 0n) return null;
  if (value <= 0n) return -Infinity;
  const distance = Math.log(Number(value) / Number(cost));
  return sigma > 0 ? distance / sigma : distance > 0 ? Infinity : distance < 0 ? -Infinity : 0;
}
/** Published policy bands on headroom; provisional anchors, not fitted probabilities. */
export const HEADROOM_BANDS: readonly [number, Grade][] = [[2.5, "BBB"], [2, "BB"], [1.5, "B"], [1, "CCC"], [0.5, "CC"]];
export function headroomGrade(sigmas: number | null): Grade {
  if (sigmas === null || Number.isNaN(sigmas)) return "NR";
  return HEADROOM_BANDS.find(([floor]) => sigmas >= floor)?.[1] ?? "C";
}
export function conservativeDepth(virtual: string | null, reported?: string | null, required = false): string | null {
  if (virtual === null || !/^\d+$/.test(virtual)) return null;
  const valid = reported !== null && reported !== undefined && /^\d+$/.test(reported);
  if (required && !valid) return null;
  return valid && BigInt(reported) < BigInt(virtual) ? reported : virtual;
}
export function assessMarket(e: MarketEvidence, now: number): MarketRating {
  const hasReportedDepth = e.reportedDepth !== null && e.reportedDepth !== undefined && /^\d+$/.test(e.reportedDepth);
  const depth = conservativeDepth(e.depth, e.reportedDepth, e.requireReportedDepth);
  const money = (raw: string | null) => raw === null || !/^\d+$/.test(raw) || !Number.isFinite(Number(raw)) ? null : `${new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(Number(raw) / 10 ** e.decimals)} USDG`;
  const vol = measuredVolatility(e.volatility) ? e.volatility : null;
  const measured = vol !== null;
  const factors: Factor[] = [
    { name: hasReportedDepth ? "Pool liquidity · conservative" : "Active liquidity · proxy", value: money(depth), score: logScore(depth, e.decimals, 5_000, 5_000_000), detail: hasReportedDepth ? "Lower of virtual reserves and provider-reported pool token quantities valued at local USDG prices. Neither is executable sale depth." : "Reported pool quantities are unavailable. Spot-valued virtual reserves alone do not establish executable sale depth." },
    { name: "Market cap", value: money(e.mcap), score: logScore(e.mcap, e.decimals, 100_000, 100_000_000), detail: "Supply times local price; no issuer or redemption guarantee." },
    { name: "Pool history", value: e.ageDays === null ? null : `${Math.floor(e.ageDays)} days`, score: e.ageDays === null ? null : clamp(100 * Math.log1p(Math.max(0, e.ageDays)) / Math.log1p(365)), detail: "Age of the pricing pool, not the age of the underlying company." },
    { name: "Volatility · 30d", value: vol === null ? null : `${pct(vol)} annualised`, score: vol === null ? null : volatilityScore(vol), detail: "Realised volatility of hourly local prices over the last 30 days, annualised: 15% scores 100 and 1,500% scores 0 on a log scale. Needs 24 hourly samples over two days; an unmeasured market is not scored as calm." },
    { name: "Top-ten share", score: e.topTen === null || !Number.isFinite(e.topTen) || e.topTen < 0 || e.topTen > 1 ? null : clamp(100 * (1 - e.topTen)), detail: "Top-ten share is an address-level concentration signal, not verified owner diversity." },
  ];
  if (factors[4]!.score !== null) factors[4]!.value = `${(e.topTen! * 100).toFixed(1)}%`;
  const reasons = ["Provisional stress model; no measured loss probability."];
  if (hasReportedDepth) reasons.push("Liquidity is bounded by reported pool reserves valued in USDG; concentrated virtual reserves cannot inflate this screen above that reported value.");
  if (e.requireReportedDepth && !hasReportedDepth) reasons.push("Fresh reported pool quantities are required; a missing source cannot improve the grade by falling back to virtual reserves.");
  if (!e.price || !Number.isFinite(Number(e.price)) || Number(e.price) <= 0 || factors[0]!.score === null || now - e.at > 600 || e.at > now + 30) {
    return { grade: "NR", confidence: "low", factors, reasons: [...reasons, "Fresh price and pool liquidity evidence are required."] };
  }
  if (e.profile === "stock") {
    // Token float, pool age and token-holder distribution are not company fundamentals.
    // Only observed stock-token liquidity and volatility enter this provisional collateral screen.
    const liquidity = factors[0]!;
    const volatility = { ...factors[3]!, name: "Stock-token volatility · 30d" };
    const score = measured ? Math.exp(0.5 * Math.log(Math.max(1, liquidity.score!)) + 0.5 * Math.log(Math.max(1, volatility.score!))) : liquidity.score!;
    // The issuer market is a second exit, so on-chain depth limits the grade one band less strictly than for a token.
    // Unknown history limits confidence and the ceiling once; it is never a fabricated wild observation.
    const grade = worse(worse(gradeFor(score), notchUp(gradeFor(liquidity.score!))), measured ? "BBB" : "BB");
    reasons.push("Stock-token collateral assessment, not the underlying company's credit rating.",
      "Token float, pool age and token-holder concentration do not measure the underlying company and are excluded.",
      measured ? "Observed stock-token volatility and on-chain liquidity determine the baseline; the grade can sit one band above the on-chain liquidity band because the issuer market is another exit." : "Price history is incomplete. The baseline is capped at BB with low confidence; missing history is not scored as a loss.",
      "Issuer, redemption and executable exit-depth risks are not fully measured. No access to the underlying stock market is assumed.",
      "AAA, AA and A await outcome calibration; D requires verified impairment.");
    return { grade, confidence: measured ? "moderate" : "low", factors: [liquidity, volatility], reasons };
  }
  if (e.profile === "pool") {
    // The exact pool is an exit-liquidity constraint, not another token with missing market-cap/holder data.
    return { grade: gradeFor(factors[0]!.score!), confidence: "low", factors: [factors[0]!],
      reasons: [...reasons, "Exact-pool liquidity is an additional constraint; each underlying asset is assessed separately."] };
  }
  // Missing evidence is uncertainty, not a fabricated poor observation. Normalize observed weights.
  const ratio = depth !== null && e.mcap !== null && /^\d+$/.test(e.mcap) && BigInt(e.mcap) > 0n ? Number(depth) / Number(e.mcap) : null;
  factors.push({ name: "Liquidity / circulating value", value: ratio === null || !Number.isFinite(ratio) ? null : `${(ratio * 100).toFixed(2)}%`,
    score: ratio === null || !Number.isFinite(ratio) ? null : ratio <= 0 ? 0 : clamp(100 * Math.log(ratio / 0.001) / Math.log(100)),
    detail: "Liquidity screen divided by the assessed token float; 0.1% to 10% log anchors. A good ratio cannot offset low absolute liquidity. Not a company-market-cap ratio." });
  const weights = [0.3, 0.1, 0.15, 0.25, 0.1, 0.1];
  const measuredWeight = factors.reduce((sum, f, i) => sum + (f.score === null ? 0 : weights[i]!), 0);
  const score = Math.exp(factors.reduce((sum, f, i) => sum + (f.score === null ? 0 : weights[i]! * Math.log(Math.max(1, f.score))), 0) / measuredWeight);
  const missingSecondary = factors.some((f, i) => i !== 3 && f.score === null);
  // A large circulating value must never compensate for a thin exit-liquidity proxy.
  const measuredGrade = worse(gradeFor(score), gradeFor(factors[0]!.score!));
  // Volatility is the primary risk evidence: without it the baseline cannot pass B. Holder or age gaps only lower confidence.
  const grade = measured ? measuredGrade : worse(measuredGrade, "B");
  if (!measured) reasons.push("Volatility is unmeasured, which caps the grade at B with low confidence. An unknown market is not scored as calm or as wild.");
  if (missingSecondary) reasons.push("Some secondary evidence (holders, pool age or float) is unavailable and lowers confidence. Unknown factors are not scored as bad observations.");
  if (gradeFor(factors[0]!.score!) !== gradeFor(score)) reasons.push("The liquidity grade limits the baseline; market size cannot offset thin liquidity.");
  reasons.push("AAA, AA and A await outcome calibration; D requires verified impairment.");
  return { grade, confidence: measured && !missingSecondary ? "moderate" : "low", factors, reasons };
}

export function slice(total: bigint, mask: number): bigint {
  if (total < 0n || !Number.isInteger(mask) || mask < 1 || mask > 15) throw new Error("Invalid quarter selection");
  return [0, 1, 2, 3].reduce((sum, i) => sum + ((mask & (1 << i)) ? total / 4n + (BigInt(i) < total % 4n ? 1n : 0n) : 0n), 0n);
}
/** Plain coverage bands for a payment that is fixed in USDG, such as the repayment a claim buyer is owed. */
export function coverageGrade(value: bigint, cost: bigint): Grade {
  if (value < 0n || cost <= 0n) return "NR";
  const bps = value * 10_000n / cost;
  return bps >= 15_000n ? "BBB" : bps >= 12_500n ? "BB" : bps >= 10_000n ? "B" : bps >= 7_500n ? "CCC" : bps >= 5_000n ? "CC" : "C";
}
export type Shock = { shock: number; sigmas: number };
export type Scenario = Shock & { value: string; coverageBps: string; shortfall: string };
/** Unchanged, then one, two and three standard-deviation falls over the horizon, as percentages with one decimal. */
export function stressShocks(sigma: number): Shock[] {
  return [0, 1, 2, 3].map(sigmas => ({ sigmas, shock: sigmas === 0 ? 0 : Math.min(99.9, Math.max(0.1, Math.round(1000 * shockFor(sigma, sigmas)) / 10)) }));
}
export function stressScenarios(value: (shockBps: number) => bigint, cost: bigint, shocks: readonly Shock[]): Scenario[] {
  if (cost <= 0n) return [];
  return shocks.map(({ shock, sigmas }) => {
    const v = value(Math.round(shock * 100));
    return { shock, sigmas, value: v.toString(), coverageBps: (v * 10_000n / cost).toString(), shortfall: (cost > v ? cost - v : 0n).toString() };
  });
}
