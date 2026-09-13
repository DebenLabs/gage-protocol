// SPDX-License-Identifier: MIT
// Uniswap-derived portions: see THIRD_PARTY_NOTICES.md and licenses/Uniswap-v4-*-MIT.txt.
/**
 * Integer helpers ported from Uniswap's FullMath / FixedPoint96. BigInt is arbitrary precision, so the 512-bit
 * tricks in Solidity collapse to plain arithmetic; what matters is matching the rounding direction exactly.
 */
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const Q192 = 1n << 192n;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("mulDiv: division by zero");
  return (a * b) / denominator;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("mulDivRoundingUp: division by zero");
  const product = a * b;
  const q = product / denominator;
  return product % denominator === 0n ? q : q + 1n;
}

export function divRoundingUp(a: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("divRoundingUp: division by zero");
  const q = a / denominator;
  return a % denominator === 0n ? q : q + 1n;
}

/** Floor square root by Newton's method, seeded from above so every step is monotone. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  // 2^(ceil(bits/2)) >= sqrt(n): Newton from above converges monotonically to the floor root.
  const bits = n.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bits / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** `a - b` with uint256 wrap-around, the way fee-growth deltas are computed on-chain. */
export function wrappingSub256(a: bigint, b: bigint): bigint {
  return (a - b) & MAX_UINT256;
}

export function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
