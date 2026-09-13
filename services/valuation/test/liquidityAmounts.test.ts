import { describe, expect, it } from "vitest";
import {
  getAmount0Delta,
  getAmount1Delta,
  getAmountsForLiquidity,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getLiquidityForAmounts
} from "../src/math/liquidityAmounts.js";
import { getSqrtPriceAtTick } from "../src/math/tickMath.js";
import { uncollectedFees } from "../src/math/fees.js";
import { Q128, MAX_UINT256, isqrt, mulDiv, mulDivRoundingUp } from "../src/math/fullMath.js";

const L = 10n ** 18n;
const sp = getSqrtPriceAtTick(0);
const sa = getSqrtPriceAtTick(-600);
const sb = getSqrtPriceAtTick(600);

describe("LiquidityAmounts / SqrtPriceMath (vectors from forge)", () => {
  it("amounts for liquidity in range", () => {
    const { amount0, amount1 } = getAmountsForLiquidity(sp, sa, sb, L);
    expect(amount0).toBe(29553010879137169n);
    expect(amount1).toBe(29553010879137169n);
  });

  it("liquidity for amounts round-trips within rounding", () => {
    const { amount0, amount1 } = getAmountsForLiquidity(sp, sa, sb, L);
    expect(getLiquidityForAmounts(sp, sa, sb, amount0, amount1)).toBe(999999999999999976n);
    expect(getLiquidityForAmount0(sp, sb, amount0)).toBe(999999999999999976n);
    expect(getLiquidityForAmount1(sa, sp, amount1)).toBe(999999999999999976n);
  });

  it("one-sided below and above the range", () => {
    expect(getAmountsForLiquidity(getSqrtPriceAtTick(-1000), sa, sb, L)).toEqual({ amount0: 60005999255049926n, amount1: 0n });
    expect(getAmountsForLiquidity(getSqrtPriceAtTick(1000), sa, sb, L)).toEqual({ amount0: 0n, amount1: 60005999255049926n });
  });

  it("deltas with rounding", () => {
    expect(getAmount0Delta(sa, sb, L, true)).toBe(60005999255049927n);
    expect(getAmount0Delta(sa, sb, L, false)).toBe(60005999255049926n);
    expect(getAmount1Delta(sa, sb, L, true)).toBe(60005999255049927n);
    expect(getAmount1Delta(sa, sb, L, false)).toBe(60005999255049926n);
  });
});

describe("fees and helpers", () => {
  it("uncollected fees from fee growth deltas, wrapping", () => {
    expect(uncollectedFees(5n * Q128, 2n * Q128, 7n)).toBe(21n);
    // wrapped: now < last by 3*Q128 modulo 2^256
    expect(uncollectedFees(1n * Q128, MAX_UINT256 - 2n * Q128 + 1n, 1n)).toBe(3n);
  });

  it("mulDiv rounding and isqrt", () => {
    expect(mulDiv(7n, 3n, 2n)).toBe(10n);
    expect(mulDivRoundingUp(7n, 3n, 2n)).toBe(11n);
    expect(mulDivRoundingUp(8n, 3n, 2n)).toBe(12n);
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    const big = 123456789n * 10n ** 40n;
    const r = isqrt(big * big);
    expect(r).toBe(big);
    expect(isqrt(big * big + 1n)).toBe(big);
    expect(isqrt(big * big - 1n)).toBe(big - 1n);
  });
});
