// Row -> docs/api.md shapes. Amounts are decimal strings in raw units, timestamps are numbers (unix seconds), ids are
// decimal strings (they are uint256 on-chain), addresses are already lowercase in the tables.
import type {
  assets,
  bids,
  burns,
  deals,
  drips,
  epochs,
  lpPositions,
  poolState,
  balances as balancesTable,
} from "ponder:schema";

import { costBps } from "./derive";
import type { PendingLPEarnings } from "./live-lp-earnings";
import { claimableAt, curvePoints, unlockedAt } from "./drip";
import type { CurvePoint } from "./drip";
import { depthInGage, formatWad, positionValueInGage, priceSgageInGageWad } from "./pool";

type DealRow = typeof deals.$inferSelect;
type BidRow = typeof bids.$inferSelect;
type BalanceRow = typeof balancesTable.$inferSelect;
type DripRow = typeof drips.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type EpochRow = typeof epochs.$inferSelect;
type PositionRow = typeof lpPositions.$inferSelect;
type PoolRow = typeof poolState.$inferSelect;
type BurnRow = typeof burns.$inferSelect;

const num = (v: bigint | number): number => Number(v);
const str = (v: bigint): string => v.toString();
const orNull = <T, R>(v: T | null, f: (x: T) => R): R | null => (v === null ? null : f(v));

export type BidJson = {
  id: string;
  dealId: string;
  lender: string;
  price: string;
  expiry: number;
  state: BidRow["state"];
  placedAt: number;
  tx: string;
};

export function formatBid(b: BidRow): BidJson {
  return {
    id: str(b.id),
    dealId: str(b.dealId),
    lender: b.lender,
    price: str(b.price),
    expiry: num(b.expiry),
    state: b.state,
    placedAt: num(b.placedAt),
    tx: b.tx,
  };
}

export type DealJson = {
  id: string;
  borrower: string;
  kind: DealRow["kind"];
  token: string;
  amountOrTokenId: string;
  cap: string;
  term: number;
  listingExpiry: number;
  minPrice: string;
  lender: string | null;
  price: string | null;
  fee: string | null;
  fundedAt: number | null;
  expiry: number | null;
  graceEnd: number | null;
  state: DealRow["state"];
  lane: DealRow["lane"];
  txs: { listed: string; funded: string | null; settled: string | null };
  listedAt: number;
  openBidCount: number;
  bestBid: BidJson | null;
};

export function formatDeal(d: DealRow, best: BidRow | null): DealJson {
  return {
    id: str(d.id),
    borrower: d.borrower,
    kind: d.kind,
    token: d.token,
    amountOrTokenId: str(d.amountOrTokenId),
    cap: str(d.cap),
    term: d.term,
    listingExpiry: num(d.listingExpiry),
    minPrice: str(d.minPrice),
    lender: d.lender,
    price: orNull(d.price, str),
    fee: orNull(d.fee, str),
    fundedAt: orNull(d.fundedAt, num),
    expiry: orNull(d.expiry, num),
    graceEnd: orNull(d.graceEnd, num),
    state: d.state,
    lane: d.lane,
    txs: { listed: d.listedTx, funded: d.fundedTx, settled: d.settledTx },
    listedAt: num(d.listedAt),
    openBidCount: d.openBidCount,
    bestBid: orNull(best, formatBid),
  };
}

export type AssetDealJson = { dealId: string; term: number; cap: string; price: string; costBps: number; fundedAt: number };

/** One row of `/assets/:token/deals`; only funded deals reach it, so price and fundedAt are set. */
export function formatAssetDeal(d: DealRow): AssetDealJson {
  const price = d.price ?? 0n;
  return {
    dealId: str(d.id),
    term: d.term,
    cap: str(d.cap),
    price: str(price),
    costBps: num(costBps(d.cap, price)),
    fundedAt: num(d.fundedAt ?? 0n),
  };
}

export type BalanceJson = { account: string; asset: string; amount: string; kind: BalanceRow["kind"] };

