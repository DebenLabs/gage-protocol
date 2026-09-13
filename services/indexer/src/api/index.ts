import { v3WalletPositions } from "../lib/v3-wallet-positions";
import { explorerNftIds } from "../lib/explorer-nfts";
// REST surface from docs/api.md ("Indexer"). Every list takes `limit` and `cursor` and returns { items, nextCursor };
// errors are { error: { code, message } }. `/health` is reserved by Ponder (liveness, empty 200), so the JSON health
// payload the contract describes is served at `/health/indexer` (see README).
import { Hono } from "hono";
import { v2Api } from "./v2";
import { earnApi, earnHealth } from "./earn";
import { db, publicClients } from "ponder:api";
import { assets, balances, bids, burns, dealRewards, deals, drips, lpPositions, nftPositions } from "ponder:schema";
import { and, asc, desc, eq, gt, inArray, isNotNull, max, or, sql } from "ponder";
import type { Address } from "viem";

import { loadPositionHistory, positionHistoryCandidates } from "../lib/position-history";
import { walletPositions } from "../lib/wallet-positions";
import { onchainPositionReader } from "../lib/wallet-position-reader";
import { liveLPEarnings, lpReadClient } from "../lib/live-lp-earnings";
import { CHAIN_NAME } from "../lib/deployment";
import { bestBid, nowSeconds } from "../lib/derive";
import { ApiError, badRequest, notFound } from "../lib/errors";
import {
  dripTotals,
  formatAsset,
  formatAssetDeal,
  formatBalance,
  formatBid,
  formatBurn,
  formatDeal,
  formatDrip,
  formatPosition,
  portfolioSummary,
} from "../lib/format";
import type { DealJson } from "../lib/format";
import { decodeCursor, page, parseLimit } from "../lib/pagination";

import type { Cursor } from "../lib/pagination";
import { buildGagePrice } from "./price";
import { buildStats } from "./stats";
import { streamerSummary } from "./streamer";
import {
  asDecimal,
  burnedThisWeek,
  currentEpoch,
  deployment,
  ourPoolRow,
  poolSummary,
  floorSummary,
  sgageIsCurrency0,
} from "./views";

type SQL = ReturnType<typeof sql>;

type BidRow = typeof bids.$inferSelect;

const DEAL_STATES = ["LISTED", "FUNDED", "RECLAIMED", "CLAIMED", "CANCELLED"] as const;
const LANES = ["STOCK", "ETH", "MEME", "POSITION"] as const;
const SORTS = ["newest", "expiry", "cap", "cost"] as const;

// ----------------------------------------------------------------- query parsing

function parseAddress(raw: string | undefined, name: string): Address {
  if (raw === undefined || !/^0x[0-9a-fA-F]{40}$/.test(raw)) throw badRequest("BAD_ADDRESS", `${name} must be an address`);
  return raw.toLowerCase() as Address;
}

function optional<T>(raw: string | undefined, parse: (v: string) => T): T | undefined {
  return raw === undefined || raw === "" ? undefined : parse(raw);
}

function parseEnum<const T extends readonly string[]>(values: T, name: string): (raw: string) => T[number] {
  return (raw) => {
    const hit = values.find((v) => v === raw.toUpperCase() || v === raw);
    if (hit == null) throw badRequest("BAD_ENUM", `${name} must be one of ${values.join(", ")}`);
    return hit;
  };
}

function parseId(raw: string | undefined, name: string): bigint {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw badRequest("BAD_ID", `${name} must be a non-negative integer`);
  return BigInt(raw);
}

function parseInteger(raw: string, name: string): number {
  if (!/^[0-9]+$/.test(raw)) throw badRequest("BAD_INTEGER", `${name} must be a non-negative integer`);
  return Number(raw);
}

// ----------------------------------------------------------------- keyset pagination over deals

type DealSort = { key: SQL; dir: "asc" | "desc" };

/** `(key, id) < (cursorKey, cursorId)` for a descending sort, `>` for ascending: stable keyset paging. */
function afterCursor(sort: DealSort, cursor: Cursor | null): SQL | undefined {
  if (cursor === null || cursor.k === null) return undefined;
  const tuple = sql`(${sort.key}, ${deals.id})`;
  const bound = sql`(${cursor.k}::numeric, ${cursor.id}::numeric)`;
  return sort.dir === "desc" ? sql`${tuple} < ${bound}` : sql`${tuple} > ${bound}`;
}

