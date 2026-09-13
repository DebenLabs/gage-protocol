import { describe, expect, it } from "vitest";
import { gageNeededToPair, solveZap } from "../src/math/zap.js";
import { getAmountsForLiquidity } from "../src/math/liquidityAmounts.js";
import { getSqrtPriceAtTick } from "../src/math/tickMath.js";
import { swapExactIn } from "../src/math/swap.js";

const sp = getSqrtPriceAtTick(0);
const pool = { sqrtPriceX96: sp, liquidity: 10n ** 24n, feePips: 30_000n }; // 3% fee like the GAGE/sGAGE pool

describe("zap solver", () => {
  for (const sgageIsCurrency0 of [true, false]) {
    it(`pairs the remainder exactly at the post-swap price (sGAGE is currency${sgageIsCurrency0 ? 0 : 1})`, () => {
      const amount = 10n ** 21n; // 1000 sGAGE
      const r = solveZap({
        pool,
        amountSgage: amount,
        sgageIsCurrency0,
        sqrtLowerX96: getSqrtPriceAtTick(-6000),
        sqrtUpperX96: getSqrtPriceAtTick(6000)
      });
      expect(r.sgageToSell).toBeGreaterThan(0n);
      expect(r.sgageToSell).toBeLessThan(amount);
      expect(r.sgageToSell + r.sgageRemaining).toBe(amount);
      // symmetric range at 1:1 -> about half is sold (a bit more, because the sale moves the price)
      expect(r.sgageToSell).toBeGreaterThan(amount / 2n);
      expect(r.sgageToSell).toBeLessThan((amount * 53n) / 100n);
      expect(r.feeOnSold).toBe((r.sgageToSell * 3n + 99n) / 100n);
      // the swap re-run agrees with the solver
      const swap = swapExactIn(pool, r.sgageToSell, sgageIsCurrency0);
      expect(swap.amountOut).toBe(r.gageOut);
      // nothing meaningful is left over: the position uses (almost) everything on both sides
      const used = getAmountsForLiquidity(r.sqrtPriceAfterX96, getSqrtPriceAtTick(-6000), getSqrtPriceAtTick(6000), r.liquidity);
      const sgageUsed = sgageIsCurrency0 ? used.amount0 : used.amount1;
      const gageUsed = sgageIsCurrency0 ? used.amount1 : used.amount0;
      expect(r.sgageRemaining - sgageUsed).toBeLessThan(10n ** 6n);
      expect(r.gageOut - gageUsed).toBeLessThan(10n ** 6n);
      // selling one wei less would not cover the GAGE needed
      const less = swapExactIn(pool, r.sgageToSell - 1n, sgageIsCurrency0);
      const need = gageNeededToPair(amount - r.sgageToSell + 1n, less.sqrtPriceAfterX96, getSqrtPriceAtTick(-6000), getSqrtPriceAtTick(6000), sgageIsCurrency0);
      expect(need).not.toBeNull();
      expect(less.amountOut < need!).toBe(true);
    });
  }

  it("sells nothing when the range holds only sGAGE at the current price", () => {
    // sGAGE is currency0, range entirely above the price -> all currency0
    const r = solveZap({ pool, amountSgage: 10n ** 21n, sgageIsCurrency0: true, sqrtLowerX96: getSqrtPriceAtTick(600), sqrtUpperX96: getSqrtPriceAtTick(1200) });
    expect(r.sgageToSell).toBe(0n);
    expect(r.sgageRemaining).toBe(10n ** 21n);
  });

  it("sells everything when the range holds only GAGE even after the sale", () => {
    // sGAGE is currency0, range far below the price: selling 1000 sGAGE into 1e24 liquidity barely moves it
    const r = solveZap({ pool, amountSgage: 10n ** 21n, sgageIsCurrency0: true, sqrtLowerX96: getSqrtPriceAtTick(-12000), sqrtUpperX96: getSqrtPriceAtTick(-6000) });
    expect(r.sgageToSell).toBe(10n ** 21n);
    expect(r.sgageRemaining).toBe(0n);
    expect(r.amount0).toBe(0n);
  });

  it("gageNeededToPair is monotone in the amount", () => {
    const a = gageNeededToPair(10n ** 18n, sp, getSqrtPriceAtTick(-600), getSqrtPriceAtTick(600), true)!;
    const b = gageNeededToPair(2n * 10n ** 18n, sp, getSqrtPriceAtTick(-600), getSqrtPriceAtTick(600), true)!;
    expect(b >= 2n * a - 2n && b <= 2n * a + 2n).toBe(true);
  });
});
