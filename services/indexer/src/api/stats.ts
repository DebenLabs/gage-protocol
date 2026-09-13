// `GET /stats`: the Dashboard aggregates in docs/api.md, computed from the event-built tables on each request.
// Product TVL combines actual pool/escrow principal with outstanding funded loans, shown separately.
import { db } from "ponder:api";
import { buybackTotals, type BuybacksJson } from "./buybacks";
import { assets, balances, bids, deals, poolState, swaps, tvlPositions, vaultConstants, weekStats } from "ponder:schema";
import { and, asc, desc, eq, gte, inArray, lte, or } from "ponder";
import type { Address } from "viem";

import { costBps } from "../lib/derive";
import { termBucket } from "../lib/emissions";
import { formatWad, priceSgageInGageWad } from "../lib/pool";
import {
  DAY,
  PriceGraph,
  changeBps,
  dealPhase,
  lastWeeks,
  median,
  ratioBps,
  scaleDecimals,
  sharesBps,
  weekStart,
} from "../lib/stats";
import type { PoolPrice } from "../lib/stats";
import { calculateTvl, liveAt } from "../lib/tvl";
import { nftPrincipalValues } from "./tvl";
import { ZERO_WEEK } from "../lib/weeks";
import { currentEpoch, deployment, ourPool, sgageIsCurrency0 } from "./views";
import type { PoolRow } from "./views";

type WeekRow = typeof weekStats.$inferSelect;
type SwapRow = typeof swaps.$inferSelect;

const str = (v: bigint): string => v.toString();
const sum = (values: readonly bigint[]): bigint => values.reduce((acc, v) => acc + v, 0n);

export type StatsJson = {
  buybacks: BuybacksJson | null;
  tvlUSDG: string;
  tvlChange7dBps: number | null;
  tvlMethod: "position-principal-plus-loans-v2";
  tvlUnpricedItems: number;
  tvlPoolBalances: { token: string; amount: string }[];
  tvlBreakdown: { collateralInDeals: string; usdgInOpenBids: string; gageSgagePool: string; withdrawableBalances: string; outstandingLoans: string };
  byCollateral: { token: string; symbol: string; shareBps: number }[];
  fees: { thisWeek: string; allTime: string; byWeek: { week: number; usdg: string }[] };
  activeDeals: { total: number; term7: number; term21: number; fundedThisWeekUSDG: string };
  dealsByState: { LISTED: number; FUNDED: number; RECLAIMABLE: number; CLAIMABLE: number };
  settled30d: { reclaimed: number; claimed: number };
  walkAwayRateBps30d: number | null;
  medianCostBps30d: { term7: number | null; term21: number | null };
  medianCapShareBps: number | null;
  medianTimeToFundSeconds: number | null;
  bidsPerListing: number;
  wallets30d: number;
  emissions: {
    dealBudgetAllocated: string;
    dealBudgetTotal: string;
    poolEmissionsPerWeek: string;
    burnedThisWeek: string;
    burnedAllTime: string;
    netNewThisWeek: string;
  };
  sgagePrice: {
    gagePerSgage: string | null;
    usdgPerSgage: string | null;
    change7dBps: number | null;
    history30d: { t: number; price: string }[];
  };
};

/** A pool's price and active liquidity as of `t`: its last swap at or before `t`, else its current state. */
export type PoolAt = PoolPrice & { poolId: PoolRow["poolId"]; liquidity: bigint };

export async function poolsAt(rows: PoolRow[], t: bigint | null): Promise<PoolAt[]> {
  return Promise.all(
    rows.map(async (p) => {
      const current = { poolId: p.poolId, currency0: p.currency0, currency1: p.currency1, sqrtPriceX96: p.sqrtPriceX96, liquidity: p.liquidity };
      if (t === null) return current;
      const last = await db
        .select()
        .from(swaps)
        .where(and(eq(swaps.poolId, p.poolId), lte(swaps.at, t)))
        .orderBy(desc(swaps.at), desc(swaps.id))
        .limit(1)
        .then((r) => r[0]);
      return last === undefined ? current : { ...current, sqrtPriceX96: last.sqrtPriceX96, liquidity: last.liquidity };
    }),
  );
}


function sgageHistory(rows: SwapRow[], current: PoolRow | undefined, now: bigint): { t: number; price: string }[] {
  // One point per day: the day's last swap, with the current price as the final point.
  const byDay = new Map<bigint, SwapRow>();
  for (const s of rows) byDay.set(s.at / DAY, s);
  const points = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, s]) => ({ t: Number((day + 1n) * DAY - 1n), price: formatWad(priceSgageInGageWad(s.sqrtPriceX96, sgageIsCurrency0)) }));
  if (current !== undefined && current.sqrtPriceX96 !== 0n) {
    points.push({ t: Number(now), price: formatWad(priceSgageInGageWad(current.sqrtPriceX96, sgageIsCurrency0)) });
  }
  return points;
}

