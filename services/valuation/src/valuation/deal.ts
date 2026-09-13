/**
 * GET /deals/:id/valuation. ERC-20 collateral at the deepest USDG route's spot; positions from liquidity, ticks and
 * sqrtPriceX96 with the standard amounts-for-liquidity maths plus uncollected fees from fee-growth deltas.
 */
import type { Address, Hex } from "viem";
import type { ChainReader, Lane, PositionInfo } from "../chain/reader.js";
import { hexSalt } from "../chain/viemReader.js";
import { poolIdOf, type Pool } from "../deployment.js";
import { ApiError } from "../errors.js";
import { uncollectedFees } from "../math/fees.js";
import { getAmountsForLiquidity } from "../math/liquidityAmounts.js";
import { applyPrice, fractionToDecimal, priceFromSqrtPriceX96, invert, multiply, scale, scaleSqrtPrice, type Fraction, ONE } from "../math/price.js";
import { MAX_TICK, MIN_TICK, MAX_SQRT_PRICE, MIN_SQRT_PRICE, getSqrtPriceAtTick } from "../math/tickMath.js";
import { Pricer, type PoolState, type PriceQuote } from "../pricing/pricer.js";
import { nowSeconds } from "../util/format.js";
import { MEME_CAP_SHARE_BPS, STOCK_CAP_SHARE_BPS } from "../facts/facts.js";

export interface Source {
  kind: "pool" | "two-hop" | "three-hop";
  pools: string[];
  asOfBlock: number;
}

export interface Scenarios {
  now: string;
  atCap: string;
  atRangeTop: string | null;
  down20: string;
  down50: string;
  down80: string | null;
  /** Additive (ui-screens "At range bottom · all <asset>"): the position holding only the asset side. */
  atRangeBottom: string | null;
}

/** Suggested cap for the Borrow screen: 90% of value for Stock Tokens and positions, 70% for memes (D44). */
export interface SuggestedCap {
  capUSDG: string;
  shareBps: number;
  basis: "90% of value · stocks and positions" | "70% of value · meme" | "50% of value · meme/USDG LP" | "50% of value · ecosystem/WETH LP";
}

export function suggestedCap(value: bigint, lane: Lane | "POSITION"): SuggestedCap {
  const shareBps = lane === "MEME" ? MEME_CAP_SHARE_BPS : STOCK_CAP_SHARE_BPS;
  return { capUSDG: ((value * BigInt(shareBps)) / 10_000n).toString(), shareBps, basis: lane === "MEME" ? "70% of value · meme" : "90% of value · stocks and positions" };
}

export interface PositionOut {
  tick: number;
  assetIsCurrency0: boolean;
  quoteAsset: { token: Address; symbol: string; decimals: number; priceUSDG: string };
  value0USDG: string;
  value1USDG: string;
  feesUSDG: string;
  rangeLowerUSDG: string;
  rangeUpperUSDG: string;
  scenarioAssumption: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  amount0: string;
  amount1: string;
  inRange: boolean;
  uncollectedFees0: string;
  uncollectedFees1: string;
}

export interface ValuationResponse {
  dealId: number;
  valueUSDG: string;
  priceUSDG: string;
  source: Source;
  scenarios: Scenarios;
  position: PositionOut | null;
  reference: { chainlink: null | { price: string; at: number } };
  at: number;
  /** Additive: the collateral price at which its value equals the cap, and the move from spot to get there. */
  capPrice: { priceUSDG: string; moveBps: number } | null;
  /** Additive: the cap the Borrow screen suggests, and which rule it used. */
  suggestedCap: SuggestedCap;
  lane: Lane | "POSITION";
  asset: { token: Address; symbol: string; decimals: number };
}

export interface ValuationDeps {
  reader: ChainReader;
  pricer: Pricer;
}

/** USDG per whole token, as a decimal string, from a raw-per-raw price. */
export function priceToDecimal(price: Fraction, tokenDecimals: number, usdgDecimals: number): string {
  return fractionToDecimal(price, tokenDecimals - usdgDecimals, 18);
}

