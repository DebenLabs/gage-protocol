/**
 * Zap solver for Reinvest (spec 12.8): sell the fraction of the sGAGE that makes the remainder pair for the chosen
 * range at the post-swap price, using the pool's fee. Solved by bisection on the amount sold; every step uses the
 * in-range swap arithmetic and the standard liquidity maths, all in BigInt.
 */
import { getAmount0Delta, getAmount1Delta, getLiquidityForAmount0, getLiquidityForAmount1, getLiquidityForAmounts, getAmountsForLiquidity } from "./liquidityAmounts.js";
import { mulDivRoundingUp } from "./fullMath.js";
import { FEE_DENOMINATOR, swapExactIn, type PoolSwapState } from "./swap.js";

export interface ZapInput {
  pool: PoolSwapState;
  /** sGAGE the user brings, in wei. */
  amountSgage: bigint;
  /** True when sGAGE is currency0 of the GAGE/sGAGE pool. */
  sgageIsCurrency0: boolean;
  sqrtLowerX96: bigint;
  sqrtUpperX96: bigint;
}

export interface ZapResult {
  sgageToSell: bigint;
  gageOut: bigint;
  sgageRemaining: bigint;
  feeOnSold: bigint;
  sqrtPriceAfterX96: bigint;
  liquidity: bigint;
  /** Amounts that actually go into the position (dust stays in the wallet). */
  amount0: bigint;
  amount1: bigint;
}

/**
 * GAGE needed to pair `sgage` in the range at `sqrtP`. `null` means the range holds GAGE only at that price, so no
 * amount of sGAGE can be placed (the answer is "sell it all").
 */
export function gageNeededToPair(
  sgage: bigint,
  sqrtP: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
  sgageIsCurrency0: boolean
): bigint | null {
  if (sgageIsCurrency0) {
    if (sqrtP <= sqrtLower) return 0n; // all currency0 = all sGAGE
    if (sqrtP >= sqrtUpper) return null; // all currency1 = all GAGE
    const liquidity = getLiquidityForAmount0(sqrtP, sqrtUpper, sgage);
    return getAmount1Delta(sqrtLower, sqrtP, liquidity, true);
  }
  if (sqrtP >= sqrtUpper) return 0n; // all currency1 = all sGAGE
  if (sqrtP <= sqrtLower) return null; // all currency0 = all GAGE
  const liquidity = getLiquidityForAmount1(sqrtLower, sqrtP, sgage);
  return getAmount0Delta(sqrtP, sqrtUpper, liquidity, true);
}

function evaluate(input: ZapInput, sell: bigint): { gageOut: bigint; sqrtAfter: bigint; need: bigint | null } {
  const { amountOut, sqrtPriceAfterX96 } = swapExactIn(input.pool, sell, input.sgageIsCurrency0);
  const need = gageNeededToPair(
    input.amountSgage - sell,
    sqrtPriceAfterX96,
    input.sqrtLowerX96,
    input.sqrtUpperX96,
    input.sgageIsCurrency0
  );
  return { gageOut: amountOut, sqrtAfter: sqrtPriceAfterX96, need };
}

/** Smallest amount to sell such that the GAGE bought covers what the remainder needs. */
export function solveZap(input: ZapInput): ZapResult {
  if (input.sqrtLowerX96 >= input.sqrtUpperX96) throw new RangeError("range must have lower < upper");
  if (input.amountSgage < 0n) throw new RangeError("negative amount");
  let lo = 0n;
  let hi = input.amountSgage;
  const first = evaluate(input, 0n);
  if (first.need !== null && first.gageOut >= first.need) {
    hi = 0n;
  } else {
    // f(hi) with hi = amount: remainder 0 needs 0 GAGE unless the range is GAGE-only, where selling all is the answer.
    while (hi - lo > 1n) {
      const mid = (lo + hi) >> 1n;
      const e = evaluate(input, mid);
      if (e.need !== null && e.gageOut >= e.need) hi = mid;
      else lo = mid;
    }
  }
  const sell = hi;
  const e = evaluate(input, sell);
  const remaining = input.amountSgage - sell;
  const amount0 = input.sgageIsCurrency0 ? remaining : e.gageOut;
  const amount1 = input.sgageIsCurrency0 ? e.gageOut : remaining;
  const liquidity = getLiquidityForAmounts(e.sqrtAfter, input.sqrtLowerX96, input.sqrtUpperX96, amount0, amount1);
  const used = getAmountsForLiquidity(e.sqrtAfter, input.sqrtLowerX96, input.sqrtUpperX96, liquidity);
  return {
    sgageToSell: sell,
    gageOut: e.gageOut,
    sgageRemaining: remaining,
    feeOnSold: mulDivRoundingUp(sell, input.pool.feePips, FEE_DENOMINATOR),
    sqrtPriceAfterX96: e.sqrtAfter,
    liquidity,
    amount0: used.amount0,
    amount1: used.amount1
  };
}
