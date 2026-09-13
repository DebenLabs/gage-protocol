/**
 * GET /quote/reinvest. Match: the GAGE needed to pair the sGAGE for the range at the pool price, paid in ETH or USDG
 * bought through usdgEth / gageEth. Zap: sell the fraction of the sGAGE that makes the remainder pair at the
 * post-swap price (math/zap.ts). Limits (maxPay, maxSold, minLiquidity) are what the router enforces on-chain.
 */
import type { Address } from "viem";
import { findPool, type Deployment, type Pool } from "../deployment.js";
import { ApiError, badRequest } from "../errors.js";
import { getLiquidityForAmount0, getLiquidityForAmount1, getAmount0Delta, getAmount1Delta, getLiquidityForAmounts } from "../math/liquidityAmounts.js";
import { mulDivRoundingUp } from "../math/fullMath.js";
import { swapExactIn, swapExactOut, type PoolSwapState } from "../math/swap.js";
import { getSqrtPriceAtTick } from "../math/tickMath.js";
import { solveZap } from "../math/zap.js";
import type { Pricer, PoolState } from "../pricing/pricer.js";
import { bpsMul } from "../util/format.js";

export const ZAP_FEE_NOTE = "The zap sells part of your sGAGE into the pool. The pool fee on the sold part is shown as feeOnSold.";
export const MAX_SLIPPAGE_BPS = 500;
export const DEFAULT_SLIPPAGE_BPS = 100;

export interface ReinvestParams {
  inputAsset?: "sGAGE" | "GAGE" | "ETH" | "USDG";
  amount: bigint;
  tickLower: number;
  tickUpper: number;
  route: "match" | "zap";
  payAsset: "ETH" | "USDG";
  slippageBps: number;
}

export interface MatchQuote {
  route: "match";
  gageNeeded: string;
  payAmount: string;
  maxPay: string;
  minLiquidity: string;
  payAsset: "ETH" | "USDG";
  pools: string[];
  sgageUsed: string;
  note: string;
}

export interface ZapQuote {
  route: "zap";
  sgageToSell: string;
  maxSold: string;
  feeOnSold: string;
  minLiquidity: string;
  gageOut: string;
  sgageRemaining: string;
  pools: string[];
  note: string;
}

export interface ReinvestPools {
  gageSgage: Pool;
  gageEth: Pool | null;
  usdgEth: Pool | null;
  gage: Address;
  sgage: Address;
}

export interface GageZapQuote {
  route: "gage-zap";
  inputAsset: "GAGE";
  amountIn: string;
  gageToSwap: string;
  sgageOut: string;
  minSgageOut: string;
  gageRemaining: string;
  feeOnSwapped: string;
  feePips: number;
  minLiquidity: string;
  pools: string[];
  note: string;
}

export interface FundedZapQuote extends Omit<GageZapQuote, "route" | "inputAsset"> {
  route: "funded-zap";
  inputAsset: "ETH" | "USDG";
  ethOut: string;
  minEthOut: string;
  gageBought: string;
  minGageOut: string;
  fundingFees: { asset: "ETH" | "USDG" | "GAGE"; amount: string; feePips: number }[];
}

function directionalState(s: PoolState, zeroForOne: boolean): PoolSwapState {
  const protocol = zeroForOne ? (s.protocolFee ?? 0) & 0xfff : (s.protocolFee ?? 0) >> 12;
  return { ...swapState(s), feePips: BigInt(protocol + s.lpFee - Math.floor(protocol * s.lpFee / 1_000_000)) };
}

export function resolveReinvestPools(d: Deployment): ReinvestPools {
  const gageSgage = findPool(d, "gageSgage");
  if (gageSgage === null) throw new ApiError("NO_POOL", "the GAGE/sGAGE pool is not in the deployment yet");
  const gage = d.tokens.GAGE;
  const sgage = d.tokens.sGAGE;
  if (gage === undefined || sgage === undefined) throw new ApiError("NO_POOL", "GAGE and sGAGE are not in the deployment yet");
  if (!(gageSgage.currency0 === sgage || gageSgage.currency1 === sgage) || !(gageSgage.currency0 === gage || gageSgage.currency1 === gage)) {
    throw new ApiError("NO_POOL", "the gageSgage pool does not pair GAGE with sGAGE");
  }
  return { gageSgage, gageEth: findPool(d, "gageEth"), usdgEth: findPool(d, "usdgEth"), gage, sgage };
}

