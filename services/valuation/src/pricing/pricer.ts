/**
 * Spot prices from our Uniswap v4 pools. Stock Tokens price through the deepest stock/USDG pool, memes through their
 * stock pool and then that stock's USDG pool, ETH (native or WETH) through usdgEth. No oracle, no Chainlink.
 */
import type { Address, Hex } from "viem";
import type { ChainReader, PonsCurveState } from "../chain/reader.js";
import { NATIVE, hasV4, poolsWith, type Deployment, type Pool } from "../deployment.js";
import { ApiError } from "../errors.js";
import { Q96, Q192, isqrt, mulDiv } from "../math/fullMath.js";
import { getTickAtSqrtPrice } from "../math/tickMath.js";
import { ONE, applyPrice, invert, multiply, priceFromSqrtPriceX96, type Fraction } from "../math/price.js";

export interface PoolState {
  pool: Pool;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** Effective LP fee in pips (slot0 lpFee covers dynamic-fee pools). */
  lpFee: number;
  /** Packed directional protocol fees from v4 slot0. */
  protocolFee?: number;
  block: bigint;
  curve?: PonsCurveState;
  hookFeePips?: number;
}

export type SourceKind = "pool" | "two-hop" | "three-hop";

export interface PriceQuote {
  /** USDG raw per token raw. */
  price: Fraction;
  kind: SourceKind;
  pools: string[];
  block: bigint;
}

export interface PoolSide {
  amount0: bigint;
  amount1: bigint;
}

export class Pricer {
  constructor(
    private readonly reader: ChainReader,
    readonly deployment: Deployment
  ) {}

  get usdg(): Address {
    return this.deployment.usdg;
  }

  /** WETH and native ETH are the same asset for pricing. */
  aliases(token: Address): Address[] {
    const t = token.toLowerCase() as Address;
    const weth = this.deployment.tokens.WETH;
    if (t === NATIVE) return weth === undefined ? [t] : [t, weth];
    if (weth !== undefined && t === weth) return [t, NATIVE];
    return [t];
  }

  async poolState(pool: Pool): Promise<PoolState> {
    if (pool.protocol !== "v3" && !hasV4(this.deployment)) throw new ApiError("NO_POOL", "Uniswap v4 (PoolManager, StateView) is not in the deployment yet");
    const pons = pool.name === "gageEth" ? this.deployment.pons : undefined;
    if (pons) {
      const curve = await this.reader.ponsCurve(pons.curve);
      if (!curve.graduated) {
        if (curve.quoteReserve === 0n || curve.tokenReserve === 0n || curve.sellableTokens === 0n) throw new ApiError("NO_LIQUIDITY", "Pons curve is awaiting graduation");
        const sqrtPriceX96 = isqrt(Q192 * curve.tokenReserve / curve.quoteReserve);
        return { pool, sqrtPriceX96, tick: getTickAtSqrtPrice(sqrtPriceX96), liquidity: 0n,
          lpFee: curve.feeBps * 100, block: curve.block, curve };
      }
    }
    const [slot0, liquidity, block] = await Promise.all([this.reader.slot0(pool.poolId), this.reader.liquidity(pool.poolId), this.reader.blockNumber()]);
    if (slot0 === null) throw new ApiError("NO_POOL", `pool ${pool.name} is not initialised`);
    if (liquidity === 0n) throw new ApiError("NO_LIQUIDITY", `pool ${pool.name} has no active liquidity`);
    return { pool, sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, liquidity, lpFee: slot0.lpFee, protocolFee: slot0.protocolFee, block, ...(pons ? { hookFeePips: pons.hookFeePips } : {}) };
  }

  async poolStateByKey(poolId: Hex, fallback: Pool): Promise<PoolState> {
    const named = Object.values(this.deployment.pools).find((p) => p.poolId === poolId);
    return this.poolState(named ?? fallback);
  }

  /** Price of `token` in `other` (other-raw per token-raw) inside one pool. */
  static priceInPool(state: PoolState, token: Address): Fraction {
    const p = priceFromSqrtPriceX96(state.sqrtPriceX96);
    return token === state.pool.currency0 ? p : invert(p);
  }

  static otherCurrency(pool: Pool, token: Address): Address {
    return token === pool.currency0 ? pool.currency1 : pool.currency0;
  }

  /** Virtual reserves of the active liquidity, both sides, in raw units. */
  static virtualReserves(state: PoolState): PoolSide {
    if (state.curve) return { amount0: state.curve.realQuoteReserve, amount1: state.curve.sellableTokens };
    return { amount0: mulDiv(state.liquidity, Q96, state.sqrtPriceX96), amount1: mulDiv(state.liquidity, state.sqrtPriceX96, Q96) };
  }

  /** At most three pools: sGAGE -> GAGE -> native ETH -> USDG needs the third hop. Never revisit a token/pool. */
  routes(token: Address): Pool[][] {
    const targets = new Set(this.aliases(this.usdg));
    const out: Pool[][] = [];
    const walk = (current: Address, route: Pool[], seen: Set<Address>): void => {
      if (route.length >= 3) return;
      for (const alias of this.aliases(current)) {
        for (const pool of poolsWith(this.deployment, alias)) {
          if (route.some(p => p.poolId === pool.poolId)) continue;
          const next = Pricer.otherCurrency(pool, alias);
          if (this.aliases(next).some(a => seen.has(a))) continue;
          const extended = [...route, pool];
          if (targets.has(next)) out.push(extended);
          else walk(next, extended, new Set([...seen, ...this.aliases(next)]));
        }
      }
    };
    if (!targets.has(token)) walk(token, [], new Set(this.aliases(token)));
    return out;
  }