function moveBps(from: Fraction, to: Fraction): number {
  // (to/from - 1) * 10000, floored towards zero, as a plain number
  const num = to.num * from.den * 10_000n;
  const den = to.den * from.num;
  return Number(num / den) - 10_000;
}

export async function valueDeal(deps: ValuationDeps, dealId: bigint): Promise<ValuationResponse> {
  const [deal, usdgMeta] = await Promise.all([deps.reader.getDeal(dealId), deps.reader.tokenMeta(deps.pricer.usdg)]);
  if (deal === null) throw new ApiError("NOT_FOUND", `deal ${dealId} does not exist`);
  if (deal.kind === "ERC20") return valueErc20(deps, deal.id, deal.token, deal.amountOrTokenId, deal.cap, usdgMeta.decimals);
  return valuePosition(deps, deal.id, deal.amountOrTokenId, deal.cap, usdgMeta.decimals);
}

async function valueErc20(deps: ValuationDeps, dealId: bigint, token: Address, amount: bigint, cap: bigint, usdgDecimals: number): Promise<ValuationResponse> {
  const [quote, meta, config] = await Promise.all([deps.pricer.priceInUSDG(token), deps.reader.tokenMeta(token), deps.reader.getERC20Config(token)]);
  const lane = config.lane;
  const value = applyPrice(amount, quote.price);
  const scenarios: Scenarios = {
    now: value.toString(),
    atCap: cap.toString(),
    atRangeTop: null,
    down20: applyPrice(amount, scale(quote.price, 80n, 100n)).toString(),
    down50: applyPrice(amount, scale(quote.price, 50n, 100n)).toString(),
    down80: lane === "MEME" ? applyPrice(amount, scale(quote.price, 20n, 100n)).toString() : null,
    atRangeBottom: null
  };
  const capPrice: Fraction | null = amount === 0n ? null : { num: cap, den: amount };
  return {
    dealId: Number(dealId),
    valueUSDG: value.toString(),
    priceUSDG: priceToDecimal(quote.price, meta.decimals, usdgDecimals),
    source: { kind: quote.kind, pools: quote.pools, asOfBlock: Number(quote.block) },
    scenarios,
    position: null,
    reference: { chainlink: null },
    at: nowSeconds(),
    capPrice: capPrice === null ? null : { priceUSDG: priceToDecimal(capPrice, meta.decimals, usdgDecimals), moveBps: moveBps(quote.price, capPrice) },
    suggestedCap: suggestedCap(value, lane),
    lane,
    asset: { token, symbol: meta.symbol, decimals: meta.decimals }
  };
}

/** Everything needed to value a position at any pool price; pure once built. */
export interface PositionModel {
  liquidity: bigint;
  sqrtLower: bigint;
  sqrtUpper: bigint;
  fees0: bigint;
  fees1: bigint;
  /** spot pool sqrt price */
  sqrtPriceX96: bigint;
  /** spot USDG prices of currency0 / currency1 (raw per raw) */
  p0: Fraction;
  p1: Fraction;
  /** which currency is "the asset" whose price the scenarios move; the other holds its USDG price constant */
  assetIsCurrency0: boolean;
  /** true if the asset is priced through this very pool (the other currency is USDG) */
  otherIsUSDG: boolean;
}

/** Position value in USDG when the pool sits at `sqrtP`: amounts plus fees, prices moved with the asset. */
export function positionValueAt(m: PositionModel, sqrtP: bigint): bigint {
  const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, m.sqrtLower, m.sqrtUpper, m.liquidity);
  // asset price moves with the pool price relative to spot: k = (p'/p) in asset-per-other terms
  const spot = priceFromSqrtPriceX96(m.sqrtPriceX96);
  const at = priceFromSqrtPriceX96(sqrtP);
  const k = m.assetIsCurrency0 ? multiply(at, invert(spot)) : multiply(spot, invert(at));
  const p0 = m.assetIsCurrency0 ? multiply(m.p0, k) : m.p0;
  const p1 = m.assetIsCurrency0 ? m.p1 : multiply(m.p1, k);
  return applyPrice(amount0 + m.fees0, p0) + applyPrice(amount1 + m.fees1, p1);
}