export function validateRange(tickLower: number, tickUpper: number, spacing: number): void {
  if (tickLower >= tickUpper) throw badRequest("tickLower must be below tickUpper");
  if (tickLower % spacing !== 0 || tickUpper % spacing !== 0) throw badRequest(`ticks must be multiples of the pool's tick spacing (${spacing})`);
}

function swapState(s: PoolState): PoolSwapState {
  return { sqrtPriceX96: s.sqrtPriceX96, liquidity: s.liquidity, feePips: BigInt(s.lpFee) };
}

/** GAGE needed to pair `amount` sGAGE in the range at spot, and the liquidity that mints. */
export function matchAmounts(state: PoolState, sgageIsCurrency0: boolean, amount: bigint, tickLower: number, tickUpper: number): { gageNeeded: bigint; liquidity: bigint; sgageUsed: bigint } {
  const sqrtLower = getSqrtPriceAtTick(tickLower);
  const sqrtUpper = getSqrtPriceAtTick(tickUpper);
  const sqrtP = state.sqrtPriceX96;
  if (sgageIsCurrency0) {
    if (sqrtP >= sqrtUpper) throw new ApiError("RANGE_ONE_SIDED", "at the current price this range holds only GAGE, so sGAGE cannot be paired into it; choose a range that includes or sits above the current price");
    const liquidity = sqrtP <= sqrtLower ? getLiquidityForAmount0(sqrtLower, sqrtUpper, amount) : getLiquidityForAmount0(sqrtP, sqrtUpper, amount);
    const gageNeeded = sqrtP <= sqrtLower ? 0n : getAmount1Delta(sqrtLower, sqrtP, liquidity, true);
    return { gageNeeded, liquidity, sgageUsed: amount };
  }
  if (sqrtP <= sqrtLower) throw new ApiError("RANGE_ONE_SIDED", "at the current price this range holds only GAGE, so sGAGE cannot be paired into it; choose a range that includes or sits below the current price");
  const liquidity = sqrtP >= sqrtUpper ? getLiquidityForAmount1(sqrtLower, sqrtUpper, amount) : getLiquidityForAmount1(sqrtLower, sqrtP, amount);
  const gageNeeded = sqrtP >= sqrtUpper ? 0n : getAmount0Delta(sqrtP, sqrtUpper, liquidity, true);
  return { gageNeeded, liquidity, sgageUsed: amount };
}

export interface QuoteContext {
  pricer: Pricer;
  pools: ReinvestPools;
}

/** Cost of `gageOut` GAGE bought with ETH through gageEth, then optionally the USDG for that ETH through usdgEth. */
export async function payForGage(ctx: QuoteContext, gageOut: bigint, payAsset: "ETH" | "USDG"): Promise<{ payAmount: bigint; pools: string[] }> {
  if (gageOut === 0n) return { payAmount: 0n, pools: [] };
  const { gageEth, usdgEth, gage } = ctx.pools;
  if (gageEth === null) throw new ApiError("NO_POOL", "the GAGE/ETH pool is not in the deployment yet");
  const ethState = await ctx.pricer.poolState(gageEth);
  const gageIsCurrency0 = gageEth.currency0 === gage;
  // buying GAGE: pay the other side; zeroForOne means paying currency0 to receive currency1
  const curve = ethState.curve;
  let ethNeeded: bigint;
  if (curve) {
    if (gageOut > curve.sellableTokens || gageOut >= curve.tokenReserve) throw new ApiError("NO_LIQUIDITY", "requested GAGE exceeds the curve's remaining allocation");
    const net = mulDivRoundingUp(curve.quoteReserve, gageOut, curve.tokenReserve - gageOut);
    ethNeeded = mulDivRoundingUp(net, 10_000n, 10_000n - BigInt(curve.feeBps)) + 1n;
  } else {
    // Pons exact-output swaps charge the hook fee on the input currency.
    const raw = swapExactOut(swapState(ethState), gageOut, !gageIsCurrency0).amountIn;
    ethNeeded = raw + (raw * BigInt(ethState.hookFeePips ?? 0)) / 1_000_000n;
    // Router estimates its ETH budget from spot with a 2% execution cushion.
    // Include it in maxPay's base so a 1% UI tolerance cannot underfund that budget.
    if (ethState.hookFeePips !== undefined) ethNeeded = mulDivRoundingUp(ethNeeded, 102n, 100n);
  }
  if (payAsset === "ETH") return { payAmount: ethNeeded, pools: [gageEth.name] };
  if (usdgEth === null) throw new ApiError("NO_POOL", "the USDG/ETH pool is not in the deployment yet");
  const usdgState = await ctx.pricer.poolState(usdgEth);
  const usdgAliases = ctx.pricer.aliases(ctx.pricer.usdg);
  const usdgIsCurrency0 = usdgAliases.includes(usdgEth.currency0);
  const usdgNeeded = swapExactOut(swapState(usdgState), ethNeeded, usdgIsCurrency0).amountIn;
  return { payAmount: usdgNeeded, pools: [usdgEth.name, gageEth.name] };
}

