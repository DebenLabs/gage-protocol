// Uniswap v4 pool maths in bigint: tick -> sqrt price, amounts for liquidity, and the two GAGE-denominated figures
// the API shows (position value and pool depth). Both pool tokens have 18 decimals, so a price is a plain ratio.

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const WAD = 10n ** 18n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const MAGIC: readonly (readonly [number, bigint])[] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];
const MAX_UINT256 = (1n << 256n) - 1n;

/** Port of TickMath.getSqrtPriceAtTick: sqrt(1.0001^tick) * 2^96. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  const absTick = Math.abs(tick);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, factor] of MAGIC) {
    if ((absTick & bit) !== 0) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Round up when converting from Q128.128 to Q64.96, as the Solidity does.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

export function tickInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tickLower <= tick && tick < tickUpper;
}

function amount0For(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return (((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB) / sqrtA;
}

function amount1For(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

/** Token amounts a position holds at the current price (LiquidityAmounts.getAmountsForLiquidity). */
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtA = sqrtPriceAtTick(tickLower);
  const sqrtB = sqrtPriceAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtA) return { amount0: amount0For(sqrtA, sqrtB, liquidity), amount1: 0n };
  if (sqrtPriceX96 >= sqrtB) return { amount0: 0n, amount1: amount1For(sqrtA, sqrtB, liquidity) };
  return {
    amount0: amount0For(sqrtPriceX96, sqrtB, liquidity),
    amount1: amount1For(sqrtA, sqrtPriceX96, liquidity),
  };
}

/** GAGE per 1 sGAGE scaled by 1e18. `sgageIsCurrency0` says which side of the pool sGAGE sits on. */
export function priceSgageInGageWad(sqrtPriceX96: bigint, sgageIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  // token1 per token0. With sGAGE as currency0 that is already GAGE per sGAGE; otherwise invert.
  const price1In0Wad = (sqrtPriceX96 * sqrtPriceX96 * WAD) / Q192;
  if (sgageIsCurrency0) return price1In0Wad;
  return price1In0Wad === 0n ? 0n : (WAD * WAD) / price1In0Wad;
}

/** Renders a WAD-scaled ratio as a decimal string with 18 fractional digits. */
export function formatWad(x: bigint): string {
  const whole = x / WAD;
  const frac = (x % WAD).toString().padStart(18, "0");
  return `${whole.toString()}.${frac}`;
}

/** A position's value in GAGE at the pool price: its GAGE plus its sGAGE converted at that price. */
export function positionValueInGage(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  sgageIsCurrency0: boolean,
): bigint {
  const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity);
  const price = priceSgageInGageWad(sqrtPriceX96, sgageIsCurrency0);
  const [gage, sgage] = sgageIsCurrency0 ? [amount1, amount0] : [amount0, amount1];
  return gage + (sgage * price) / WAD;
}

/**
 * Depth in GAGE: the value of the active liquidity treated as a full-range position, i.e. twice its GAGE side
 * (2L/sqrtP when GAGE is currency0, 2L*sqrtP when it is currency1). The seed is full range, so this is the
 * figure the design brief calls "depth".
 */
export function depthInGage(sqrtPriceX96: bigint, liquidity: bigint, sgageIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const gageSide = sgageIsCurrency0 ? (liquidity * sqrtPriceX96) / Q96 : (liquidity * Q96) / sqrtPriceX96;
  return 2n * gageSide;
}
