import { describe, expect, it } from "vitest";
import { checkpointPerformance, earnPerformance, performanceFromCheckpoint, reserveRatio, shareAssets, shareRatio, type EarnPerformanceCheckpoint, type EarnValueSample } from "../src/lib/earn-accounting";

it("matches full-history performance using constant-size checkpoints and same-block flow replacement", () => {
  let checkpoint: EarnPerformanceCheckpoint | undefined;
  const history = new Map<bigint, EarnValueSample>();
  const samples = [{ block: 1n, value: 100n, flow: 0n }, { block: 1n, value: 100n, flow: 100n }, { block: 2n, value: 110n, flow: 0n }, { block: 3n, value: 160n, flow: 50n }, { block: 4n, value: 0n, flow: -160n }, { block: 5n, value: 100n, flow: 100n }, { block: 6n, value: 120n, flow: 0n }];
  for (const sample of samples) {
    const row = { ...sample, asOf: Number(sample.block) };
    checkpoint = checkpointPerformance(checkpoint, row);
    history.set(sample.block, { ...row, flow: row.flow + (history.get(sample.block)?.flow ?? 0n) });
    const full = earnPerformance([...history.values()]);
    expect(performanceFromCheckpoint(checkpoint)).toEqual({ valueUSDG: String(full.value), depositsUSDG: String(full.deposits), withdrawalsUSDG: String(full.withdrawals), profitUSDG: String(full.profit), twrBps: full.twrBps, sinceAt: full.sinceAt, samples: full.samples });
    expect(Object.keys(checkpoint)).toEqual(["before", "last"]);
  }
  expect(() => checkpointPerformance(checkpoint, { block: 1n, asOf: 1, value: 0n, flow: 0n })).toThrow(/backwards/);
});

describe("Earn exact indexed conversions", () => {
  it("uses Morpho virtual shares and floors each account independently", () => {
    const ratio = reserveRatio(200n, 100n * 10n ** 12n, 10n ** 12n);
    expect(ratio).toEqual({ numerator: 201n, denominator: 101n * 10n ** 12n });
    expect(shareAssets(20n * 10n ** 12n, ratio)).toBe(39n);
    expect(shareAssets(0n, ratio)).toBe(0n);
  });
  it("prices strategy shares exactly as HybridVault.convertToAssets, virtual shares included", () => {
    // 390 total assets over 398e12 issued shares plus 1e12 virtual: one share of 1e18 is worth 979949 USDG units.
    const ratio = shareRatio(390n, 398n * 10n ** 12n, 10n ** 12n);
    expect(ratio).toEqual({ numerator: 391n, denominator: 399n * 10n ** 12n });
    expect(shareAssets(10n ** 18n, ratio)).toBe(979949n);
    expect(shareAssets(10n ** 12n, ratio)).toBe(0n);
  });
  it("rejects a zero virtual share denominator rather than inventing a price", () => {
    expect(() => reserveRatio(0n, 0n, 0n)).toThrow(/virtual/);
    expect(() => shareRatio(0n, 0n, 0n)).toThrow(/virtual/);
  });
});
