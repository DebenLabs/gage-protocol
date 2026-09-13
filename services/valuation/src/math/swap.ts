// SPDX-License-Identifier: MIT
// Uniswap-derived portions: see THIRD_PARTY_NOTICES.md and licenses/Uniswap-v4-*-MIT.txt.
/**
 * Single-step swap arithmetic inside the active tick range, ported from v4-core SqrtPriceMath. Quotes that would
 * cross an initialised tick are approximations: the pool would pay slightly less as liquidity changes. Every quote
 * built on this says so, and every amount enforced on-chain carries a slippage bound.
 */
import { Q96, divRoundingUp, mulDiv, mulDivRoundingUp } from "./fullMath.js";
import { getAmount0Delta, getAmount1Delta } from "./liquidityAmounts.js";

export const FEE_DENOMINATOR = 1_000_000n;

export interface PoolSwapState {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** LP fee in hundredths of a bip (pips), 3000 = 0.30%, 30000 = 3%. */
  feePips: bigint;
}

export class SwapError extends Error {
  constructor(
    readonly code: "NO_LIQUIDITY" | "INSUFFICIENT_LIQUIDITY" | "BAD_AMOUNT",
    message: string
  ) {
    super(message);
  }
}

export function getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtPX96;
  if (add) {
    return mulDivRoundingUp(numerator1, sqrtPX96, numerator1 + product);
  }
  if (numerator1 <= product) throw new SwapError("INSUFFICIENT_LIQUIDITY", "not enough token0 in range");
  return mulDivRoundingUp(numerator1, sqrtPX96, numerator1 - product);
}

export function getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (add) return sqrtPX96 + mulDiv(amount, Q96, liquidity);
  const quotient = mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtPX96 <= quotient) throw new SwapError("INSUFFICIENT_LIQUIDITY", "not enough token1 in range");
  return sqrtPX96 - quotient;
}

export interface ExactInResult {
  amountOut: bigint;
  sqrtPriceAfterX96: bigint;
  feePaid: bigint;
}

/** Sell `amountIn` of one side; `zeroForOne` sells currency0 for currency1. */
export function swapExactIn(pool: PoolSwapState, amountIn: bigint, zeroForOne: boolean): ExactInResult {
  if (pool.liquidity === 0n) throw new SwapError("NO_LIQUIDITY", "pool has no active liquidity");
  if (amountIn < 0n) throw new SwapError("BAD_AMOUNT", "negative amount");
  const feePaid = mulDivRoundingUp(amountIn, pool.feePips, FEE_DENOMINATOR);
  const amountInLessFee = amountIn - feePaid;
  if (zeroForOne) {
    const next = getNextSqrtPriceFromAmount0RoundingUp(pool.sqrtPriceX96, pool.liquidity, amountInLessFee, true);
    return { amountOut: getAmount1Delta(next, pool.sqrtPriceX96, pool.liquidity, false), sqrtPriceAfterX96: next, feePaid };
  }
  const next = getNextSqrtPriceFromAmount1RoundingDown(pool.sqrtPriceX96, pool.liquidity, amountInLessFee, true);
  return { amountOut: getAmount0Delta(pool.sqrtPriceX96, next, pool.liquidity, false), sqrtPriceAfterX96: next, feePaid };
}

export interface ExactOutResult {
  /** Input including the LP fee. */
  amountIn: bigint;
  sqrtPriceAfterX96: bigint;
  feePaid: bigint;
}

/** Buy exactly `amountOut`; `zeroForOne` pays currency0 to receive currency1. */
export function swapExactOut(pool: PoolSwapState, amountOut: bigint, zeroForOne: boolean): ExactOutResult {
  if (pool.liquidity === 0n) throw new SwapError("NO_LIQUIDITY", "pool has no active liquidity");
  if (amountOut < 0n) throw new SwapError("BAD_AMOUNT", "negative amount");
  let next: bigint;
  let amountInNoFee: bigint;
  if (zeroForOne) {
    next = getNextSqrtPriceFromAmount1RoundingDown(pool.sqrtPriceX96, pool.liquidity, amountOut, false);
    amountInNoFee = getAmount0Delta(next, pool.sqrtPriceX96, pool.liquidity, true);
  } else {
    next = getNextSqrtPriceFromAmount0RoundingUp(pool.sqrtPriceX96, pool.liquidity, amountOut, false);
    amountInNoFee = getAmount1Delta(pool.sqrtPriceX96, next, pool.liquidity, true);
  }
  const amountIn = divRoundingUp(amountInNoFee * FEE_DENOMINATOR, FEE_DENOMINATOR - pool.feePips);
  return { amountIn, sqrtPriceAfterX96: next, feePaid: amountIn - amountInNoFee };
}

/**
 * Price impact in bps: how far the execution price (after the fee is removed) sits below the mid price.
 * Returns 0 for an empty trade.
 */
export function priceImpactBps(pool: PoolSwapState, amountIn: bigint, amountOut: bigint, zeroForOne: boolean): number {
  if (amountIn === 0n) return 0;
  const amountInLessFee = amountIn - mulDivRoundingUp(amountIn, pool.feePips, FEE_DENOMINATOR);
  const sq = pool.sqrtPriceX96 * pool.sqrtPriceX96;
  // expected out at the mid price, with no impact
  const expected = zeroForOne ? (amountInLessFee * sq) / (Q96 * Q96) : (amountInLessFee * Q96 * Q96) / sq;
  if (expected <= 0n) return 0;
  const gap = expected > amountOut ? expected - amountOut : 0n;
  return Number((gap * 10_000n) / expected);
}
