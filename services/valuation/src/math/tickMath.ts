// SPDX-License-Identifier: MIT
// Uniswap-derived portions: see THIRD_PARTY_NOTICES.md and licenses/Uniswap-v4-*-MIT.txt.
/**
 * Port of Uniswap v4-core TickMath (lib/v4-periphery/lib/v4-core/src/libraries/TickMath.sol) to BigInt.
 * getSqrtPriceAtTick is bit-for-bit the Solidity routine; getTickAtSqrtPrice uses its definition directly
 * (the greatest tick whose sqrt price is <= the input) via binary search, which is exact by construction.
 */
import { MAX_UINT256 } from "./fullMath.js";

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const MAGIC: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n
];

export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`invalid tick ${tick}`);
  }
  const absTick = BigInt(Math.abs(tick));
  let price = (absTick & 1n) !== 0n ? MAGIC[0]! : 1n << 128n;
  for (let i = 1; i < MAGIC.length; i++) {
    if ((absTick & (1n << BigInt(i))) !== 0n) price = (price * MAGIC[i]!) >> 128n;
  }
  if (tick > 0) price = MAX_UINT256 / price;
  // Q128.128 -> Q64.96, rounding up so the reverse lookup is consistent.
  return (price + ((1n << 32n) - 1n)) >> 32n;
}

/** Greatest tick t such that getSqrtPriceAtTick(t) <= sqrtPriceX96. */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
    throw new RangeError(`invalid sqrtPriceX96 ${sqrtPriceX96}`);
  }
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getSqrtPriceAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function maxUsableTick(tickSpacing: number): number {
  return Math.trunc(MAX_TICK / tickSpacing) * tickSpacing;
}

export function minUsableTick(tickSpacing: number): number {
  return Math.trunc(MIN_TICK / tickSpacing) * tickSpacing;
}

/** Largest multiple of `spacing` that is <= tick. */
export function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

/** Smallest multiple of `spacing` that is >= tick. */
export function ceilToSpacing(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

/** ln(1.0001), the tick unit in log-price space. */
export const LN_TICK = Math.log(1.0001);