export function formatBalance(b: BalanceRow): BalanceJson {
  return { account: b.account, asset: b.asset, amount: str(b.amount), kind: b.kind };
}

export type DripJson = {
  id: string;
  account: string;
  source: DripRow["source"];
  dealId: string | null;
  tokenId: string | null;
  total: string;
  claimed: string;
  start: number;
  length: number;
  unlockedNow: string;
  claimableNow: string;
  curve: CurvePoint[];
};

export function formatDrip(d: DripRow, now: bigint): DripJson {
  const length = BigInt(d.length);
  return {
    id: d.dripId,
    account: d.account,
    source: d.source,
    dealId: orNull(d.dealId, str),
    tokenId: orNull(d.tokenId, str),
    total: str(d.total),
    claimed: str(d.claimed),
    start: num(d.start),
    length: d.length,
    unlockedNow: str(unlockedAt(d.total, d.start, length, now)),
    claimableNow: str(claimableAt(d.total, d.claimed, d.start, length, now)),
    curve: curvePoints(d.total, d.start, length),
  };
}

/** Sums across a wallet's drips for `/rewards/:wallet`. */
export function dripTotals(rows: DripRow[], now: bigint): { claimableNow: bigint; stillDripping: bigint } {
  let claimableNow = 0n;
  let stillDripping = 0n;
  for (const d of rows) {
    const length = BigInt(d.length);
    claimableNow += claimableAt(d.total, d.claimed, d.start, length, now);
    stillDripping += d.total - unlockedAt(d.total, d.start, length, now);
  }
  return { claimableNow, stillDripping };
}

export type AssetJson = {
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  lane: AssetRow["lane"];
  allowed: boolean;
  minAmount: string;
  maxDealRaw: string;
  maxOpenRaw: string;
  openRaw: string;
  uiMultiplier: string | null;
  pendingMultiplier: string | null;
  effectiveAt: number | null;
  paused: boolean | null;
};

export function formatAsset(a: AssetRow): AssetJson {
  return {
    token: a.token,
    symbol: a.symbol,
    name: a.name,
    decimals: a.decimals,
    lane: a.lane,
    allowed: a.allowed,
    minAmount: str(a.minAmount),
    maxDealRaw: str(a.maxDealRaw),
    maxOpenRaw: str(a.maxOpenRaw),
    openRaw: str(a.openRaw),
    uiMultiplier: orNull(a.uiMultiplier, str),
    pendingMultiplier: orNull(a.pendingMultiplier, str),
    effectiveAt: orNull(a.effectiveAt, num),
    paused: a.paused,
  };
}

export type EpochJson = {
  n: number;
  startsAt: number;
  endsAt: number;
  weekly: string;
  dealBudget7: string;
  dealBudget21: string;
  reserved7: string;
  reserved21: string;
  liquidityBudget: string;
  rate7: string | null;
  rate21: string | null;
  priceUSDGPerSGAGE: string | null;
  lenderShareBps: number | null;
  released: boolean;
  rolledOver: boolean;
};

type Rates = Pick<EpochRow, "rate7" | "rate21" | "priceUSDGPerSGAGE" | "lenderShareBps">;

/**
 * Rates carry forward (IDealRewards.effectiveRates): an epoch without posted rates uses the latest posted before
 * it. `rows` must be sorted by n ascending.
 */
export function formatEpochs(rows: EpochRow[]): EpochJson[] {
  let carried: Rates = { rate7: null, rate21: null, priceUSDGPerSGAGE: null, lenderShareBps: null };
  return rows.map((e) => {
    if (e.rate7 !== null && e.rate21 !== null) {
      carried = { rate7: e.rate7, rate21: e.rate21, priceUSDGPerSGAGE: e.priceUSDGPerSGAGE, lenderShareBps: e.lenderShareBps };
    }
    return {
      n: num(e.n),
      startsAt: num(e.startsAt),
      endsAt: num(e.endsAt),
      weekly: str(e.weekly),
      dealBudget7: str(e.dealBudget7),
      dealBudget21: str(e.dealBudget21),
      reserved7: str(e.reserved7),
      reserved21: str(e.reserved21),
      liquidityBudget: str(e.liquidityBudget),
      rate7: orNull(carried.rate7, str),
      rate21: orNull(carried.rate21, str),
      priceUSDGPerSGAGE: orNull(carried.priceUSDGPerSGAGE, str),
      lenderShareBps: carried.lenderShareBps,
      released: e.released,
      rolledOver: e.rolledOver,
    };
  });
}

