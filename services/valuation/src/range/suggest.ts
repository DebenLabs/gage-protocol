/**
 * GET /range/suggest: width from 30-day realised volatility scaled to the term (sqrt of time), centred on the current
 * price and snapped to the pool's tick spacing. Fee estimate from 7-day volume, the fee tier and the position's share
 * of in-range liquidity. Labelled "Recommended", never "best".
 */
import type { Pool } from "../deployment.js";
import type { Indexer } from "../indexer/client.js";
import { Q96, mulDiv } from "../math/fullMath.js";
import { getAmountsForLiquidity, getLiquidityForAmounts } from "../math/liquidityAmounts.js";
import { sqrtPriceToFloat } from "../math/price.js";
import { horizonSigma, realisedVolatility, type PricePoint } from "../math/stats.js";
import { LN_TICK, ceilToSpacing, floorToSpacing, getSqrtPriceAtTick, maxUsableTick, minUsableTick } from "../math/tickMath.js";
import type { PoolState } from "../pricing/pricer.js";
import type { SampleStore } from "../facts/store.js";

export const RANGE_NOTE = "This position holds only one asset while the price is outside its range.";
export const RANGE_LABEL = "Recommended";

/** Log-symmetric default: spot / 1.5 to spot * 1.5 when no volatility data exists. */
export const DEFAULT_HALF_WIDTH_LOG = Math.log(1.5);

export interface RangeSuggestion {
  recommended: { tickLower: number; tickUpper: number; widthBps: number; note: string; label: string };
  full: { tickLower: number; tickUpper: number };
  feeEstimateBps: number | null;
  basis: {
    realisedVol30d: number | null;
    volume7d: string | null;
    inRangeShare: number;
    volSource: "indexer" | "samples" | "default";
    note: string;
    termDays: number;
    currentTick: number;
    sigmaTerm: number | null;
  };
}

export interface WidthInput {
  currentTick: number;
  tickSpacing: number;
  halfWidthLog: number;
}

/** Symmetric range in log-price space, snapped outwards to the spacing, at least one spacing each side. */
export function snapRange(input: WidthInput): { tickLower: number; tickUpper: number; widthBps: number } {
  const { currentTick, tickSpacing } = input;
  const halfTicks = Math.max(input.halfWidthLog / LN_TICK, tickSpacing);
  const tickLower = Math.max(minUsableTick(tickSpacing), floorToSpacing(currentTick - halfTicks, tickSpacing));
  const tickUpper = Math.min(maxUsableTick(tickSpacing), ceilToSpacing(currentTick + halfTicks, tickSpacing));
  const widthBps = Math.round((Math.exp((tickUpper - currentTick) * LN_TICK) - Math.exp((tickLower - currentTick) * LN_TICK)) * 10_000);
  return { tickLower, tickUpper, widthBps };
}

export interface FeeEstimateInput {
  state: { sqrtPriceX96: bigint; liquidity: bigint; lpFee: number };
  tickLower: number;
  tickUpper: number;
  /** 7-day volume through the pool in currency1 raw units. */
  volume7dCurrency1: bigint;
  termSeconds: number;
  /** Position size as a value in currency1 raw units; null = marginal position. */
  positionValueCurrency1: bigint | null;
}

/**
 * Fees earned over the term as bps of the position value. Fee share = position liquidity / in-range liquidity
 * (marginal when no size is given). Value per unit of liquidity comes from the amounts the range holds at spot.
 */
export function feeEstimateBps(input: FeeEstimateInput): { feeEstimateBps: number; inRangeShare: number } {
  const { state } = input;
  const sqrtLower = getSqrtPriceAtTick(input.tickLower);
  const sqrtUpper = getSqrtPriceAtTick(input.tickUpper);
  const unit = 10n ** 18n;
  const amounts = getAmountsForLiquidity(state.sqrtPriceX96, sqrtLower, sqrtUpper, unit);
  // value of one unit (1e18) of liquidity, in currency1 raw: amount0 * price + amount1
  const valuePerUnit = mulDiv(amounts.amount0, state.sqrtPriceX96 * state.sqrtPriceX96, Q96 * Q96) + amounts.amount1;
  if (valuePerUnit === 0n || state.liquidity === 0n) return { feeEstimateBps: 0, inRangeShare: 0 };
  const volumeTerm = (input.volume7dCurrency1 * BigInt(input.termSeconds)) / BigInt(7 * 86_400);
  const feesTerm = (volumeTerm * BigInt(state.lpFee)) / 1_000_000n;
  if (input.positionValueCurrency1 === null || input.positionValueCurrency1 === 0n) {
    // marginal: fees per unit liquidity = feesTerm / L_pool; bps = that / valuePerUnit
    const bps = Number((feesTerm * unit * 10_000n) / (state.liquidity * valuePerUnit));
    return { feeEstimateBps: bps, inRangeShare: 0 };
  }
  const positionLiquidity = (input.positionValueCurrency1 * unit) / valuePerUnit;
  const share = Number((positionLiquidity * 1_000_000n) / (state.liquidity + positionLiquidity)) / 1_000_000;
  const feesToPosition = (feesTerm * positionLiquidity) / (state.liquidity + positionLiquidity);
  const bps = Number((feesToPosition * 10_000n) / input.positionValueCurrency1);
  return { feeEstimateBps: bps, inRangeShare: share };
}

