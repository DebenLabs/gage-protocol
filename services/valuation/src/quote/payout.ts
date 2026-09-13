/**
 * GET /quote/payout?usdg=&to=ETH|<token>: the withdraw-as swap. USDG from the user's internal balance is withdrawn
 * from the vault first (pull, never push) and then sold through our pools for ETH (usdgEth) or a Stock Token
 * (its stock/USDG pool; a meme goes through its stock pool as a second hop). The vault never swaps; this quote
 * only sizes the amounts and the on-chain minimum the router enforces.
 */
import type { Address } from "viem";
import { isAddress } from "viem";
import type { ChainReader } from "../chain/reader.js";
import { NATIVE, type Deployment, type Pool } from "../deployment.js";
import { ApiError, badRequest } from "../errors.js";
import { fractionToDecimal } from "../math/price.js";
import type { Pricer } from "../pricing/pricer.js";
import { bpsMul } from "../util/format.js";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from "./reinvest.js";
import { swapAlongRoute } from "./route.js";

export const ROUTER_LABEL = "UniversalRouter (Robinhood Chain fork, minHopPriceX36)";

export interface PayoutQuote {
  usdgIn: string;
  to: { token: Address; symbol: string; decimals: number };
  amountOut: string;
  minOut: string;
  /** USDG per one whole unit of the output asset at the quoted execution (fees included), as a decimal string. */
  rate: string;
  /** Output raw units per USDG raw unit at the quoted execution, as a decimal string. */
  rateRaw: string;
  priceImpactBps: number;
  feePaidUSDG: string;
  slippageBps: number;
  route: { pools: string[]; path: string[]; hops: number; router: typeof ROUTER_LABEL };
  asOfBlock: number;
  note: string;
}

export const PAYOUT_NOTE =
  "The swap happens outside the vault after you withdraw USDG. Quotes assume each hop stays inside the pool's active tick range; minOut is enforced on-chain.";

export function parsePayoutTarget(value: string | undefined, deployment: Deployment): Address {
  if (value === undefined || value === "") throw badRequest("to is required: ETH or a token address");
  if (value.toUpperCase() === "ETH") return NATIVE;
  if (value.toUpperCase() === "WETH") {
    const weth = deployment.tokens.WETH;
    if (weth === undefined) throw badRequest("WETH is not in the deployment; use ETH");
    return weth;
  }
  if (!isAddress(value)) throw badRequest("to must be ETH or a token address");
  return value.toLowerCase() as Address;
}

export interface PayoutDeps {
  pricer: Pricer;
  reader: ChainReader;
  deployment: Deployment;
}

export async function quotePayout(deps: PayoutDeps, usdg: bigint, to: Address, slippageBps: number = DEFAULT_SLIPPAGE_BPS): Promise<PayoutQuote> {
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw badRequest(`slippageBps must be between 0 and ${MAX_SLIPPAGE_BPS}`);
  if (usdg <= 0n) throw badRequest("usdg must be a positive amount in raw units");
  const { pricer } = deps;
  if (pricer.aliases(pricer.usdg).includes(to)) throw badRequest("to must be a different asset than USDG");
  // Routes are discovered token -> USDG; the payout walks them the other way.
  const forward: Pool[] = await pricer.bestRoute(to);
  const pools = [...forward].reverse();
  const [swap, usdgMeta, outMeta] = await Promise.all([swapAlongRoute(pricer, pricer.usdg, pools, usdg), deps.reader.tokenMeta(pricer.usdg), deps.reader.tokenMeta(to)]);
  if (swap.amountOut === 0n) throw new ApiError("NO_LIQUIDITY", "the route pays out nothing for this amount");
  const symbols = await Promise.all(swap.hops.map((h) => deps.reader.tokenMeta(h.tokenOut).then((m) => m.symbol)));
  // USDG paid per whole output unit: usdg / amountOut in raw, shifted by the decimals difference.
  const rate = fractionToDecimal({ num: usdg, den: swap.amountOut }, outMeta.decimals - usdgMeta.decimals, 18);
  const rateRaw = fractionToDecimal({ num: swap.amountOut, den: usdg }, 0, 18);
  // Fees along the path are paid in the running asset; value them in USDG through the route's own hop prices.
  let feeUSDG = 0n;
  let usdgPerRunning = { num: 1n, den: 1n };
  for (const h of swap.hops) {
    feeUSDG += (h.feePaid * usdgPerRunning.num) / usdgPerRunning.den;
    // next hop's input is this hop's output: usdg per unit of it = amountIn / amountOut (execution) chained
    usdgPerRunning = { num: usdgPerRunning.num * h.amountIn, den: usdgPerRunning.den * (h.amountOut === 0n ? 1n : h.amountOut) };
  }
  return {
    usdgIn: usdg.toString(),
    to: { token: to, symbol: outMeta.symbol, decimals: outMeta.decimals },
    amountOut: swap.amountOut.toString(),
    minOut: bpsMul(swap.amountOut, 10_000 - slippageBps).toString(),
    rate,
    rateRaw,
    priceImpactBps: swap.priceImpactBps,
    feePaidUSDG: feeUSDG.toString(),
    slippageBps,
    route: { pools: pools.map((p) => p.name), path: [usdgMeta.symbol, ...symbols], hops: swap.hops.length, router: ROUTER_LABEL },
    asOfBlock: Number(swap.block),
    note: PAYOUT_NOTE
  };
}