/** sqrt price after the asset's price is multiplied by pct/100. */
export function sqrtPriceForAssetMove(m: PositionModel, pctNum: bigint, pctDen: bigint): bigint {
  return m.assetIsCurrency0 ? scaleSqrtPrice(m.sqrtPriceX96, pctNum, pctDen) : scaleSqrtPrice(m.sqrtPriceX96, pctDen, pctNum);
}

/** The pool sqrt price where the position holds only the non-asset side (all USDG for a stock/USDG pool). */
export function rangeTopSqrtPrice(m: PositionModel): bigint {
  return m.assetIsCurrency0 ? m.sqrtUpper : m.sqrtLower;
}

/** The pool sqrt price where the position holds only the asset side. */
export function rangeBottomSqrtPrice(m: PositionModel): bigint {
  return m.assetIsCurrency0 ? m.sqrtLower : m.sqrtUpper;
}

/** Bisection on the asset price for value == cap. Value is monotone non-decreasing in the asset price. */
export function solveCapSqrtPrice(m: PositionModel, cap: bigint): bigint | null {
  let lo = MIN_SQRT_PRICE;
  let hi = MAX_SQRT_PRICE - 1n;
  const valueAt = (s: bigint): bigint => positionValueAt(m, s);
  // value rises with the pool price when the asset is currency0, falls when it is currency1
  const increasing = m.assetIsCurrency0;
  const vLo = valueAt(lo);
  const vHi = valueAt(hi);
  const [vMin, vMax] = increasing ? [vLo, vHi] : [vHi, vLo];
  if (cap < vMin || cap > vMax) return null;
  for (let i = 0; i < 200 && hi - lo > 1n; i++) {
    const mid = (lo + hi) >> 1n;
    const v = valueAt(mid);
    const below = increasing ? v < cap : v > cap;
    if (below) lo = mid;
    else hi = mid;
  }
  return hi;
}

