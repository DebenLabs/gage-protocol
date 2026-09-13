import { describe, expect, it } from "vitest";
import {
  getNextSqrtPriceFromAmount0RoundingUp,
  getNextSqrtPriceFromAmount1RoundingDown,
  priceImpactBps,
  swapExactIn,
  swapExactOut
} from "../src/math/swap.js";
import { getSqrtPriceAtTick } from "../src/math/tickMath.js";

const sp = getSqrtPriceAtTick(0);
const L = 10n ** 18n;

describe("SqrtPriceMath vectors", () => {
  it("next sqrt price from amounts", () => {
    expect(getNextSqrtPriceFromAmount0RoundingUp(sp, L, 10n ** 17n, true)).toBe(72025602285694852357767227579n);
    expect(getNextSqrtPriceFromAmount1RoundingDown(sp, L, 10n ** 17n, true)).toBe(87150978765690771352898345369n);
    expect(getNextSqrtPriceFromAmount0RoundingUp(sp, L, 10n ** 17n, false)).toBe(88031291682515930659493278152n);
    expect(getNextSqrtPriceFromAmount1RoundingDown(sp, L, 10n ** 17n, false)).toBe(71305346262837903834189555302n);
  });
});

describe("swaps inside the active range", () => {
  const pool = { sqrtPriceX96: sp, liquidity: 10n ** 24n, feePips: 3000n };

  it("exact in, small trade at 1:1 loses about the fee plus impact", () => {
    const r = swapExactIn(pool, 10n ** 18n, true);
    // fee 0.3%, impact ~ amount/L = 1e-6
    expect(r.feePaid).toBe(3n * 10n ** 15n);
    expect(r.amountOut).toBeGreaterThan(996_000_000_000_000_000n);
    expect(r.amountOut).toBeLessThan(997_000_000_000_000_000n);
    expect(r.sqrtPriceAfterX96).toBeLessThan(sp);
    expect(priceImpactBps(pool, 10n ** 18n, r.amountOut, true)).toBeLessThanOrEqual(1);
  });

  it("exact out is consistent with exact in", () => {
    const out = swapExactIn(pool, 10n ** 18n, false);
    const back = swapExactOut(pool, out.amountOut, false);
    // input needed for that output is within a few wei of the original input
    expect(back.amountIn - 10n ** 18n).toBeLessThan(10n);
    expect(back.amountIn - 10n ** 18n).toBeGreaterThanOrEqual(-10n);
  });

  it("price impact grows with size", () => {
    const small = swapExactIn(pool, 10n ** 20n, true);
    const large = swapExactIn(pool, 10n ** 23n, true);
    expect(priceImpactBps(pool, 10n ** 23n, large.amountOut, true)).toBeGreaterThan(
      priceImpactBps(pool, 10n ** 20n, small.amountOut, true)
    );
    // 10% of the virtual reserves moves the price roughly 9-10%
    expect(priceImpactBps(pool, 10n ** 23n, large.amountOut, true)).toBeGreaterThan(800);
    expect(priceImpactBps(pool, 10n ** 23n, large.amountOut, true)).toBeLessThan(1000);
  });

  it("refuses an empty pool", () => {
    expect(() => swapExactIn({ ...pool, liquidity: 0n }, 1n, true)).toThrow(/no active liquidity/);
    expect(() => swapExactOut(pool, 10n ** 30n, true)).toThrow(/not enough/);
  });
});