async function pageDeals(
  where: SQL | undefined,
  sort: DealSort,
  cursor: Cursor | null,
  limit: number,
): Promise<{ items: DealJson[]; nextCursor: string | null }> {
  const now = nowSeconds();
  const rows = await db
    .select({ deal: deals, key: sql<string>`${sort.key}`.as("sort_key") })
    .from(deals)
    .where(and(where, afterCursor(sort, cursor)))
    .orderBy(sort.dir === "desc" ? desc(sort.key) : asc(sort.key), sort.dir === "desc" ? desc(deals.id) : asc(deals.id))
    .limit(limit + 1);
  const paged = page(rows, limit, (r) => ({ k: asDecimal(r.key), id: r.deal.id.toString() }));
  const best = await bestBids(
    paged.items.map((r) => r.deal.id),
    now,
  );
  return { items: paged.items.map((r) => formatDeal(r.deal, best.get(r.deal.id) ?? null)), nextCursor: paged.nextCursor };
}

/** Highest OPEN unexpired bid per deal, one query for the page. */
async function bestBids(ids: bigint[], now: bigint): Promise<Map<bigint, BidRow>> {
  const result = new Map<bigint, BidRow>();
  if (ids.length === 0) return result;
  const rows = await db
    .select()
    .from(bids)
    .where(and(inArray(bids.dealId, ids), eq(bids.state, "OPEN"), gt(bids.expiry, now)));
  const byDeal = new Map<bigint, BidRow[]>();
  for (const b of rows) {
    const group = byDeal.get(b.dealId);
    if (group === undefined) byDeal.set(b.dealId, [b]);
    else group.push(b);
  }
  for (const [dealId, group] of byDeal) {
    const b = bestBid(group, now);
    if (b !== null) result.set(dealId, b);
  }
  return result;
}

/** Fixed cost at the best open bid, as a SQL expression, -1 when there is no bid so those listings sort last. */
function bestCostExpr(now: bigint): SQL {
  const best = db
    .select({ m: max(bids.price) })
    .from(bids)
    .where(and(eq(bids.dealId, deals.id), eq(bids.state, "OPEN"), gt(bids.expiry, now)));
  return sql`coalesce(floor((${deals.cap} - (${best})) * 10000 / (${best})), -1)`;
}

// ----------------------------------------------------------------- app

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(err);
  return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
});

app.get("/deployment", (c) => c.json({ chainId: deployment.chainId, addresses: { ...deployment.m1, ...deployment.token }, startBlock: deployment.startBlock }));

app.get("/listings", async (c) => {
  const now = nowSeconds();
  const q = c.req.query();
  const lane = optional(q.lane, parseEnum(LANES, "lane"));
  const term = optional(q.term, (v) => parseInteger(v, "term"));
  const asset = optional(q.asset, (v) => parseAddress(v, "asset"));
  const sortName = optional(q.sort, parseEnum(SORTS, "sort")) ?? "newest";
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor);

  const sort: DealSort =
    sortName === "expiry"
      ? { key: sql`${deals.listingExpiry}`, dir: "asc" }
      : sortName === "cap"
        ? { key: sql`${deals.cap}`, dir: "desc" }
        : sortName === "cost"
          ? { key: bestCostExpr(now), dir: "desc" }
          : { key: sql`${deals.listedAt}`, dir: "desc" };

  const where = and(
    eq(deals.state, "LISTED"),
    // a zero expiry is an open-ended listing (D43)
    or(eq(deals.listingExpiry, 0n), gt(deals.listingExpiry, now)),
    lane === undefined ? undefined : eq(deals.lane, lane),
    term === undefined ? undefined : eq(deals.term, term),
    asset === undefined ? undefined : eq(deals.token, asset),
  );
  return c.json(await pageDeals(where, sort, cursor, limit));
});

app.get("/deals", async (c) => {
  const q = c.req.query();
  const wallet = optional(q.wallet, (v) => parseAddress(v, "wallet"));
  const state = optional(q.state, parseEnum(DEAL_STATES, "state"));
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor);
  const where = and(
    wallet === undefined ? undefined : or(eq(deals.borrower, wallet), eq(deals.lender, wallet)),
    state === undefined ? undefined : eq(deals.state, state),
  );
  return c.json(await pageDeals(where, { key: sql`${deals.listedAt}`, dir: "desc" }, cursor, limit));
});

app.get("/deals/:id", async (c) => {
  const id = parseId(c.req.param("id"), "id");
  const deal = await db.select().from(deals).where(eq(deals.id, id)).then((r) => r[0]);
  if (deal == null) throw notFound("DEAL_NOT_FOUND", `deal ${id} does not exist`);
  const now = nowSeconds();
  const [dealBids, reward] = await Promise.all([
    db.select().from(bids).where(eq(bids.dealId, id)).orderBy(asc(bids.id)),
    db.select().from(dealRewards).where(eq(dealRewards.dealId, id)).then((r) => r[0]),
  ]);
  const rewardDrips = reward === undefined ? [] : await db.select().from(drips).where(eq(drips.dealId, id)).orderBy(asc(drips.id));
  return c.json({
    deal: formatDeal(deal, bestBid(dealBids, now)),
    bids: dealBids.map(formatBid),
    reward:
      reward === undefined
        ? null
        : {
            total: reward.reward.toString(),
            lender: reward.lenderAmount.toString(),
            borrower: reward.borrowerAmount.toString(),
            epoch: Number(reward.epoch),
            budgetExhausted: reward.budgetExhausted,
            drips: rewardDrips.map((d) => formatDrip(d, now)),
          },
  });
});

