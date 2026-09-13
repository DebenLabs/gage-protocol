// SPDX-License-Identifier: MIT
// Uniswap-derived portions: see THIRD_PARTY_NOTICES.md and licenses/Uniswap-v4-*-MIT.txt.
/**
 * Liquidity <-> token amounts. getLiquidityForAmount* are ported from v4-periphery LiquidityAmounts.sol;
 * the amount-for-liquidity direction is v4-core SqrtPriceMath.getAmount0Delta / getAmount1Delta, which is what
 * v4 itself uses when a position is burned (rounding down, the amount an LP actually receives).
 */
import { Q96, divRoundingUp, mulDiv, mulDivRoundingUp, minBig } from "./fullMath.js";

function sorted(a: bigint, b: bigint): [bigint, bigint] {
  return a > b ? [b, a] : [a, b];
}

export function getLiquidityForAmount0(sqrtPriceAX96: bigint, sqrtPriceBX96: bigint, amount0: bigint): bigint {
  const [a, b] = sorted(sqrtPriceAX96, sqrtPriceBX96);
  const intermediate = mulDiv(a, b, Q96);
  return mulDiv(amount0, intermediate, b - a);
}

export function getLiquidityForAmount1(sqrtPriceAX96: bigint, sqrtPriceBX96: bigint, amount1: bigint): bigint {
  const [a, b] = sorted(sqrtPriceAX96, sqrtPriceBX96);
  return mulDiv(amount1, Q96, b - a);
}

export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount0: bigint,
  amount1: bigint
): bigint {
  const [a, b] = sorted(sqrtPriceAX96, sqrtPriceBX96);
  if (sqrtPriceX96 <= a) return getLiquidityForAmount0(a, b, amount0);
  if (sqrtPriceX96 < b) {
    return minBig(getLiquidityForAmount0(sqrtPriceX96, b, amount0), getLiquidityForAmount1(a, sqrtPriceX96, amount1));
  }
  return getLiquidityForAmount1(a, b, amount1);
}

/** SqrtPriceMath.getAmount0Delta: token0 held by `liquidity` between the two sqrt prices. */
export function getAmount0Delta(sqrtPriceAX96: bigint, sqrtPriceBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sorted(sqrtPriceAX96, sqrtPriceBX96);
  if (a === 0n) throw new RangeError("sqrt price of zero");
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  return roundUp ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a) : mulDiv(numerator1, numerator2, b) / a;
}

/** SqrtPriceMath.getAmount1Delta: token1 held by `liquidity` between the two sqrt prices. */
export function getAmount1Delta(sqrtPriceAX96: bigint, sqrtPriceBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sorted(sqrtPriceAX96, sqrtPriceBX96);
  return roundUp ? mulDivRoundingUp(liquidity, b - a, Q96) : mulDiv(liquidity, b - a, Q96);
}

export interface Amounts {
  amount0: bigint;
  amount1: bigint;
}

/** Token amounts a position of `liquidity` over [A, B] holds at the current sqrt price (rounded down). */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint
): Amounts {
  const [a, b] = sorted(sqrtPriceAX96, sqrtPriceBX96);
  if (sqrtPriceX96 <= a) return { amount0: getAmount0Delta(a, b, liquidity, false), amount1: 0n };
  if (sqrtPriceX96 < b) {
    return {
      amount0: getAmount0Delta(sqrtPriceX96, b, liquidity, false),
      amount1: getAmount1Delta(a, sqrtPriceX96, liquidity, false)
    };
  }
  return { amount0: 0n, amount1: getAmount1Delta(a, b, liquidity, false) };
}