export async function valuePosition(deps: ValuationDeps, dealId: bigint, tokenId: bigint, cap: bigint, usdgDecimals: number): Promise<ValuationResponse> {
  const info = await deps.reader.position(tokenId);
  if (info === null) throw new ApiError("NOT_FOUND", `position ${tokenId} does not exist on the PositionManager`);
  const built = await buildPositionModel(deps, info, tokenId);
  const { model, state, pool, quotes, assetMeta, asset, other, otherMeta } = built;
  const value = positionValueAt(model, model.sqrtPriceX96);
  const { amount0, amount1 } = getAmountsForLiquidity(model.sqrtPriceX96, model.sqrtLower, model.sqrtUpper, model.liquidity);
  const capSqrt = solveCapSqrtPrice(model, cap);
  const down = (pct: bigint): string => positionValueAt(model, sqrtPriceForAssetMove(model, pct, 100n)).toString();
  const assetPrice = model.assetIsCurrency0 ? model.p0 : model.p1;
  const capPrice = capSqrt === null ? null : assetPriceAt(model, capSqrt);
  const nearMax = info.tickUpper >= MAX_TICK - 1000;
  const nearMin = info.tickLower <= MIN_TICK + 1000;
  const topUnbounded = model.assetIsCurrency0 ? nearMax : nearMin;
  const bottomUnbounded = model.assetIsCurrency0 ? nearMin : nearMax;
  const pools = [pool.name, ...quotes.flatMap((q) => q.pools)].filter((v, i, a) => a.indexOf(v) === i);
  return {
    dealId: Number(dealId),
    valueUSDG: value.toString(),
    priceUSDG: priceToDecimal(assetPrice, assetMeta.decimals, usdgDecimals),
    source: { kind: quotes.some((q) => q.kind === "three-hop") ? "three-hop" : quotes.some((q) => q.kind === "two-hop") ? "two-hop" : "pool", pools, asOfBlock: Number(state.block) },
    scenarios: {
      now: value.toString(),
      atCap: capSqrt === null ? cap.toString() : positionValueAt(model, capSqrt).toString(),
      // A side that runs to the tick limit has no meaningful "all one asset" price; report null, not a number
      // with thirty digits.
      atRangeTop: topUnbounded ? null : positionValueAt(model, rangeTopSqrtPrice(model)).toString(),
      down20: down(80n),
      down50: down(50n),
      down80: (deps.pricer.deployment.vaultVersion ?? 1) >= 2 ? down(20n) : null,
      atRangeBottom: bottomUnbounded ? null : positionValueAt(model, rangeBottomSqrtPrice(model)).toString()
    },
    position: {
      tick: state.tick,
      assetIsCurrency0: model.assetIsCurrency0,
      quoteAsset: { token: other, ...otherMeta, priceUSDG: priceToDecimal(model.assetIsCurrency0 ? model.p1 : model.p0, otherMeta.decimals, usdgDecimals) },
      value0USDG: applyPrice(amount0 + model.fees0, model.p0).toString(),
      value1USDG: applyPrice(amount1 + model.fees1, model.p1).toString(),
      feesUSDG: (applyPrice(model.fees0, model.p0) + applyPrice(model.fees1, model.p1)).toString(),
      rangeLowerUSDG: priceToDecimal(assetPriceAt(model, rangeBottomSqrtPrice(model)), assetMeta.decimals, usdgDecimals),
      rangeUpperUSDG: priceToDecimal(assetPriceAt(model, rangeTopSqrtPrice(model)), assetMeta.decimals, usdgDecimals),
      scenarioAssumption: `${otherMeta.symbol} USDG price held constant; ${assetMeta.symbol} price moves.`,
      tickLower: info.tickLower,
      tickUpper: info.tickUpper,
      liquidity: model.liquidity.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      inRange: info.tickLower <= state.tick && state.tick < info.tickUpper,
      uncollectedFees0: model.fees0.toString(),
      uncollectedFees1: model.fees1.toString()
    },
    reference: { chainlink: null },
    at: nowSeconds(),
    capPrice: capPrice === null ? null : { priceUSDG: priceToDecimal(capPrice, assetMeta.decimals, usdgDecimals), moveBps: moveBps(assetPrice, capPrice) },
    suggestedCap: (deps.pricer.deployment.vaultVersion ?? 1) >= 2
      ? { capUSDG: (value / 2n).toString(), shareBps: 5000, basis: deps.pricer.deployment.vaultVersion === 3 ? "50% of value · ecosystem/WETH LP" : "50% of value · meme/USDG LP" }
      : suggestedCap(value, "POSITION"),
    lane: "POSITION",
    asset: { token: asset, symbol: assetMeta.symbol, decimals: assetMeta.decimals }
  };
}

function assetPriceAt(m: PositionModel, sqrtP: bigint): Fraction {
  const spot = priceFromSqrtPriceX96(m.sqrtPriceX96);
  const at = priceFromSqrtPriceX96(sqrtP);
  const k = m.assetIsCurrency0 ? multiply(at, invert(spot)) : multiply(spot, invert(at));
  return multiply(m.assetIsCurrency0 ? m.p0 : m.p1, k);
}

export interface BuiltPosition {
  model: PositionModel;
  state: PoolState;
  pool: Pool;
  quotes: PriceQuote[];
  asset: Address;
  assetMeta: { symbol: string; decimals: number };
  other: Address;
  otherMeta: { symbol: string; decimals: number };
}