  /**
   * Spot price in USDG through the deepest route. Depth is the bottleneck along the path: the USDG value of the
   * active liquidity (both sides, as virtual reserves) of the shallowest pool on it.
   */
  async priceInUSDG(token: Address): Promise<PriceQuote> {
    const t = token.toLowerCase() as Address;
    if (this.aliases(this.usdg).includes(t)) {
      return { price: ONE, kind: "pool", pools: [], block: await this.reader.blockNumber() };
    }
    const routes = this.routes(t);
    if (routes.length === 0) {
      const code = hasV4(this.deployment) && Object.keys(this.deployment.pools).length > 0 ? "NO_ROUTE" : "NO_POOL";
      throw new ApiError(code, `no pool routes ${t} to USDG in the deployment`);
    }
    let best: { quote: PriceQuote; depth: bigint } | null = null;
    let lastError: unknown = null;
    // Route candidates are independent. Reader caches coalesce shared pool reads while
    // all candidates are evaluated in one RPC round, retaining deterministic tie order.
    const evaluatedRoutes = await Promise.allSettled(routes.map(route => this.evaluateRoute(t, route)));
    for (const result of evaluatedRoutes) {
      if (result.status === "fulfilled") {
        const evaluated = result.value;
        if (best === null || evaluated.depth > best.depth) best = evaluated;
      } else {
        lastError = result.reason;
      }
    }
    if (best === null) {
      if (lastError instanceof ApiError) throw lastError;
      throw new ApiError("NO_POOL", `no usable pool prices ${t}`);
    }
    return best.quote;
  }

  /** The deepest route from `token` to USDG, as the pools to walk in order (token side first). */
  async bestRoute(token: Address): Promise<Pool[]> {
    const t = token.toLowerCase() as Address;
    // The entry/payout codec currently executes v4 swaps only. V3 pools are valuation sources.
    const routes = this.routes(t).filter(route => route.every(p => p.protocol !== "v3"));
    if (routes.length === 0) {
      const code = hasV4(this.deployment) && Object.keys(this.deployment.pools).length > 0 ? "NO_ROUTE" : "NO_POOL";
      throw new ApiError(code, `no pool routes ${t} to USDG in the deployment`);
    }
    let best: { route: Pool[]; depth: bigint } | null = null;
    let lastError: unknown = null;
    const evaluatedRoutes = await Promise.allSettled(routes.map(route => this.evaluateRoute(t, route)));
    for (const [index, result] of evaluatedRoutes.entries()) {
      if (result.status === "fulfilled") {
        const evaluated = result.value;
        if (best === null || evaluated.depth > best.depth) best = { route: routes[index]!, depth: evaluated.depth };
      } else {
        lastError = result.reason;
      }
    }
    if (best === null) {
      if (lastError instanceof ApiError) throw lastError;
      throw new ApiError("NO_POOL", `no usable pool prices ${t}`);
    }
    return best.route;
  }

  private async evaluateRoute(token: Address, route: Pool[]): Promise<{ quote: PriceQuote; depth: bigint }> {
    const states = await Promise.all(route.map((p) => this.poolState(p)));
    // walk from the USDG end: price of each hop's output in USDG
    let priceOfOutputInUSDG: Fraction = ONE;
    let depth: bigint | null = null;
    let current = token;
    const hopTokens: Address[] = [];
    for (const state of states) {
      const start = this.aliases(current).find((a) => a === state.pool.currency0 || a === state.pool.currency1);
      if (start === undefined) throw new ApiError("NO_ROUTE", `pool ${state.pool.name} does not contain ${current}`);
      hopTokens.push(start);
      current = Pricer.otherCurrency(state.pool, start);
    }
    // now compose backwards
    let price: Fraction = ONE;
    for (let i = states.length - 1; i >= 0; i--) {
      const state = states[i]!;
      const start = hopTokens[i]!;
      const hop = Pricer.priceInPool(state, start); // other-raw per start-raw
      const reserves = Pricer.virtualReserves(state);
      const otherIsCurrency0 = start === state.pool.currency1;
      const otherAmount = otherIsCurrency0 ? reserves.amount0 : reserves.amount1;
      const poolDepth = 2n * applyPrice(otherAmount, priceOfOutputInUSDG);
      depth = depth === null || poolDepth < depth ? poolDepth : depth;
      price = multiply(hop, priceOfOutputInUSDG);
      priceOfOutputInUSDG = price;
    }
    const block = states.reduce((b, s) => (s.block > b ? s.block : b), 0n);
    return {
      quote: { price, kind: states.length === 1 ? "pool" : states.length === 2 ? "two-hop" : "three-hop", pools: states.map((s) => s.pool.name), block },
      depth: depth ?? 0n
    };
  }

  /** Depth of one pool in USDG: both virtual reserves valued at spot. */
  async depthUSDG(state: PoolState): Promise<bigint> {
    const reserves = Pricer.virtualReserves(state);
    const [p0, p1] = await Promise.all([this.priceInUSDG(state.pool.currency0), this.priceInUSDG(state.pool.currency1)]);
    return applyPrice(reserves.amount0, p0.price) + applyPrice(reserves.amount1, p1.price);
  }

  async valueInUSDG(token: Address, amount: bigint): Promise<{ value: bigint; quote: PriceQuote }> {
    const quote = await this.priceInUSDG(token);
    return { value: applyPrice(amount, quote.price), quote };
  }
}
