// The weekly rollup behind `/stats`: one row per calendar week (Monday 00:00 UTC), every column a running sum.
import type { Context } from "ponder:registry";
import { weekStats } from "ponder:schema";

import { weekStart } from "./stats";

type Db = Context["db"];
type WeekRow = typeof weekStats.$inferSelect;
export type WeekBump = Partial<Omit<WeekRow, "weekStart" | "updatedAt">>;

export const ZERO_WEEK: Omit<WeekRow, "weekStart" | "updatedAt"> = {
  listed: 0,
  bidsPlaced: 0,
  funded: 0,
  funded7: 0,
  funded21: 0,
  fundedUSDG: 0n,
  feesUSDG: 0n,
  reclaimed: 0,
  claimed: 0,
  cancelled: 0,
  sgageBurned: 0n,
  usdgSpentOnBuyback: 0n,
  sgageGranted: 0n,
  lpEmissions: 0n,
};

/** Adds `bump(row)` to the week containing `at`, creating the row from zeros when it is the week's first event. */
export async function bumpWeek(db: Db, at: bigint, bump: (row: WeekRow) => WeekBump): Promise<void> {
  const start = weekStart(at);
  const fresh: WeekRow = { weekStart: start, updatedAt: at, ...ZERO_WEEK };
  await db
    .insert(weekStats)
    .values({ ...fresh, ...bump(fresh) })
    .onConflictDoUpdate((row) => ({ ...bump(row), updatedAt: at }));
}