export type PoolSummaryJson = {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  priceSGAGEinGAGE: string;
  totalWeight: string;
  depthGAGE: string;
};

export function formatPool(p: PoolRow, sgageIsCurrency0: boolean): PoolSummaryJson {
  return {
    poolId: p.poolId,
    currency0: p.currency0,
    currency1: p.currency1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    sqrtPriceX96: str(p.sqrtPriceX96),
    tick: p.tick,
    liquidity: str(p.liquidity),
    priceSGAGEinGAGE: formatWad(priceSgageInGageWad(p.sqrtPriceX96, sgageIsCurrency0)),
    totalWeight: str(p.totalWeight),
    depthGAGE: str(depthInGage(p.sqrtPriceX96, p.liquidity, sgageIsCurrency0)),
  };
}

export type LPPositionJson = {
  tokenId: string;
  owner: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  weight: string;
  inRange: boolean;
  valueGAGE: string;
  emissionsEarned: string;
  creatorFeeEarned: string;
  /** Uncollected `LPStreamer.earned(tokenId)` at the same block; "0" when the deployment has no streamer (D64). */
  streamerEarned: string;
  lastCheckpoint: number;
  isSeed: boolean;
};

export function formatPosition(
  p: PositionRow,
  earned: PendingLPEarnings,
  pool: PoolRow | undefined,
  sgageIsCurrency0: boolean,
): LPPositionJson {
  const valueGAGE =
    pool === undefined || pool.sqrtPriceX96 === 0n || p.liquidity === 0n
      ? 0n
      : positionValueInGage(pool.sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity, sgageIsCurrency0);
  return {
    tokenId: str(p.tokenId),
    owner: p.owner,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: str(p.liquidity),
    weight: str(p.weight),
    inRange: p.inRange,
    valueGAGE: str(valueGAGE),
    emissionsEarned: str(earned.emissionsEarned),
    creatorFeeEarned: str(earned.creatorFeeEarned),
    streamerEarned: str(earned.streamerEarned),
    lastCheckpoint: num(p.lastCheckpoint),
    isSeed: p.isSeed,
  };
}

export type BurnJson = { at: number; usdgSpent: string; gageBought: string; sgageBurned: string; caller: string; tx: string };

export function formatBurn(b: BurnRow): BurnJson {
  return {
    at: num(b.at),
    usdgSpent: str(b.usdgSpent),
    gageBought: str(b.gageBought),
    sgageBurned: str(b.sgageBurned),
    caller: b.caller,
    tx: b.tx,
  };
}

/**
 * Portfolio summary (design brief: "Received already" apart from "Still at stake"; "Paid out" apart from
 * "Awaiting expiry"), in USDG raw units over the wallet's FUNDED deals.
 */
export function portfolioSummary(
  asBorrower: DealRow[],
  asLender: DealRow[],
): { receivedAlready: string; stillAtStake: string; paidOut: string; awaitingExpiry: string } {
  let receivedAlready = 0n;
  let stillAtStake = 0n;
  let paidOut = 0n;
  let awaitingExpiry = 0n;
  for (const d of asBorrower) {
    if (d.state !== "FUNDED") continue;
    receivedAlready += (d.price ?? 0n) - (d.fee ?? 0n);
    stillAtStake += d.cap;
  }
  for (const d of asLender) {
    if (d.state !== "FUNDED") continue;
    paidOut += d.price ?? 0n;
    awaitingExpiry += d.cap;
  }
  return {
    receivedAlready: str(receivedAlready),
    stillAtStake: str(stillAtStake),
    paidOut: str(paidOut),
    awaitingExpiry: str(awaitingExpiry),
  };
}