export async function buildPositionModel(deps: ValuationDeps, info: PositionInfo, tokenId: bigint): Promise<BuiltPosition> {
  const key = info.poolKey;
  const poolId: Hex = poolIdOf(key);
  const fallback: Pool = { name: poolId, ...key, poolId, createdAt: null, createdBlock: null };
  const usdgAliases = deps.pricer.aliases(deps.pricer.usdg);
  const c0IsUSDG = usdgAliases.includes(key.currency0);
  const c1IsUSDG = usdgAliases.includes(key.currency1);
  const positionManager = deps.pricer.deployment.positionManager;
  if (positionManager === null) throw new ApiError("NO_POOL", "PositionManager is not in the deployment yet");
  // Once the position is known, prices, fees, lanes and metadata have no dependency
  // on one another. Launch them together so slow RPC reads do not form a waterfall.
  const [state, cfg0, cfg1, meta0, meta1, growth, feeState, quotes] = await Promise.all([
    deps.pricer.poolStateByKey(poolId, fallback),
    deps.reader.getERC20Config(key.currency0),
    deps.reader.getERC20Config(key.currency1),
    deps.reader.tokenMeta(key.currency0),
    deps.reader.tokenMeta(key.currency1),
    deps.reader.feeGrowthInside(poolId, info.tickLower, info.tickUpper),
    deps.reader.positionFeeState(poolId, positionManager, info.tickLower, info.tickUpper, hexSalt(tokenId)),
    c0IsUSDG || c1IsUSDG ? Promise.resolve([] as PriceQuote[]) :
      Promise.all([deps.pricer.priceInUSDG(key.currency0), deps.pricer.priceInUSDG(key.currency1)])
  ]);
  const pool = state.pool;
  // For meme/stock positions, scenarios move the meme while holding the stock's USDG price fixed.
  const assetIsCurrency0 = c0IsUSDG ? false : c1IsUSDG ? true : cfg1.lane === "MEME" && (cfg0.lane === "STOCK" || cfg0.lane === "ETH") ? false : true;
  const asset = assetIsCurrency0 ? key.currency0 : key.currency1;
  const other = assetIsCurrency0 ? key.currency1 : key.currency0;
  const otherIsUSDG = assetIsCurrency0 ? c1IsUSDG : c0IsUSDG;
  // Prices: when the other side is USDG, the asset prices through this pool; otherwise route each side.
  let pAsset: Fraction;
  let pOther: Fraction;
  if (otherIsUSDG) {
    pAsset = Pricer.priceInPool(state, asset);
    pOther = ONE;
  } else {
    pAsset = quotes[assetIsCurrency0 ? 0 : 1]!.price;
    pOther = quotes[assetIsCurrency0 ? 1 : 0]!.price;
    // Preserve the response's asset-first source ordering.
    if (!assetIsCurrency0) quotes.reverse();
  }
  const model: PositionModel = {
    liquidity: info.liquidity,
    sqrtLower: getSqrtPriceAtTick(info.tickLower),
    sqrtUpper: getSqrtPriceAtTick(info.tickUpper),
    fees0: (feeState.tokensOwed0 ?? 0n) + uncollectedFees(growth.inside0, feeState.feeGrowthInside0LastX128, feeState.liquidity),
    fees1: (feeState.tokensOwed1 ?? 0n) + uncollectedFees(growth.inside1, feeState.feeGrowthInside1LastX128, feeState.liquidity),
    sqrtPriceX96: state.sqrtPriceX96,
    p0: assetIsCurrency0 ? pAsset : pOther,
    p1: assetIsCurrency0 ? pOther : pAsset,
    assetIsCurrency0,
    otherIsUSDG
  };
  const [assetMeta, otherMeta] = assetIsCurrency0 ? [meta0, meta1] : [meta1, meta0];
  return { model, state, pool, quotes, asset, other, assetMeta: { symbol: assetMeta.symbol, decimals: assetMeta.decimals }, otherMeta: { symbol: otherMeta.symbol, decimals: otherMeta.decimals } };
}
