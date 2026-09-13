/**
 * GET /quote/entry?eth=: ETH -> USDG through the usdgEth pool with a price-impact estimate. The swap itself goes
 * through Robinhood Chain's Universal Router (a modified fork with minHopPriceX36 in the v4 swap struct); this
 * service only quotes amounts and limits.
 */
import { findPool, type Deployment } from "../deployment.js";
import { ApiError, badRequest } from "../errors.js";
import { priceImpactBps, swapExactIn } from "../math/swap.js";
import type { Pricer } from "../pricing/pricer.js";
import { bpsMul } from "../util/format.js";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from "./reinvest.js";

export interface EntryQuote {
  usdgOut: string;
  minUsdg: string;
  priceImpactBps: number;
  route: { pools: string[]; path: string[]; router: "UniversalRouter (Robinhood Chain fork, minHopPriceX36)" };
  ethIn: string;
  feePaid: string;
  slippageBps: number;
}

export async function quoteEntry(pricer: Pricer, deployment: Deployment, eth: bigint, slippageBps: number = DEFAULT_SLIPPAGE_BPS): Promise<EntryQuote> {
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw badRequest(`slippageBps must be between 0 and ${MAX_SLIPPAGE_BPS}`);
  const pool = findPool(deployment, "usdgEth");
  if (pool === null) throw new ApiError("NO_POOL", "the USDG/ETH pool is not in the deployment yet");
  const state = await pricer.poolState(pool);
  const usdgAliases = pricer.aliases(pricer.usdg);
  const usdgIsCurrency0 = usdgAliases.includes(pool.currency0);
  const ethIsCurrency0 = !usdgIsCurrency0;
  const swap = { sqrtPriceX96: state.sqrtPriceX96, liquidity: state.liquidity, feePips: BigInt(state.lpFee) };
  const r = swapExactIn(swap, eth, ethIsCurrency0);
  return {
    usdgOut: r.amountOut.toString(),
    minUsdg: bpsMul(r.amountOut, 10_000 - slippageBps).toString(),
    priceImpactBps: priceImpactBps(swap, eth, r.amountOut, ethIsCurrency0),
    route: { pools: [pool.name], path: ["ETH", "USDG"], router: "UniversalRouter (Robinhood Chain fork, minHopPriceX36)" },
    ethIn: eth.toString(),
    feePaid: r.feePaid.toString(),
    slippageBps
  };
}
