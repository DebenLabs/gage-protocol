import type { Address } from "viem";
import { isAddress } from "viem";
import { badRequest } from "../errors.js";

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function parseAddressParam(value: string | undefined, what: string): Address {
  if (value === undefined || !isAddress(value)) throw badRequest(`${what} must be an address`);
  return value.toLowerCase() as Address;
}

export function parseBigintParam(value: string | undefined, what: string, opts: { min?: bigint; required?: boolean } = {}): bigint | null {
  if (value === undefined || value === "") {
    if (opts.required === true) throw badRequest(`${what} is required`);
    return null;
  }
  if (!/^\d+$/.test(value)) throw badRequest(`${what} must be a non-negative integer in raw units`);
  const v = BigInt(value);
  if (opts.min !== undefined && v < opts.min) throw badRequest(`${what} must be at least ${opts.min}`);
  return v;
}

export function parseIntParam(value: string | undefined, what: string, opts: { min?: number; max?: number; required?: boolean } = {}): number | null {
  if (value === undefined || value === "") {
    if (opts.required === true) throw badRequest(`${what} is required`);
    return null;
  }
  if (!/^-?\d+$/.test(value)) throw badRequest(`${what} must be an integer`);
  const v = Number(value);
  if (!Number.isSafeInteger(v)) throw badRequest(`${what} is out of range`);
  if (opts.min !== undefined && v < opts.min) throw badRequest(`${what} must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw badRequest(`${what} must be at most ${opts.max}`);
  return v;
}

/** Term as seconds. Accepts "7", "21" (days), "7d", or a value in seconds (>= 3600). */
export function parseTermParam(value: string | undefined): number {
  if (value === undefined || value === "") throw badRequest("term is required (days, e.g. 7 or 21)");
  const m = /^(\d+)(d)?$/.exec(value.trim());
  if (m === null) throw badRequest("term must be a number of days (7, 21) or seconds");
  const n = Number(m[1]);
  if (m[2] === "d" || n <= 60) {
    if (n < 1 || n > 30) throw badRequest("term must be between 1 and 30 days");
    return n * 86_400;
  }
  if (n < 3600 || n > 30 * 86_400) throw badRequest("term in seconds must be between 1 hour and 30 days");
  return n;
}

export function bpsMul(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / 10_000n;
}
