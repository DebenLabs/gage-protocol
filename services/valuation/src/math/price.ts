/**
 * Prices as exact rationals in raw units. A Fraction { num, den } means `num / den` quote-raw per base-raw.
 */
import { Q192, isqrt, mulDiv } from "./fullMath.js";

export interface Fraction {
  num: bigint;
  den: bigint;
}

export const ONE: Fraction = { num: 1n, den: 1n };

/** currency1 raw per currency0 raw at a given sqrtPriceX96. */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint): Fraction {
  return { num: sqrtPriceX96 * sqrtPriceX96, den: Q192 };
}

export function invert(f: Fraction): Fraction {
  if (f.num === 0n) throw new RangeError("invert: zero price");
  return { num: f.den, den: f.num };
}

export function multiply(a: Fraction, b: Fraction): Fraction {
  return reduce({ num: a.num * b.num, den: a.den * b.den });
}

export function scale(f: Fraction, num: bigint, den: bigint): Fraction {
  return reduce({ num: f.num * num, den: f.den * den });
}

/** Floor of amount * f. */
export function applyPrice(amount: bigint, f: Fraction): bigint {
  return mulDiv(amount, f.num, f.den);
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function reduce(f: Fraction): Fraction {
  if (f.den === 0n) throw new RangeError("zero denominator");
  const g = gcd(f.num, f.den);
  return g <= 1n ? f : { num: f.num / g, den: f.den / g };
}

/** Compare two fractions: -1, 0, 1. */
export function compare(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/**
 * Format `f * 10^shift` as a decimal string with up to `digits` fractional digits, trailing zeros trimmed.
 * Used to turn a raw-units price into "USDG per one whole token".
 */
export function fractionToDecimal(f: Fraction, shift: number, digits = 18): string {
  const negative = f.num < 0n !== f.den < 0n && f.num !== 0n;
  let num = f.num < 0n ? -f.num : f.num;
  let den = f.den < 0n ? -f.den : f.den;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  const scaled = (num * 10n ** BigInt(digits)) / den;
  const s = scaled.toString().padStart(digits + 1, "0");
  const intPart = s.slice(0, s.length - digits);
  const fracPart = s.slice(s.length - digits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart}${fracPart ? "." + fracPart : ""}`;
}

/** Floating approximation of a fraction, for statistics and display only. Never feeds an amount. */
export function fractionToNumber(f: Fraction): number {
  const digits = 30;
  const scaled = (f.num * 10n ** BigInt(digits)) / f.den;
  return Number(scaled) / 10 ** digits;
}

/** sqrtPriceX96 after the price is multiplied by num/den (e.g. 8/10 for a 20% fall). */
export function scaleSqrtPrice(sqrtPriceX96: bigint, num: bigint, den: bigint): bigint {
  return isqrt((sqrtPriceX96 * sqrtPriceX96 * num) / den);
}

/** Floating price (currency1 per currency0, raw) from sqrtPriceX96, for volatility statistics. */
export function sqrtPriceToFloat(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s;
}
