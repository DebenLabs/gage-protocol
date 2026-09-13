import { describe, expect, it } from "vitest";

import { TERM_21, TERM_7, epochBounds, epochOf, splitWeekly, termBucket } from "../src/lib/emissions";

describe("splitWeekly", () => {
  it("splits 60/40 deals to liquidity and 70/30 of deals to 21-day", () => {
    const weekly = 402_000_000n * 10n ** 18n;
    const { dealBudget7, dealBudget21, liquidityBudget } = splitWeekly(weekly, 6_000, 7_000);
    expect(liquidityBudget).toBe((weekly * 4n) / 10n);
    expect(dealBudget21).toBe((((weekly * 6n) / 10n) * 7n) / 10n);
    expect(dealBudget7 + dealBudget21 + liquidityBudget).toBe(weekly);
  });
});

describe("epochs", () => {
  const launch = 1_757_894_400n; // Mon 15 Sep 2026 00:00 UTC
  const week = 7n * 86_400n;
  it("bounds an epoch", () => {
    expect(epochBounds(launch, week, 2n)).toEqual({ startsAt: launch + 2n * week, endsAt: launch + 3n * week });
  });
  it("finds the epoch containing a time, null outside the schedule", () => {
    expect(epochOf(launch, week, 52, launch - 1n)).toBeNull();
    expect(epochOf(launch, week, 52, launch)).toBe(0n);
    expect(epochOf(launch, week, 52, launch + week - 1n)).toBe(0n);
    expect(epochOf(launch, week, 52, launch + week)).toBe(1n);
    expect(epochOf(launch, week, 52, launch + 52n * week)).toBeNull();
    expect(epochOf(null, week, 52, launch)).toBeNull();
  });
  it("buckets terms", () => {
    expect(termBucket(TERM_7)).toBe(7);
    expect(termBucket(TERM_21)).toBe(21);
    expect(termBucket(86_400)).toBeNull();
  });
});
