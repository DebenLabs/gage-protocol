/**
 * Every 10 minutes: sample the pool prices and store `priceUSDGPerSGAGE` (USDG raw units per 1e18 sGAGE).
 * Uniswap v4 has no built-in TWAP without an oracle hook, so the keeper keeps its own samples; the weekly
 * proposal averages them over TWAP_WINDOW. The path is sGAGE → GAGE (our pool) → ETH (launch pool) → USDG.
 */
import { parseAbi, type Chain, type PublicClient, type Transport, type Address, type Hex } from "viem";
import { need, nowSeconds, type JobContext } from "../context.js";
import type { Deployment, PoolRef } from "../deployment.js";
import { mul, priceOfIn, type Rational } from "../math.js";
import type { PriceSample } from "../state.js";

const WAD = 10n ** 18n;

export interface PriceLeg {
  token: Address;
  pool: { currency0: Address; currency1: Address };
  sqrtPriceX96: bigint;
}

/** Pure. Multiplies the legs: price of the first token in the last pool's other currency. */
export function composePrice(legs: readonly PriceLeg[]): Rational {
  let acc: Rational = { num: 1n, den: 1n };
  for (const leg of legs) acc = mul(acc, priceOfIn(leg.token, leg.pool, leg.sqrtPriceX96));
  return acc;
}

/** Pure. USDG raw units per 1e18 sGAGE from a sGAGE→GAGE→ETH→USDG chain. */
export function conservativeRewardPrice(price: Rational): bigint {
  if (price.num <= 0n || price.den <= 0n) return 0n;
  return (price.num * WAD + price.den - 1n) / price.den;
}

export function priceUSDGPerSGAGE(legs: readonly PriceLeg[]): bigint {
  return conservativeRewardPrice(composePrice(legs));
}

/** Pure. Keeps samples inside twice the window so the average always has history behind its start. */
export function pruneSamples(samples: readonly PriceSample[], now: number, windowSeconds: number): PriceSample[] {
  const cutoff = now - 2 * windowSeconds;
  return samples.filter((s) => s.t >= cutoff).sort((a, b) => a.t - b.t);
}

export function requiredPools(d: Deployment): { gageSgage: PoolRef; gageEth: PoolRef; usdgEth: PoolRef } | undefined {
  const { gageSgage, gageEth, usdgEth } = d.pools;
  if (gageSgage === undefined || gageEth === undefined || usdgEth === undefined) return undefined;
  return { gageSgage, gageEth, usdgEth };
}

export async function samplePrice(ctx: JobContext, pub?: PublicClient<Transport, Chain>): Promise<bigint | undefined> {
  pub ??= ctx.publicClient;
  const d = ctx.deployment();
  const addrs = need(ctx, d, "price", ["StateView", "GAGE", "sGAGE", "USDG"]);
  if (addrs === undefined) return undefined;
  const [stateView, gage, sgage, usdg] = addrs as [Address, Address, Address, Address];
  const pools = requiredPools(d);
  if (pools === undefined) {
    ctx.log.info("job_skipped", { job: "price", reason: "pools_missing", need: ["gageSgage", "gageEth", "usdgEth"] });
    return undefined;
  }
  const weth = pools.usdgEth.currency0.toLowerCase() === usdg.toLowerCase() ? pools.usdgEth.currency1 : pools.usdgEth.currency0;
  const block = pub ? await pub.getBlock() : undefined;
  if (block && (Math.abs(nowSeconds(ctx) - Number(block.timestamp)) > 120)) throw Error("price-block-stale");
  const slot = (id: Hex) => ctx.views.slot0(stateView, id, block?.number);
  const [a, b, c] = await Promise.all([slot(pools.gageSgage.poolId), slot(pools.gageEth.poolId), slot(pools.usdgEth.poolId)]);
  let price: bigint;
  if (d.pons) {
    if (!pub) throw new Error("pons-price-client-required");
    const abi = parseAbi(["function graduated() view returns(bool)", "function getReserves() view returns(uint256,uint256)"]);
    const blockNumber = block!.number;
    const cbase = { address: d.pons.curve, abi, blockNumber } as const;
    if (!await pub.readContract({ ...cbase, functionName: "graduated" })) {
      const [quote, tokens] = await pub.readContract({ ...cbase, functionName: "getReserves" });
      if (quote === 0n || tokens === 0n) return undefined;
      const outer = composePrice([{token: sgage, pool: pools.gageSgage, sqrtPriceX96: a.sqrtPriceX96}, {token: weth, pool: pools.usdgEth, sqrtPriceX96: c.sqrtPriceX96}]);
      price = conservativeRewardPrice(mul(outer, {num: quote, den: tokens}));
    } else {
      if (b.sqrtPriceX96 === 0n) return undefined; // Swept; the permissionless pool-creation job runs next.
      price = priceUSDGPerSGAGE([{token: sgage, pool: pools.gageSgage, sqrtPriceX96: a.sqrtPriceX96}, {token: gage, pool: pools.gageEth, sqrtPriceX96: b.sqrtPriceX96}, {token: weth, pool: pools.usdgEth, sqrtPriceX96: c.sqrtPriceX96}]);
    }
  } else price = priceUSDGPerSGAGE([
    { token: sgage, pool: pools.gageSgage, sqrtPriceX96: a.sqrtPriceX96 },
    { token: gage, pool: pools.gageEth, sqrtPriceX96: b.sqrtPriceX96 },
    { token: weth, pool: pools.usdgEth, sqrtPriceX96: c.sqrtPriceX96 },
  ]);
  if (price <= 0n) {
    ctx.log.info("price_below_precision", { unit: "raw_USDG_per_sGAGE" });
    return undefined;
  }
  const t = block ? Number(block.timestamp) : nowSeconds(ctx);
  ctx.state.priceSamples = pruneSamples(
    [...ctx.state.priceSamples.filter(s => s.t !== t), { t, priceUSDGPerSGAGE: price.toString(), ...(block ? { blockNumber: block.number.toString() } : {}) }],
    t,
    Math.floor(ctx.config.twapWindowMs / 1000),
  );
  ctx.log.info("price_sampled", { priceUSDGPerSGAGE: price, samples: ctx.state.priceSamples.length });
  return price;
}

export async function runPriceSample(ctx: JobContext, pub?: PublicClient<Transport, Chain>): Promise<void> {
  await samplePrice(ctx, pub);
}