app.get("/portfolio/:wallet", async (c) => {
  const wallet = parseAddress(c.req.param("wallet"), "wallet");
  const now = nowSeconds();
  const newest = [desc(deals.listedAt), desc(deals.id)];
  const [asBorrower, asLender, walletBids, walletBalances, walletDrips] = await Promise.all([
    db.select().from(deals).where(eq(deals.borrower, wallet)).orderBy(...newest),
    db.select().from(deals).where(eq(deals.lender, wallet)).orderBy(...newest),
    db.select().from(bids).where(eq(bids.lender, wallet)).orderBy(desc(bids.id)),
    db
      .select()
      .from(balances)
      .where(and(eq(balances.account, wallet), or(eq(balances.kind, "NFT"), gt(balances.amount, 0n)))),
    db.select().from(drips).where(eq(drips.account, wallet)).orderBy(desc(drips.grantedAt), asc(drips.id)),
  ]);
  const best = await bestBids([...new Set([...asBorrower, ...asLender].map((deal) => deal.id))], now);
  return c.json({
    asBorrower: asBorrower.map((deal) => formatDeal(deal, best.get(deal.id) ?? null)),
    asLender: asLender.map((deal) => formatDeal(deal, best.get(deal.id) ?? null)),
    bids: walletBids.map(formatBid),
    balances: walletBalances.map(formatBalance),
    drips: walletDrips.map((d) => formatDrip(d, now)),
    summary: portfolioSummary(asBorrower, asLender),
  });
});

app.get("/rewards/:wallet", async (c) => {
  const wallet = parseAddress(c.req.param("wallet"), "wallet");
  const now = nowSeconds();
  const [rows, { epoch }, pool] = await Promise.all([
    db.select().from(drips).where(eq(drips.account, wallet)).orderBy(desc(drips.grantedAt), asc(drips.id)),
    currentEpoch(now),
    poolSummary(),
  ]);
  const totals = dripTotals(rows, now);
  return c.json({
    drips: rows.map((d) => formatDrip(d, now)),
    claimableNow: totals.claimableNow.toString(),
    stillDripping: totals.stillDripping.toString(),
    epoch,
    pool,
    burnedThisWeek: await burnedThisWeek(now, epoch?.startsAt ?? null),
  });
});

app.get("/pool", async (c) => {
  const now = nowSeconds();
  const [{ epoch, state }, recent, pool, floor] = await Promise.all([
    currentEpoch(now),
    db.select().from(burns).orderBy(desc(burns.at), desc(burns.id)).limit(50),
    poolSummary(),
    floorSummary(),
  ]);
  const weekly = epoch === null ? 0n : BigInt(epoch.weekly);
  const epochLength = state?.epochLength ?? 0n;
  const remaining = (budget: string, reserved: string): string => {
    const left = BigInt(budget) - BigInt(reserved);
    return (left < 0n ? 0n : left).toString();
  };
  return c.json({
    pool,
    epoch,
    burnedThisWeek: await burnedThisWeek(now, epoch?.startsAt ?? null),
    burns: recent.map(formatBurn),
    // The week's whole emission spread evenly over the epoch; the on-chain streams are per budget.
    emissionsRatePerSecond: epochLength === 0n ? "0" : (weekly / epochLength).toString(),
    budgets: {
      dealsRemaining7: epoch === null ? "0" : remaining(epoch.dealBudget7, epoch.reserved7),
      dealsRemaining21: epoch === null ? "0" : remaining(epoch.dealBudget21, epoch.reserved21),
      liquidity: epoch === null ? "0" : epoch.liquidityBudget,
    },
    floor,
  });
});

app.get("/streamer", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await streamerSummary(lpReadClient));
});

