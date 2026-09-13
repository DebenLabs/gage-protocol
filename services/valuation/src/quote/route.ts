/**
 * Exact-in swaps along a path of one or two pools, hop by hop, with the in-range arithmetic of math/swap.ts.
 * Shared by the entry and payout quotes. Price impact compares the realised output with what the composite mid
 * price would have paid after fees, so it measures the move the trade itself causes.
 */
import type { Address } from "viem";
import type { Pool } from "../deployment.js";
import { ApiError } from "../errors.js";
import { applyPrice, multiply, scale, type Fraction, ONE } from "../math/price.js";
import { FEE_DENOMINATOR, SwapError, swapExactIn, type PoolSwapState } from "../math/swap.js";
import { Pricer, type PoolState } from "../pricing/pricer.js";

export interface Hop {
  pool: Pool;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  feePaid: bigint;
  sqrtPriceAfterX96: bigint;
}

export interface RouteSwap {
  hops: Hop[];
  amountOut: bigint;
  /** Output the mid price would have paid after fees, no impact. */
  expectedOut: bigint;
  priceImpactBps: number;
  block: bigint;
}

export function toSwapState(s: PoolState): PoolSwapState {
  return { sqrtPriceX96: s.sqrtPriceX96, liquidity: s.liquidity, feePips: BigInt(s.lpFee) };
}

/** Which alias of `token` sits in the pool, or null. */
function sideOf(pricer: Pricer, pool: Pool, token: Address): Address | null {
  return pricer.aliases(token).find((a) => a === pool.currency0 || a === pool.currency1) ?? null;
}

/**
 * Sell `amountIn` of `tokenIn` through `pools` in order. Throws NO_ROUTE when a pool does not contain the running
 * token and NO_LIQUIDITY when a hop cannot be filled inside its active range.
 */
export async function swapAlongRoute(pricer: Pricer, tokenIn: Address, pools: Pool[], amountIn: bigint): Promise<RouteSwap> {
  if (pools.length === 0) throw new ApiError("NO_ROUTE", "empty route");
  const states = await Promise.all(pools.map((p) => pricer.poolState(p)));
  const hops: Hop[] = [];
  let running = tokenIn.toLowerCase() as Address;
  let amount = amountIn;
  let midPrice: Fraction = ONE;
  for (const state of states) {
    if (state.curve) throw new ApiError("NO_ROUTE", "Universal Router payouts do not route through the Pons bonding curve");
    const inSide = sideOf(pricer, state.pool, running);
    if (inSide === null) throw new ApiError("NO_ROUTE", `pool ${state.pool.name} does not contain ${running}`);
    const zeroForOne = inSide === state.pool.currency0;
    const outSide = Pricer.otherCurrency(state.pool, inSide);
    let r;
    try {
      r = swapExactIn(toSwapState(state), amount, zeroForOne);
      if (state.hookFeePips) {
        const feeOut = r.amountOut * BigInt(state.hookFeePips) / FEE_DENOMINATOR;
        r = { ...r, amountOut: r.amountOut - feeOut, feePaid: r.feePaid + (amount * BigInt(state.hookFeePips) / FEE_DENOMINATOR) };
      }
    } catch (e) {
      if (e instanceof SwapError) throw new ApiError("NO_LIQUIDITY", `pool ${state.pool.name}: ${e.message}`);
      throw e;
    }
    hops.push({ pool: state.pool, tokenIn: inSide, tokenOut: outSide, amountIn: amount, amountOut: r.amountOut, feePaid: r.feePaid, sqrtPriceAfterX96: r.sqrtPriceAfterX96 });
    // mid price after the fee for this hop
    midPrice = multiply(multiply(midPrice, Pricer.priceInPool(state, inSide)), scale(ONE, FEE_DENOMINATOR - BigInt(state.lpFee), FEE_DENOMINATOR));
    midPrice = multiply(midPrice, scale(ONE, FEE_DENOMINATOR - BigInt(state.hookFeePips ?? 0), FEE_DENOMINATOR));
    running = outSide;
    amount = r.amountOut;
  }
  const expectedOut = applyPrice(amountIn, midPrice);
  const gap = expectedOut > amount ? expectedOut - amount : 0n;
  const priceImpactBps = expectedOut === 0n ? 0 : Number((gap * 10_000n) / expectedOut);
  const block = states.reduce((b, s) => (s.block > b ? s.block : b), 0n);
  return { hops, amountOut: amount, expectedOut, priceImpactBps, block };
}
