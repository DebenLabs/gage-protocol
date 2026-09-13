import type { Address } from "viem";
import { NATIVE, type Pool } from "../deployment.js";
import { ApiError, badRequest } from "../errors.js";
import { getAmountsForLiquidity } from "../math/liquidityAmounts.js";
import { applyPrice } from "../math/price.js";
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from "../math/tickMath.js";
import type { Pricer } from "../pricing/pricer.js";
import { suggestRange, type SuggestDeps } from "../range/suggest.js";
import type { ZapStatus } from "../zap/status.js";
import type { ZapSimulator } from "../zap/simulate.js";

const UINT128_MAX = (1n << 128n) - 1n;
export const ZAP_QUOTE_TTL = 120;

/** Bounded routes with exact currencies: ETH and WETH are only interchangeable at the initial unwrap. */
export function zapRoutes(pools: Pool[], input: Address, base: Address, exclude: string): Pool[][] {
  if (input === base) return [[]];
  const out: Pool[][] = [];
  const walk = (token: Address, path: Pool[], seen: Set<Address>): void => {
    if (path.length === 3) return;
    for (const p of pools) {
      if (p.poolId === exclude || (p.currency0 !== token && p.currency1 !== token)) continue;
      const next = p.currency0 === token ? p.currency1 : p.currency0;
      if (seen.has(next)) continue;
      if (next === base) out.push([...path, p]);
      else walk(next, [...path, p], new Set([...seen, next]));
    }
  };
  walk(input, [], new Set([input]));
  return out.sort((a, b) => a.length - b.length);
}

export interface LPZapParams { pool: string; payAsset: "USDG" | "WETH"; amount: bigint; term: number; slippageBps: number }

export async function quoteLPZap(pricer: Pricer, suggest: SuggestDeps, status: ZapStatus, p: LPZapParams, simulate: ZapSimulator) {
  if (!status.enabled || !status.router) throw new ApiError("UNSUPPORTED", status.reason ?? "LP creation is unavailable");
  if (p.amount <= 0n || p.amount > UINT128_MAX) throw badRequest("amount must fit uint128 and be positive");
  if (!status.terms.includes(p.term)) throw badRequest("term is not enabled for LP listings");
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 1 || p.slippageBps > 500) throw badRequest("slippageBps must be 1–500");
  const target = status.items.find(i => i.pool.poolId === p.pool.toLowerCase() || i.pool.name === p.pool);
  if (!target) throw new ApiError("UNSUPPORTED", "pool is not currently admitted for LP creation");
  const inputToken = p.payAsset === "USDG" ? pricer.usdg : status.weth;
  if (!inputToken) throw new ApiError("UNSUPPORTED", "WETH is not configured");
  const direct = zapRoutes(status.routingPools, inputToken, target.baseToken, target.pool.poolId);
  const unwrapped = p.payAsset === "WETH" ? zapRoutes(status.routingPools, NATIVE, target.baseToken, target.pool.poolId) : [];
  const route = direct[0] ?? unwrapped[0];
  if (!route) throw new ApiError("NO_ROUTE", "no reviewed route reaches this pool from the selected payment token");
  const unwrapWeth = direct.length === 0 && p.payAsset === "WETH";
  if (!status.quoter) throw new ApiError("UNSUPPORTED", "LP quote simulation is not configured");
  const state = await pricer.poolState(target.pool);
  const range = await suggestRange(suggest, target.pool, state, p.term, null);
  const { tickLower, tickUpper } = range.recommended;
  const simulated = await simulate(status.quoter, { inputCurrency: unwrapWeth ? NATIVE : inputToken,
    amountIn: p.amount, pool: target.pool, baseToken: target.baseToken, tickLower, tickUpper,
    slippageBps: p.slippageBps, route });
  const solved = simulated.split;
  const afterTick = getTickAtSqrtPrice(solved.sqrtPriceAfterX96);
  if (afterTick < tickLower || afterTick >= tickUpper) throw new ApiError("NO_LIQUIDITY", "This amount moves the pool outside the recommended range. Reduce it.");
  const minLiquidity = solved.liquidity * BigInt(10_000 - p.slippageBps) / 10_000n;
  if (minLiquidity <= BigInt(target.minLiquidity) || minLiquidity > UINT128_MAX) {
    throw new ApiError("NO_LIQUIDITY", "Position would not meet the pool's minimum liquidity.");
  }
  const amounts = getAmountsForLiquidity(solved.sqrtPriceAfterX96, getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), solved.liquidity);
  const [price0, price1, inputPrice] = await Promise.all([pricer.priceInUSDG(target.pool.currency0), pricer.priceInUSDG(target.pool.currency1), pricer.priceInUSDG(inputToken)]);
  const valueUSDG = applyPrice(amounts.amount0, price0.price) + applyPrice(amounts.amount1, price1.price);
  const inputValueUSDG = applyPrice(p.amount, inputPrice.price);
  const swapCostUSDG = inputValueUSDG > valueUSDG ? inputValueUSDG - valueUSDG : 0n;
  const swaps = simulated.swaps.map((s, i) => ({ key: i < route.length ? route[i]! : target.pool,
    zeroForOne: s.zeroForOne, amountIn: s.amountIn.toString(), minOut: s.minOut.toString() }));
  const at = simulated.at;
  return { chainId: status.chainId, vault: status.vault, router: status.router, quoter: status.quoter, inputToken, payAsset: p.payAsset,
    amountIn: p.amount.toString(), unwrapWeth, pool: target.pool, baseToken: target.baseToken, token0: target.token0, token1: target.token1,
    term: p.term, range, amount0: amounts.amount0.toString(), amount1: amounts.amount1.toString(), valueUSDG: valueUSDG.toString(),
    liquidity: solved.liquidity.toString(), minLiquidity: minLiquidity.toString(), swaps,
    swapCostUSDG: swapCostUSDG.toString(), inputValueUSDG: inputValueUSDG.toString(),
    slippageBps: p.slippageBps, feeBps: status.feeBps, block: simulated.block.toString(), at, deadline: at + ZAP_QUOTE_TTL,
    note: "Simulated against the live pools, including hooks and tick crossings. Swap cost includes price impact and returned leftovers. Funding arrives only after a lender funds the listing." };
}
