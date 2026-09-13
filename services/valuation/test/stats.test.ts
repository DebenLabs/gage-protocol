import { describe, expect, it } from "vitest";
import { horizonSigma, maxDrawdown, medianBig, realisedVolatility } from "../src/math/stats.js";

describe("median", () => {
  it("odd and even counts, unsorted input, bigint", () => {
    expect(medianBig([5n, 1n, 3n])).toBe(3n);
    expect(medianBig([4n, 1n, 3n, 2n])).toBe(2n);
    expect(medianBig([10n ** 30n, 1n])).toBe((10n ** 30n + 1n) / 2n);
    expect(medianBig([])).toBeNull();
  });
});

describe("realised volatility", () => {
  it("returns null with too little data", () => {
    expect(realisedVolatility([{ at: 0, price: 1 }, { at: 3600, price: 1.1 }])).toBeNull();
  });

  it("recovers a known volatility from a synthetic hourly series", () => {
    // deterministic +/- 1% alternating hourly moves: sigma_hourly = 0.01 (approximately, since ln)
    const points = [];
    let price = 100;
    for (let i = 0; i < 24 * 30; i++) {
      points.push({ at: i * 3600, price });
      price *= i % 2 === 0 ? 1.01 : 1 / 1.01;
    }
    const v = realisedVolatility(points)!;
    const rHour = Math.log(1.01);
    expect(Math.sqrt(v.variancePerSecond * 3600)).toBeCloseTo(rHour, 6);
    // sqrt-of-time scaling to a 7-day horizon
    expect(horizonSigma(v.variancePerSecond, 7 * 24 * 3600)).toBeCloseTo(rHour * Math.sqrt(7 * 24), 6);
    expect(v.annualised).toBeCloseTo(rHour * Math.sqrt(365 * 24), 6);
  });

  it("ignores ordering and zero-dt duplicates", () => {
    const a = [];
    for (let i = 0; i < 100; i++) a.push({ at: i * 3600, price: 10 + (i % 3) });
    const shuffled = [...a].reverse();
    shuffled.push({ at: 3600, price: 11 }); // duplicate timestamp
    expect(realisedVolatility(shuffled)!.variancePerSecond).toBeCloseTo(realisedVolatility(a)!.variancePerSecond, 12);
  });
});

describe("drawdown", () => {
  it("peak to trough", () => {
    expect(maxDrawdown([{ at: 1, price: 10 }, { at: 2, price: 12 }, { at: 3, price: 6 }, { at: 4, price: 9 }])).toBeCloseTo(0.5);
    expect(maxDrawdown([{ at: 1, price: 1 }, { at: 2, price: 2 }])).toBe(0);
    expect(maxDrawdown([{ at: 1, price: 1 }])).toBeNull();
  });
});
