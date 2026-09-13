// Token-layer views shared by several routes: the current epoch, the GAGE/sGAGE pool summary, burned this week.
import { db } from "ponder:api";
import { burns, creatorFeeSplits, emissionsState, epochs, floorBands, poolState } from "ponder:schema";
import { asc, eq, gte, sql } from "ponder";

import { loadDeployment, poolByName } from "../lib/deployment";
import { epochOf } from "../lib/emissions";
import { formatEpochs, formatPool } from "../lib/format";
import type { EpochJson, PoolSummaryJson } from "../lib/format";
import { amountsForLiquidity, formatWad, priceSgageInGageWad, sqrtPriceAtTick } from "../lib/pool";

export const deployment = loadDeployment();
export const ourPool = poolByName(deployment, "gageSgage");
export const sgageIsCurrency0 = ourPool !== undefined && ourPool.currency0 === deployment.token.sGAGE;

export const asDecimal = (v: unknown): string =>
  typeof v === "bigint" || typeof v === "number" ? v.toString() : String(v);

export type EmissionsRow = typeof emissionsState.$inferSelect;
export type PoolRow = typeof poolState.$inferSelect;

export async function currentEpoch(
  now: bigint,
): Promise<{ epoch: EpochJson | null; all: EpochJson[]; state: EmissionsRow | undefined }> {
  const [state, rows] = await Promise.all([
    db.select().from(emissionsState).where(eq(emissionsState.id, "emissions")).then((r) => r[0]),
    db.select().from(epochs).orderBy(asc(epochs.n)),
  ]);
  const all = formatEpochs(rows);
  const n = state === undefined ? null : epochOf(state.launchAt, state.epochLength, state.weeks, now);
  const epoch = n === null ? null : (all.find((e) => e.n === Number(n)) ?? null);
  return { epoch, all, state };
}

export async function ourPoolRow(): Promise<PoolRow | undefined> {
  if (ourPool == null) return undefined;
  return db.select().from(poolState).where(eq(poolState.poolId, ourPool.poolId)).then((r) => r[0]);
}

export async function poolSummary(): Promise<PoolSummaryJson | null> {
  const row = await ourPoolRow();
  return row === undefined ? null : formatPool(row, sgageIsCurrency0);
}

/** sGAGE burned since the current epoch started, or over the trailing seven days before launch. */
export async function burnedThisWeek(now: bigint, epochStart: number | null): Promise<string> {
  const since = epochStart === null ? now - 7n * 86_400n : BigInt(epochStart);
  const row = await db
    .select({ total: sql<string>`coalesce(sum(${burns.sgageBurned}), 0)` })
    .from(burns)
    .where(gte(burns.at, since))
    .then((r) => r[0]);
  return asDecimal(row?.total ?? "0");
}

export type FloorBandJson = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  swept: boolean;
  gageIn: string;
  sgageBurned: string;
};

export type FloorJson = {
  splitter: string;
  bandCount: number;
  activeBands: number;
  gageBacking: string;
  sgageHeld: string;
  gageToFloorAllTime: string;
  sgageBurnedAllTime: string;
  /** GAGE per whole sGAGE where the nearest band starts buying, and where its GAGE runs out. */
  supportFromGAGEperSGAGE: string | null;
  floorAtGAGEperSGAGE: string | null;
  bands: FloorBandJson[];
};

/**
 * The sGAGE floor (D46): every band the CreatorFeeSplitter owns, what it holds at the current price, and the two
 * prices that describe the nearest band. Null before the token layer or the splitter exists.
 */
export async function floorSummary(): Promise<FloorJson | null> {
  const splitter = deployment.token.CreatorFeeSplitter;
  if (splitter === undefined || ourPool === undefined) return null;
  const [rows, pool, splits] = await Promise.all([
    db.select().from(floorBands).orderBy(asc(floorBands.tokenId)),
    ourPoolRow(),
    db
      .select({ total: sql<string>`coalesce(sum(${creatorFeeSplits.gageToFloor}), 0)` })
      .from(creatorFeeSplits)
      .then((r) => r[0]),
  ]);
  let gageBacking = 0n;
  let sgageHeld = 0n;
  let sgageBurned = 0n;
  // GAGE is currency0 when sGAGE is not; a GAGE-only band sits above the tick then, below it otherwise
  const gageIsCurrency0 = !sgageIsCurrency0;
  let nearest: (typeof rows)[number] | undefined;
  for (const b of rows) {
    sgageBurned += b.sgageBurned;
    if (b.swept || b.liquidity === 0n) continue;
    if (pool !== undefined) {
      const { amount0, amount1 } = amountsForLiquidity(pool.sqrtPriceX96, b.tickLower, b.tickUpper, b.liquidity);
      gageBacking += gageIsCurrency0 ? amount0 : amount1;
      sgageHeld += gageIsCurrency0 ? amount1 : amount0;
      // the nearest band is the one with the smallest gap to the current tick on the GAGE side
      const gap = gageIsCurrency0 ? b.tickLower - pool.tick : pool.tick - b.tickUpper;
      const bestGap = nearest === undefined ? Number.MAX_SAFE_INTEGER : gageIsCurrency0 ? nearest.tickLower - pool.tick : pool.tick - nearest.tickUpper;
      if (gap >= 0 && gap < bestGap) nearest = b;
    }
  }
  const priceAt = (tick: number): string => formatWad(priceSgageInGageWad(sqrtPriceAtTick(tick), sgageIsCurrency0));
  // support starts at the band edge next to the market; the floor is where the band's GAGE runs out
  const supportFrom = nearest === undefined ? null : priceAt(gageIsCurrency0 ? nearest.tickLower : nearest.tickUpper);
  const floorAt = nearest === undefined ? null : priceAt(gageIsCurrency0 ? nearest.tickUpper : nearest.tickLower);
  return {
    splitter,
    bandCount: rows.length,
    activeBands: rows.filter((b) => !b.swept && b.liquidity > 0n).length,
    gageBacking: gageBacking.toString(),
    sgageHeld: sgageHeld.toString(),
    gageToFloorAllTime: asDecimal(splits?.total ?? "0"),
    sgageBurnedAllTime: sgageBurned.toString(),
    supportFromGAGEperSGAGE: supportFrom,
    floorAtGAGEperSGAGE: floorAt,
    bands: rows.map((b) => ({
      tokenId: b.tokenId.toString(),
      tickLower: b.tickLower,
      tickUpper: b.tickUpper,
      liquidity: b.liquidity.toString(),
      swept: b.swept,
      gageIn: b.gageIn.toString(),
      sgageBurned: b.sgageBurned.toString(),
    })),
  };
}