export interface SuggestDeps {
  indexer: Indexer;
  store: SampleStore;
  sigmaMultiplier: number;
}

export async function suggestRange(deps: SuggestDeps, pool: Pool, state: PoolState, termSeconds: number, positionValue: bigint | null): Promise<RangeSuggestion> {
  const now = Math.floor(Date.now() / 1000);
  const since30d = now - 30 * 86_400;
  const since7d = now - 7 * 86_400;
  const notes: string[] = [];
  let points: PricePoint[] = [];
  let volSource: RangeSuggestion["basis"]["volSource"] = "default";
  let volume7d: bigint | null = null;

  const indexed = await deps.indexer.pool(pool.name);
  if (indexed.value !== null && indexed.value.swaps.length > 0) {
    points = indexed.value.swaps.filter((s) => s.at >= since30d).map((s) => ({ at: s.at, price: sqrtPriceToFloat(s.sqrtPriceX96) }));
    volume7d = indexed.value.swaps.filter((s) => s.at >= since7d).reduce((acc, s) => acc + (s.amount1 < 0n ? -s.amount1 : s.amount1), 0n);
    volSource = "indexer";
  } else {
    notes.push(indexed.reason ?? "indexer has no swap history for this pool");
    const samples = deps.store.poolSamples(pool.poolId, since30d);
    if (samples.length > 0) {
      points = samples.map((s) => ({ at: s.at, price: sqrtPriceToFloat(BigInt(s.sqrtPriceX96)) }));
      volSource = "samples";
    }
  }

  const vol = realisedVolatility(points);
  let halfWidthLog = DEFAULT_HALF_WIDTH_LOG;
  let sigmaTerm: number | null = null;
  if (vol === null) {
    if (volSource !== "default") notes.push(`only ${points.length} price points in the last 30 days, below the minimum for a volatility estimate`);
    volSource = "default";
    notes.push("width falls back to a log-symmetric range from the current price divided by 1.5 to the current price multiplied by 1.5 (approximately -33% to +50%, before tick snapping)");
  } else {
    sigmaTerm = horizonSigma(vol.variancePerSecond, termSeconds);
    halfWidthLog = deps.sigmaMultiplier * sigmaTerm;
    notes.push(`width is ${deps.sigmaMultiplier}× the 30-day realised volatility scaled to the term by the square root of time`);
  }

  const snapped = snapRange({ currentTick: state.tick, tickSpacing: pool.tickSpacing, halfWidthLog });
  let fee: { feeEstimateBps: number; inRangeShare: number } | null = null;
  if (volume7d !== null) {
    fee = feeEstimateBps({ state, tickLower: snapped.tickLower, tickUpper: snapped.tickUpper, volume7dCurrency1: volume7d, termSeconds, positionValueCurrency1: positionValue });
  } else {
    notes.push("no 7-day volume available, so no fee estimate");
  }
  return {
    recommended: { ...snapped, note: RANGE_NOTE, label: RANGE_LABEL },
    full: { tickLower: minUsableTick(pool.tickSpacing), tickUpper: maxUsableTick(pool.tickSpacing) },
    feeEstimateBps: fee === null ? null : fee.feeEstimateBps,
    basis: {
      realisedVol30d: vol === null ? null : vol.annualised,
      volume7d: volume7d === null ? null : volume7d.toString(),
      inRangeShare: fee === null ? 0 : fee.inRangeShare,
      volSource,
      note: notes.join(". ") + ".",
      termDays: termSeconds / 86_400,
      currentTick: state.tick,
      sigmaTerm
    }
  };
}

/** Liquidity a position of the given amounts would mint at spot (used for minLiquidity bounds). */
export function liquidityAtSpot(state: { sqrtPriceX96: bigint }, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint): bigint {
  return getLiquidityForAmounts(state.sqrtPriceX96, getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), amount0, amount1);
}
