// Epoch arithmetic for the emissions schedule (spec 12.5, IEmissions). Exact budgets arrive with `Released`; these
// derivations only fill the current epoch before its release.

import { BPS } from "./derive";

export const TERM_7 = 7 * 86_400;
export const TERM_21 = 21 * 86_400;

export function termBucket(term: number): 7 | 21 | null {
  if (term === TERM_7) return 7;
  if (term === TERM_21) return 21;
  return null;
}

/** 60/40 deals to liquidity, then 70/30 of the deal share to 21-day over 7-day deals, both adjustable per epoch. */
export function splitWeekly(
  weekly: bigint,
  dealShareBps: number,
  term21ShareBps: number,
): { dealBudget7: bigint; dealBudget21: bigint; liquidityBudget: bigint } {
  const dealBudget = (weekly * BigInt(dealShareBps)) / BPS;
  const dealBudget21 = (dealBudget * BigInt(term21ShareBps)) / BPS;
  return { dealBudget7: dealBudget - dealBudget21, dealBudget21, liquidityBudget: weekly - dealBudget };
}

export function epochBounds(launchAt: bigint, epochLength: bigint, n: bigint): { startsAt: bigint; endsAt: bigint } {
  const startsAt = launchAt + n * epochLength;
  return { startsAt, endsAt: startsAt + epochLength };
}

/** The epoch containing `t`, or null before launch or after the schedule ends. */
export function epochOf(launchAt: bigint | null, epochLength: bigint, weeks: number, t: bigint): bigint | null {
  if (launchAt === null || epochLength <= 0n || t < launchAt) return null;
  const n = (t - launchAt) / epochLength;
  return n >= BigInt(weeks) ? null : n;
}