app.get("/positions/:wallet", async (c) => {
  const wallet = parseAddress(c.req.param("wallet"), "wallet");
  const positions = await db.select().from(lpPositions).where(eq(lpPositions.owner, wallet)).orderBy(asc(lpPositions.tokenId));
  c.header("Cache-Control", "no-store");
  if (positions.length === 0) return c.json({ positions: [] });
  if (!deployment.token.LPRewards) throw new ApiError(503, "LP_EARNINGS_UNAVAILABLE", "LP rewards are not configured.");
  const ids = positions.map((p) => p.tokenId);
  const [live, pool] = await Promise.all([
    liveLPEarnings(lpReadClient(), deployment.token.LPRewards, ids, deployment.token.LPStreamer),
    ourPoolRow(),
  ]);
  return c.json({
    earningsBlock: live.earningsBlock,
    earningsAsOf: live.earningsAsOf,
    positions: positions.map((p) => formatPosition(p, live.earned.get(p.tokenId)!, pool, sgageIsCurrency0)),
  });
});

/** Wallet-connect discovery: historical approved IDs plus new indexed transfers, verified on-chain now. */
app.get("/wallet/:address/positions", async (c) => {
  const wallet = parseAddress(c.req.param("address"), "address");
  const positionManager = deployment.token.PositionManager;
  if (positionManager === undefined) return c.json({ positions: [] });
  if(deployment.vaultVersion===3) return c.json({positions:await v3WalletPositions(publicClients[CHAIN_NAME],deployment,wallet)});
  const rows = await db.select({tokenId:nftPositions.tokenId}).from(nftPositions)
    .where(and(eq(nftPositions.owner,wallet),eq(nftPositions.burned,false)));
  const history = loadPositionHistory(deployment.chainId,positionManager,deployment.startBlock);
  const client = publicClients[CHAIN_NAME];
  const explorer = process.env.POSITION_EXPLORER_API;
  const discovered = explorer ? await explorerNftIds(explorer, wallet, positionManager) : [];
  const positions = await walletPositions(wallet, [...positionHistoryCandidates(history,wallet), ...discovered], rows.map(r=>r.tokenId), onchainPositionReader(client,positionManager,deployment.m1.CollateralRegistry), deployment.pools);
  return c.json({positions});
});

app.get("/assets", async (c) => {
  const lane = optional(c.req.query("lane"), parseEnum(LANES, "lane"));
  const rows = await db
    .select()
    .from(assets)
    .where(lane === undefined ? undefined : eq(assets.lane, lane))
    .orderBy(asc(assets.symbol), asc(assets.token));
  return c.json({ assets: rows.map(formatAsset) });
});

app.get("/assets/:token/deals", async (c) => {
  const token = parseAddress(c.req.param("token"), "token");
  const q = c.req.query();
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor);
  const sort: DealSort = { key: sql`${deals.fundedAt}`, dir: "desc" };
  const rows = await db
    .select({ deal: deals, key: sql<string>`${sort.key}`.as("sort_key") })
    .from(deals)
    .where(and(eq(deals.token, token), isNotNull(deals.fundedAt), afterCursor(sort, cursor)))
    .orderBy(desc(deals.fundedAt), desc(deals.id))
    .limit(limit + 1);
  const paged = page(rows, limit, (r) => ({ k: asDecimal(r.key), id: r.deal.id.toString() }));
  return c.json({ items: paged.items.map((r) => formatAssetDeal(r.deal)), nextCursor: paged.nextCursor });
});

app.get("/epochs", async (c) => {
  const { all } = await currentEpoch(nowSeconds());
  return c.json({ epochs: all });
});

app.get("/stats", async (c) => c.json(await buildStats(nowSeconds())));

app.get("/price", async (c) => c.json(await buildGagePrice(nowSeconds())));

type CheckpointRow = { chain_id: number | string; latest_checkpoint: string };

/** Ponder's checkpoint string: 10 digits of timestamp, 16 of chain id, then 16 of block number. */
const checkpointBlock = (checkpoint: string): number => Number(checkpoint.slice(26, 42));

app.get("/health/indexer", async (c) => {
  const client = publicClients[CHAIN_NAME];
  const [latest, checkpoints, earn] = await Promise.all([
    client.getBlockNumber(),
    db.execute(sql`select chain_id, latest_checkpoint from _ponder_checkpoint`),
    earnHealth(),
  ]);
  const rows = (Array.isArray(checkpoints) ? checkpoints : checkpoints.rows) as CheckpointRow[];
  const row = rows.find((r) => Number(r.chain_id) === deployment.chainId);
  const indexedBlock = row === undefined ? 0 : checkpointBlock(row.latest_checkpoint);
  const latestBlock = Number(latest);
  const lagBlocks = Math.max(0, latestBlock - indexedBlock);
  // Keep the previous deployment serving until a rebuilt index has caught up (about one minute of blocks).
  const ok = row !== undefined && lagBlocks <= 600;
  return c.json({ ok, chainId: deployment.chainId, latestBlock, indexedBlock, lagBlocks, earn }, ok ? 200 : 503);
});

app.route("/earn", earnApi);
app.route("/v2", v2Api);
app.all("*", (c) => c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));
export default app;
