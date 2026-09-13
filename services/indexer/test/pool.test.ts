import { describe, expect, it } from "vitest";

import {
  Q96,
  WAD,
  amountsForLiquidity,
  depthInGage,
  formatWad,
  positionValueInGage,
  priceSgageInGageWad,
  sqrtPriceAtTick,
  tickInRange,
} from "../src/lib/pool";

describe("sqrtPriceAtTick", () => {
  it("matches TickMath at the reference ticks", () => {
    expect(sqrtPriceAtTick(0)).toBe(Q96);
    expect(sqrtPriceAtTick(-887272)).toBe(4295128739n);
    expect(sqrtPriceAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n);
    expect(sqrtPriceAtTick(1)).toBe(79232123823359799118286999568n);
  });
  it("rejects ticks outside the range", () => {
    expect(() => sqrtPriceAtTick(887273)).toThrow();
  });
});

describe("tickInRange", () => {
  it("is inclusive below and exclusive above", () => {
    expect(tickInRange(0, 0, 10)).toBe(true);
    expect(tickInRange(10, 0, 10)).toBe(false);
    expect(tickInRange(-1, 0, 10)).toBe(false);
  });
});

describe("amounts and value", () => {
  const price = sqrtPriceAtTick(0); // 1:1
  it("splits a symmetric in-range position evenly", () => {
    const { amount0, amount1 } = amountsForLiquidity(price, -6_000, 6_000, 10n ** 21n);
    expect(amount0 > 0n && amount1 > 0n).toBe(true);
    const diff = amount0 > amount1 ? amount0 - amount1 : amount1 - amount0;
    expect(diff * 1_000_000n < amount0).toBe(true);
  });
  it("holds only one asset outside the range", () => {
    expect(amountsForLiquidity(price, 100, 200, 10n ** 18n).amount1).toBe(0n);
    expect(amountsForLiquidity(price, -200, -100, 10n ** 18n).amount0).toBe(0n);
  });
  it("prices sGAGE in GAGE on either side of the pool", () => {
    expect(priceSgageInGageWad(price, true)).toBe(WAD);
    expect(priceSgageInGageWad(price, false)).toBe(WAD);
    expect(priceSgageInGageWad(0n, true)).toBe(0n);
    // 1 GAGE = 1,000 sGAGE: token1 per token0 is 1000 when GAGE is currency0, 0.001 when sGAGE is
    const sqrtOf = (n: bigint): bigint => {
      let x = n;
      let y = (x + 1n) >> 1n;
      while (y < x) {
        x = y;
        y = (x + n / x) >> 1n;
      }
      return x;
    };
    const sqrtPriceFor = (amount1: bigint, amount0: bigint): bigint => sqrtOf((amount1 << 192n) / amount0);
    const gageIsZero = sqrtPriceFor(1000n * WAD, WAD);
    const sgageIsZero = sqrtPriceFor(WAD, 1000n * WAD);
    expect(Number(priceSgageInGageWad(gageIsZero, false)) / 1e18).toBeCloseTo(0.001, 6);
    expect(Number(priceSgageInGageWad(sgageIsZero, true)) / 1e18).toBeCloseTo(0.001, 6);
  });
  it("values a position as its GAGE plus its sGAGE at the pool price", () => {
    const liquidity = 10n ** 21n;
    const { amount0, amount1 } = amountsForLiquidity(price, -6_000, 6_000, liquidity);
    expect(positionValueInGage(price, -6_000, 6_000, liquidity, true)).toBe(amount1 + amount0);
  });
  it("reports depth as twice the GAGE side of the active liquidity", () => {
    expect(depthInGage(price, 10n ** 18n, true)).toBe(2n * 10n ** 18n);
    expect(depthInGage(0n, 10n ** 18n, true)).toBe(0n);
  });
  it("formats a WAD with 18 fractional digits", () => {
    expect(formatWad(WAD)).toBe("1.000000000000000000");
    expect(formatWad(41n * 10n ** 15n)).toBe("0.041000000000000000");
  });
});