export async function buildStats(now: bigint): Promise<StatsJson> {
  const t7 = now - 7n * DAY;
  const t30 = now - 30n * DAY;
  const thisWeek = weekStart(now);
  const def = ourPool;

  const [dealRows, bidRows, weekRows, poolRows, assetRows, consts, buybacks, positionRows, creditRows, { epoch }, history] = await Promise.all([
    db
      .select()
      .from(deals)
      .where(
        or(inArray(deals.state, ["LISTED", "FUNDED"]), gte(deals.settledAt, t30), gte(deals.listedAt, t30), gte(deals.fundedAt, t30)),
      ),
    db.select().from(bids).where(or(eq(bids.state, "OPEN"), gte(bids.closedAt, t7), gte(bids.placedAt, t30))),
    db.select().from(weekStats).orderBy(asc(weekStats.weekStart)),
    db.select().from(poolState),
    db.select().from(assets),
    db.select().from(vaultConstants).where(eq(vaultConstants.id, "vault")).then((r) => r[0]),
    buybackTotals(thisWeek),
    db.select().from(tvlPositions),
    db.select().from(balances),
    currentEpoch(now),
    def === undefined
      ? Promise.resolve<SwapRow[]>([])
      : db
          .select()
          .from(swaps)
          .where(and(eq(swaps.poolId, def.poolId), gte(swaps.at, t30)))
          .orderBy(asc(swaps.at), asc(swaps.id)),
  ]);
  const usdg = consts?.usdg ?? deployment.m1.USDG;
  const usdgDecimals = consts?.usdgDecimals ?? 18;
  const symbols = new Map(assetRows.map((a) => [a.token, a.symbol]));

  const poolsNow = await poolsAt(poolRows, null);
  const nfts = [
    ...dealRows.filter(d => d.kind !== "ERC20" && liveAt(d, now)).map(d => ({ token: d.token, tokenId: d.amountOrTokenId })),
    ...creditRows.filter(b => b.kind === "NFT" && b.amount > 0n).map(b => ({ token: b.asset, tokenId: b.amount })),
  ];
  const [poolsThen, nftValues] = await Promise.all([
    poolsAt(poolRows, t7),
    nftPrincipalValues(nfts, poolsNow, new PriceGraph(poolsNow, deployment.token.WETH), usdg, ourPool?.poolId),
  ]);
  const tvlNow = calculateTvl(dealRows, bidRows, poolsNow, usdg, now, positionRows, creditRows, nftValues, deployment.m1.FeeSink, ourPool?.poolId, deployment.token.WETH);
  const total = tvlNow.collateral + tvlNow.bids + tvlNow.pool + tvlNow.withdrawable + tvlNow.outstandingLoans;
  const byCollateral = sharesBps([...tvlNow.byToken.entries()])
    .sort(([, a], [, b]) => b - a)
    .map(([token, shareBps]) => ({ token, symbol: symbols.get(token) ?? "?", shareBps }));

  // Weekly rollup: this week, all time, the last eight bars.
  const weeks = new Map(weekRows.map((w) => [w.weekStart, w]));
  const weekOrZero = (start: bigint): Omit<WeekRow, "weekStart" | "updatedAt"> => weeks.get(start) ?? ZERO_WEEK;
  const current = weekOrZero(thisWeek);
  const byWeek = lastWeeks(now, 8).map((start) => ({ week: Number(start), usdg: str(weekOrZero(start).feesUSDG) }));
  const allTimeFees = sum(weekRows.map((w) => w.feesUSDG));
  const burnedAllTime = sum(weekRows.map((w) => w.sgageBurned));

  // Live deals by phase.
  const phases = { LISTED: 0, FUNDED: 0, RECLAIMABLE: 0, CLAIMABLE: 0 };
  let term7 = 0;
  let term21 = 0;
  for (const d of dealRows) {
    const phase = dealPhase(d, now);
    if (phase !== null) phases[phase] += 1;
    if (d.state === "FUNDED") {
      const bucket = termBucket(d.term);
      if (bucket === 7) term7 += 1;
      if (bucket === 21) term21 += 1;
    }
  }

  // Trailing 30 days.
  const settled = dealRows.filter((d) => d.settledAt !== null && d.settledAt >= t30);
  const reclaimed = settled.filter((d) => d.state === "RECLAIMED").length;
  const claimed = settled.filter((d) => d.state === "CLAIMED").length;
  const funded30 = dealRows.filter((d) => d.fundedAt !== null && d.fundedAt >= t30 && d.price !== null);
  const costs = (bucket: 7 | 21): bigint[] =>
    funded30.filter((d) => termBucket(d.term) === bucket).map((d) => costBps(d.cap, d.price ?? 0n));
  const capShares = funded30
    .map((d) => {
      const value = tvlNow.priced.get(d.id);
      return value === undefined ? null : ratioBps(d.cap, value);
    })
    .filter((v): v is number => v !== null)
    .map(BigInt);
  const timesToFund = funded30.map((d) => (d.fundedAt ?? 0n) - d.listedAt);
  const listed30 = dealRows.filter((d) => d.listedAt >= t30);
  const listedIds = new Set(listed30.map((d) => d.id));
  const bidsOnListed30 = bidRows.filter((b) => listedIds.has(b.dealId)).length;
  const wallets = new Set<Address>();
  for (const d of listed30) wallets.add(d.borrower);
  for (const d of funded30) if (d.lender !== null) wallets.add(d.lender);
  for (const b of bidRows) if (b.placedAt >= t30) wallets.add(b.lender);

  // Emissions and the pool price.
  const ourRow = def === undefined ? undefined : poolRows.find((p) => p.poolId === def.poolId);
  const priceNow =
    ourRow === undefined || ourRow.sqrtPriceX96 === 0n ? null : priceSgageInGageWad(ourRow.sqrtPriceX96, sgageIsCurrency0);
  const ourThen =
    def === undefined ? undefined : poolsThen.find((p) => p.currency0 === def.currency0 && p.currency1 === def.currency1);
  const priceThen =
    ourThen === undefined || ourThen.sqrtPriceX96 === 0n ? null : priceSgageInGageWad(ourThen.sqrtPriceX96, sgageIsCurrency0);
  const usdgPerSgageRaw =
    deployment.token.sGAGE === undefined ? null : new PriceGraph(poolsNow, deployment.token.WETH).priceWad(deployment.token.sGAGE, usdg);
  const netNew = current.sgageGranted + current.lpEmissions - current.sgageBurned;
  const toNumber = (v: bigint | null): number | null => (v === null ? null : Number(v));

  return {
    buybacks,
    tvlUSDG: str(total),
    // Current position/credit rows cannot reconstruct historical balances. Do not compare against virtual depth.
    tvlChange7dBps: null,
    tvlMethod: "position-principal-plus-loans-v2",
    tvlUnpricedItems: tvlNow.unpriced,
    tvlPoolBalances: tvlNow.poolBalances,
    tvlBreakdown: {
      collateralInDeals: str(tvlNow.collateral),
      usdgInOpenBids: str(tvlNow.bids),
      gageSgagePool: str(tvlNow.pool),
      withdrawableBalances: str(tvlNow.withdrawable),
      outstandingLoans: str(tvlNow.outstandingLoans),
    },
    byCollateral,
    fees: { thisWeek: str(current.feesUSDG), allTime: str(allTimeFees), byWeek },
    activeDeals: {
      total: dealRows.filter((d) => d.state === "FUNDED").length,
      term7,
      term21,
      fundedThisWeekUSDG: str(current.fundedUSDG),
    },
    dealsByState: phases,
    settled30d: { reclaimed, claimed },
    walkAwayRateBps30d: ratioBps(BigInt(claimed), BigInt(reclaimed + claimed)),
    medianCostBps30d: { term7: toNumber(median(costs(7))), term21: toNumber(median(costs(21))) },
    medianCapShareBps: toNumber(median(capShares)),
    medianTimeToFundSeconds: toNumber(median(timesToFund)),
    bidsPerListing: listed30.length === 0 ? 0 : Math.round((bidsOnListed30 / listed30.length) * 100) / 100,
    wallets30d: wallets.size,
    emissions: {
      dealBudgetAllocated: epoch === null ? "0" : str(BigInt(epoch.reserved7) + BigInt(epoch.reserved21)),
      dealBudgetTotal: epoch === null ? "0" : str(BigInt(epoch.dealBudget7) + BigInt(epoch.dealBudget21)),
      poolEmissionsPerWeek: epoch === null ? "0" : epoch.liquidityBudget,
      burnedThisWeek: str(current.sgageBurned),
      burnedAllTime: str(burnedAllTime),
      netNewThisWeek: str(netNew),
    },
    sgagePrice: {
      gagePerSgage: priceNow === null ? null : formatWad(priceNow),
      usdgPerSgage: usdgPerSgageRaw === null ? null : formatWad(scaleDecimals(usdgPerSgageRaw, 18, usdgDecimals)),
      change7dBps: priceNow === null || priceThen === null ? null : changeBps(priceNow, priceThen),
      history30d: sgageHistory(history, ourRow, now),
    },
  };
}
