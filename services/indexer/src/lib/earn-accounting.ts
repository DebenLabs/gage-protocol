/** One value sample per account sync: the USDG value after the block's flow, and the flow itself (deposits +, withdrawals -). */
export type EarnValueSample = { value: bigint; flow: bigint; asOf: number };

type PerformanceTotals = { growth: string; deposits: string; withdrawals: string; previous: string | null; sinceAt: number; samples: number };
/** Constant-size, replayable checkpoint. Keep the prefix before the last block so additional logs in that
 * block replace its end-of-block value and add their flow without counting the block twice. */
export type EarnPerformanceCheckpoint = { before: PerformanceTotals; last: { block: string; value: string; flow: string; asOf: number } };

const ONE = 10n ** 18n;
const emptyPerformance = (): PerformanceTotals => ({ growth: String(ONE), deposits: "0", withdrawals: "0", previous: null, sinceAt: 0, samples: 0 });
function appendPerformance(before: PerformanceTotals, sample: EarnValueSample): PerformanceTotals {
  if (sample.value < 0n) throw new Error("Earn value sample cannot be negative");
  const previous = before.previous === null ? null : BigInt(before.previous), preFlow = sample.value - sample.flow;
  const growth = previous !== null && previous > 0n && preFlow >= 0n ? BigInt(before.growth) * preFlow / previous : BigInt(before.growth);
  return { growth: String(growth), deposits: String(BigInt(before.deposits) + (sample.flow > 0n ? sample.flow : 0n)), withdrawals: String(BigInt(before.withdrawals) + (sample.flow < 0n ? -sample.flow : 0n)), previous: String(sample.value), sinceAt: before.samples ? before.sinceAt : sample.asOf, samples: before.samples + 1 };
}
export function checkpointPerformance(previous: EarnPerformanceCheckpoint | undefined, sample: EarnValueSample & { block: bigint }): EarnPerformanceCheckpoint {
  if (previous && BigInt(previous.last.block) > sample.block) throw new Error("Earn performance block moved backwards");
  const sameBlock = previous?.last.block === String(sample.block);
  const before = previous ? sameBlock ? previous.before : appendPerformance(previous.before, { value: BigInt(previous.last.value), flow: BigInt(previous.last.flow), asOf: previous.last.asOf }) : emptyPerformance();
  return { before, last: { block: String(sample.block), value: String(sample.value), flow: String(sample.flow + (sameBlock ? BigInt(previous!.last.flow) : 0n)), asOf: sample.asOf } };
}
export function performanceFromCheckpoint(checkpoint: EarnPerformanceCheckpoint) {
  const last = checkpoint.last, total = appendPerformance(checkpoint.before, { value: BigInt(last.value), flow: BigInt(last.flow), asOf: last.asOf });
  return { valueUSDG: last.value, depositsUSDG: total.deposits, withdrawalsUSDG: total.withdrawals, profitUSDG: String(BigInt(last.value) + BigInt(total.withdrawals) - BigInt(total.deposits)), twrBps: Number((BigInt(total.growth) - ONE) * 10000n / ONE), sinceAt: total.sinceAt, samples: total.samples };
}
/** Chain sub-period returns between flows: r_i = (value_i - flow_i) / value_(i-1); a zero-value start opens a new chain. */
export function earnPerformance(samples: EarnValueSample[]): { twrBps: number; deposits: bigint; withdrawals: bigint; profit: bigint; value: bigint; sinceAt: number; samples: number } {
  let growth = ONE, deposits = 0n, withdrawals = 0n, previous: bigint | null = null;
  for (const sample of samples) {
    if (sample.value < 0n) throw new Error("Earn value sample cannot be negative");
    if (sample.flow > 0n) deposits += sample.flow; else withdrawals -= sample.flow;
    const before = sample.value - sample.flow;
    if (previous !== null && previous > 0n && before >= 0n) growth = growth * before / previous;
    previous = sample.value;
  }
  const value = previous ?? 0n;
  return { twrBps: Number((growth - ONE) * 10_000n / ONE), deposits, withdrawals, profit: value + withdrawals - deposits, value, sinceAt: samples[0]?.asOf ?? 0, samples: samples.length };
}

/** Morpho V2 uses accrueInterestView assets and totalSupply including both pending fee-share amounts. */
export function reserveRatio(accruedAssets: bigint, accruedSupply: bigint, virtualShares: bigint) {
  if (virtualShares <= 0n) throw new Error("Invalid Earn reserve virtual shares");
  return { numerator: accruedAssets + 1n, denominator: accruedSupply + virtualShares };
}
/** The strategy's own conversion (HybridVault.convertToAssets): shares × (totalAssets + 1) / (totalSupply + VIRTUAL_SHARES). */
export function shareRatio(totalAssets: bigint, totalSupply: bigint, virtualShares: bigint) {
  if (virtualShares <= 0n) throw new Error("Invalid Earn virtual shares");
  return { numerator: totalAssets + 1n, denominator: totalSupply + virtualShares };
}
export function shareAssets(shares: bigint, ratio: { numerator: bigint; denominator: bigint }) {
  return shares * ratio.numerator / ratio.denominator;
}