export async function quoteReinvest(ctx: QuoteContext, p: ReinvestParams): Promise<MatchQuote | ZapQuote | GageZapQuote | FundedZapQuote> {
  const { gageSgage, sgage } = ctx.pools;
  validateRange(p.tickLower, p.tickUpper, gageSgage.tickSpacing);
  if (p.slippageBps < 0 || p.slippageBps > MAX_SLIPPAGE_BPS) throw badRequest(`slippageBps must be between 0 and ${MAX_SLIPPAGE_BPS}`);
  const state = await ctx.pricer.poolState(gageSgage);
  const sgageIsCurrency0 = gageSgage.currency0 === sgage;
  if (p.inputAsset === "ETH" || p.inputAsset === "USDG") {
    if (p.route !== "zap") throw badRequest("ETH and USDG inputs support Zap only");
    if (p.amount <= 0n || p.amount > (1n << 128n) - 1n) throw badRequest("Amount is outside the supported range");
    const { gageEth, usdgEth } = ctx.pools;
    if (!gageEth || (p.inputAsset === "USDG" && !usdgEth)) throw new ApiError("NO_POOL", "Funding pool unavailable");
    const fundingFees: FundedZapQuote["fundingFees"] = [];
    let eth = p.amount;
    if (p.inputAsset === "USDG" && usdgEth) {
      const usdState = await ctx.pricer.poolState(usdgEth);
      if (usdState.curve || usdState.hookFeePips) throw new ApiError("NO_ROUTE", "Unsupported USDG funding pool");
      const usdSwap = directionalState(usdState, false);
      const hop = swapExactIn(usdSwap, p.amount, false);
      eth = hop.amountOut;
      fundingFees.push({ asset: "USDG", amount: hop.feePaid.toString(), feePips: Number(usdSwap.feePips) });
    }
    const ethState = await ctx.pricer.poolState(gageEth);
    if (ethState.curve) throw new ApiError("NO_ROUTE", "Funded zaps require the graduated GAGE pool");
    const ethSwap = directionalState(ethState, true);
    const hop = swapExactIn(ethSwap, eth, true);
    // Pons exact-input fees are collected in the output token, GAGE.
    const hookFee = hop.amountOut * BigInt(ethState.hookFeePips ?? 0) / 1_000_000n;
    const bought = hop.amountOut - hookFee;
    fundingFees.push({ asset: "ETH", amount: hop.feePaid.toString(), feePips: Number(ethSwap.feePips) });
    if (hookFee > 0n) fundingFees.push({ asset: "GAGE", amount: hookFee.toString(), feePips: ethState.hookFeePips! });
    const split = await quoteReinvest(ctx, { ...p, inputAsset: "GAGE", amount: bought });
    if (split.route !== "gage-zap") throw badRequest("Invalid funding quote");
    const minGage = bpsMul(bought, 10_000 - p.slippageBps);
    const minEth = p.inputAsset === "ETH" ? 0n : bpsMul(eth, 10_000 - p.slippageBps);
    if (minGage <= BigInt(split.gageToSwap) || (p.inputAsset === "USDG" && minEth <= 0n)) throw badRequest("Amount is too small or range too unbalanced for this zap");
    return { ...split, route: "funded-zap", inputAsset: p.inputAsset, amountIn: p.amount.toString(),
      ethOut: eth.toString(), minEthOut: minEth.toString(), gageBought: bought.toString(), minGageOut: minGage.toString(), fundingFees,
      pools: [...(p.inputAsset === "USDG" && usdgEth ? [usdgEth.name] : []), gageEth.name, gageSgage.name],
      note: "Buys GAGE, swaps part for sGAGE in GAGE/sGAGE, then adds liquidity. Every swap has an output minimum, with a final liquidity minimum. Unpaired tokens are refunded. Estimates assume current active liquidity." };
  }
  if (p.inputAsset === "GAGE") {
    if (p.route !== "zap") throw badRequest("GAGE input supports Zap only");
    if (p.amount <= 0n || p.amount > (1n << 128n) - 1n) throw badRequest("GAGE amount is outside the supported range");
    const zeroForOne = !sgageIsCurrency0;
    const protocolFee = zeroForOne ? (state.protocolFee ?? 0) & 0xfff : (state.protocolFee ?? 0) >> 12;
    const feePips = protocolFee + state.lpFee - Math.floor(protocolFee * state.lpFee / 1_000_000);
    // The bisection solver is symmetric: its named 'sGAGE' side is the input asset here (GAGE).
    const z = solveZap({ pool: { ...swapState(state), feePips: BigInt(feePips) }, amountSgage: p.amount,
      sgageIsCurrency0: zeroForOne, sqrtLowerX96: getSqrtPriceAtTick(p.tickLower), sqrtUpperX96: getSqrtPriceAtTick(p.tickUpper) });
    const minOut = bpsMul(z.gageOut, 10_000 - p.slippageBps);
    const minLiquidity = bpsMul(z.liquidity, 10_000 - p.slippageBps);
    if (z.sqrtPriceAfterX96 <= getSqrtPriceAtTick(p.tickLower) || z.sqrtPriceAfterX96 >= getSqrtPriceAtTick(p.tickUpper)) {
      throw new ApiError("RANGE_ONE_SIDED", "This amount would leave the position outside its earning range. Choose Full range or a smaller amount.");
    }
    if (z.sgageToSell <= 0n || z.sgageToSell >= p.amount || minOut <= 0n || minLiquidity <= 0n) {
      throw badRequest("Amount is too small to swap and add liquidity");
    }
    if (z.gageOut > (1n << 128n) - 1n || z.liquidity > (1n << 128n) - 1n) throw badRequest("Amount is too large for this range");
    return { route: "gage-zap", inputAsset: "GAGE", amountIn: p.amount.toString(),
      gageToSwap: z.sgageToSell.toString(), sgageOut: z.gageOut.toString(), minSgageOut: minOut.toString(),
      gageRemaining: z.sgageRemaining.toString(), feeOnSwapped: z.feeOnSold.toString(), feePips,
      minLiquidity: minLiquidity.toString(), pools: [gageSgage.name],
      note: "Swaps part of GAGE for sGAGE in GAGE/sGAGE, then pairs the remainder. No GAGE/ETH trade. The pool fee applies only to the swapped part. Estimate assumes current active liquidity; the transaction is simulated and both output and liquidity minimums are enforced." };
  }
  if (p.route === "match") {
    const m = matchAmounts(state, sgageIsCurrency0, p.amount, p.tickLower, p.tickUpper);
    const pay = await payForGage(ctx, m.gageNeeded, p.payAsset);
    return {
      route: "match",
      gageNeeded: m.gageNeeded.toString(),
      payAmount: pay.payAmount.toString(),
      maxPay: bpsMul(pay.payAmount, 10_000 + p.slippageBps).toString(),
      minLiquidity: bpsMul(m.liquidity, 10_000 - p.slippageBps).toString(),
      payAsset: p.payAsset,
      pools: [gageSgage.name, ...pay.pools],
      sgageUsed: m.sgageUsed.toString(),
      note: "No sGAGE is sold. Quotes assume the swap stays inside the pool's active tick range; the on-chain limits protect you if it does not."
    };
  }
  const z = solveZap({
    pool: swapState(state),
    amountSgage: p.amount,
    sgageIsCurrency0,
    sqrtLowerX96: getSqrtPriceAtTick(p.tickLower),
    sqrtUpperX96: getSqrtPriceAtTick(p.tickUpper)
  });
  return {
    route: "zap",
    sgageToSell: z.sgageToSell.toString(),
    maxSold: bpsMul(z.sgageToSell, 10_000 + p.slippageBps).toString(),
    feeOnSold: z.feeOnSold.toString(),
    minLiquidity: bpsMul(z.liquidity, 10_000 - p.slippageBps).toString(),
    gageOut: z.gageOut.toString(),
    sgageRemaining: z.sgageRemaining.toString(),
    pools: [gageSgage.name],
    note: `${ZAP_FEE_NOTE} Pool fee ${(state.lpFee / 10_000).toFixed(2)}% on ${z.sgageToSell} sGAGE sold.`
  };
}

/** Exported for tests: the liquidity a (sGAGE, GAGE) pair mints at a given price. */
export function liquidityFor(sqrtP: bigint, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint): bigint {
  return getLiquidityForAmounts(sqrtP, getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), amount0, amount1);
}
