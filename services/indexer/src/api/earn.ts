import { db, publicClients } from "ponder:api";
import { earnCoreStates, earnReserveSamples, earnAccountHistory, earnAccountPockets, earnShareChanges, earnPocketClaims, earnAccounts, earnApprovals, earnEvents, earnLoans, earnPockets, earnRequests, earnStrategies } from "ponder:schema";
import { and, asc, eq, gt, gte, lte, sql } from "ponder";
import type { EarnAddress, EarnApproval, EarnLoan, EarnNotice, EarnPocket, EarnRequest, EarnStrategy } from "../../../../shared/earn";
import { createEarnApi, earnIndexerHealth, mergeEarnCoreState, withEarnStrategyPockets } from "../lib/earn-api";
import type { EarnApiDeployment, EarnStore } from "../lib/earn-api";
import { deployment } from "./views";
import { CHAIN_NAME } from "../lib/deployment";
import { createReserveRateSource } from "../lib/earn-reserve-rate";
import { materializeEarnAccount, publicEarnAccount, type EarnAccountRecord, type EarnPocketRecord } from "../lib/earn-account-state";

/** Only the selected deployment file can enable Earn strategies. */
const configured: EarnApiDeployment = {
  chainId: deployment.chainId,
  strategies: deployment.earnStrategies.map(item => ({ id: item.id, HybridVault: item.HybridVault, HybridReserve: item.HybridReserve, EarnCore: item.core })),
};

/** Rank the open queue once in SQL, before filtering by account or a response page. Closed rows have
 * position zero. No queue-wide writes run in the event handler or block publisher. */
async function requestRows(strategy: EarnAddress, account?: EarnAddress, afterId?: string, limit?: number) {
  const positions = db.$with("earn_open_positions").as(db.select({ key: earnRequests.key, position: sql<number>`(row_number() over (order by ${earnRequests.number}))::integer`.as("position") }).from(earnRequests).where(and(eq(earnRequests.strategy, strategy), eq(earnRequests.open, true))));
  const query = db.with(positions).select({ id: earnRequests.id, snapshot: earnRequests.snapshot, position: positions.position }).from(earnRequests).leftJoin(positions, eq(earnRequests.key, positions.key))
    .where(and(eq(earnRequests.strategy, strategy), account ? eq(earnRequests.account, account) : undefined, afterId ? gt(earnRequests.id, afterId) : undefined)).orderBy(asc(earnRequests.id));
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map(row => ({ id: row.id, snapshot: { ...JSON.parse(row.snapshot) as EarnRequest, position: row.position ?? 0 } }));
}

async function materializedAccount(strategy: EarnAddress, record: EarnAccountRecord) {
  const [current, pockets, changes, claims, history, cached, requests] = await Promise.all([
    db.select().from(earnStrategies).where(and(eq(earnStrategies.address, strategy), eq(earnStrategies.ready, true))).limit(1),
    db.select().from(earnPockets).where(eq(earnPockets.strategy, strategy)),
    db.select().from(earnShareChanges).where(and(eq(earnShareChanges.strategy, strategy), eq(earnShareChanges.account, record.account))).orderBy(asc(earnShareChanges.position)),
    db.select().from(earnPocketClaims).where(and(eq(earnPocketClaims.strategy, strategy), eq(earnPocketClaims.account, record.account))),
    db.select().from(earnAccountHistory).where(and(eq(earnAccountHistory.strategy, strategy), eq(earnAccountHistory.account, record.account))).orderBy(asc(earnAccountHistory.block)),
    db.select().from(earnAccountPockets).where(and(eq(earnAccountPockets.strategy, strategy), eq(earnAccountPockets.account, record.account))),
    requestRows(strategy, record.account),
  ]);
  const row = current[0];
  if (!row) throw new Error("Earn publication unavailable");
  return publicEarnAccount(materializeEarnAccount({ ...record, requests: requests.map(request => request.snapshot).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1) }, { snapshot: JSON.parse(row.snapshot) as EarnStrategy, shareAssetsNumerator: String(row.shareAssetsNumerator), shareAssetsDenominator: String(row.shareAssetsDenominator) },
    pockets.map(pocket => JSON.parse(pocket.snapshot) as EarnPocketRecord).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1), changes, claims,
    history.map(sample => ({ block: sample.block, asOf: Number(sample.asOf), value: BigInt(sample.value), flow: BigInt(sample.flow) })), new Map(cached.map(pocket => [pocket.pocketId, pocket.balanceAt]))));
}

function publicPocket(pocket: EarnPocketRecord, snapshot: EarnStrategy): EarnPocket {
  const { snapshotPosition, createdPosition, ...value } = pocket;
  void snapshotPosition; void createdPosition;
  return { ...value, blockNumber: snapshot.blockNumber, asOf: snapshot.asOf };
}

export const earnStore: EarnStore = {
  async strategy(address, options) {
    const [row] = await db.select().from(earnStrategies).where(and(eq(earnStrategies.address, address), eq(earnStrategies.ready, true))).limit(1);
    if (!row) return undefined;
    const snapshot = JSON.parse(row.snapshot) as EarnStrategy;
    return withEarnStrategyPockets({ snapshot, shareAssetsNumerator: row.shareAssetsNumerator.toString(), shareAssetsDenominator: row.shareAssetsDenominator.toString() }, async () => {
      const pockets = (await db.select().from(earnPockets).where(eq(earnPockets.strategy, address))).map(pocket => JSON.parse(pocket.snapshot) as EarnPocketRecord).filter(pocket => BigInt(pocket.blockNumber) <= row.block).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      return pockets.map(pocket => publicPocket(pocket, snapshot));
    }, options?.includePockets ?? true);
  },
  async account(strategy, account) {
    const [row] = await db.select().from(earnAccounts).where(and(eq(earnAccounts.strategy, strategy), eq(earnAccounts.account, account))).limit(1);
    return row ? materializedAccount(strategy, JSON.parse(row.snapshot) as EarnAccountRecord) : undefined;
  },
  async list(kind, query) {
    const { strategy, account, afterId, limit } = query;
    if (kind === "accounts") {
      const rows = await db.select().from(earnAccounts).where(and(eq(earnAccounts.strategy, strategy), account ? eq(earnAccounts.account, account) : undefined, afterId ? gt(earnAccounts.account, afterId as EarnAddress) : undefined)).orderBy(asc(earnAccounts.account)).limit(limit);
      return Promise.all(rows.map(async row => ({ id: row.account, snapshot: await materializedAccount(strategy, JSON.parse(row.snapshot) as EarnAccountRecord) })));
    }
    if (kind === "requests") {
      return requestRows(strategy, account, afterId, limit);
    }
    if (kind === "loans") {
      const rows = await db.select({ id: earnLoans.id, snapshot: earnLoans.snapshot, coreState: earnCoreStates.state, coreSettledBlock: earnCoreStates.block }).from(earnLoans)
        .leftJoin(earnCoreStates, eq(earnLoans.dealId, earnCoreStates.dealId))
        .where(and(eq(earnLoans.strategy, strategy), afterId ? gt(earnLoans.id, afterId) : undefined))
        .orderBy(asc(earnLoans.id)).limit(limit);
      return rows.map(row => ({ id: row.id, snapshot: mergeEarnCoreState(JSON.parse(row.snapshot) as EarnLoan, { state: row.coreState, settledBlock: row.coreSettledBlock }, query.blockNumber) }));
    }
    if (kind === "pockets") {
      const rows = await db.select().from(earnPockets).where(and(eq(earnPockets.strategy, strategy), afterId ? gt(earnPockets.id, afterId) : undefined)).orderBy(asc(earnPockets.id)).limit(limit);
      return rows.map(row => { const { snapshotPosition, createdPosition, ...snapshot } = JSON.parse(row.snapshot) as EarnPocketRecord; void snapshotPosition; void createdPosition; return { id: row.id, snapshot }; });
    }
    if (kind === "approvals") {
      // IDs are decimal strings in B1. Use the same text order as every other collection's cursor.
      const id = sql<string>`cast(${earnApprovals.dealId} as text)`;
      // The contract accepts equality at the snapshot block. A keeper may apply a stricter
      // submission-time guard because its transaction will be included in a later block.
      const rows = await db.select().from(earnApprovals).where(and(eq(earnApprovals.strategy, strategy), afterId ? gt(id, afterId) : undefined, query.active ? eq(earnApprovals.funded, false) : undefined, query.active ? eq(earnApprovals.revoked, false) : undefined, query.active ? gte(earnApprovals.validUntil, BigInt(query.asOf)) : undefined)).orderBy(asc(id)).limit(limit);
      return rows.map(row => ({ id: row.dealId.toString(), snapshot: JSON.parse(row.snapshot) as EarnApproval }));
    }
    const rows = await db.select().from(earnEvents).where(and(eq(earnEvents.strategy, strategy), account ? eq(earnEvents.account, account) : undefined, afterId ? gt(earnEvents.id, afterId) : undefined)).orderBy(asc(earnEvents.id)).limit(limit);
    return rows.map(row => ({ id: row.id, snapshot: JSON.parse(row.snapshot) as EarnNotice }));
  },
};

async function fetchKeeper(strategy: EarnAddress) {
  const base = process.env.EARN_KEEPER_URL;
  if (!base) return undefined;
  const url = new URL("/health/earn", base);
  url.searchParams.set("strategy", strategy);
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { Accept: "application/json" } });
  // An unhealthy worker still supplies useful pending-transaction and retry details with its 503 response.
  if (!response.ok && response.status !== 503) return undefined;
  return response.json() as Promise<unknown>;
}

/** The reserve rate reads off the hourly conversion samples; two archive reads fill in while the series is shorter than a week. */
const reserveSamples = async (snapshot: EarnStrategy) => (await db.select().from(earnReserveSamples)
  .where(and(eq(earnReserveSamples.strategy, snapshot.address), gte(earnReserveSamples.asOf, BigInt(snapshot.asOf) - 8n * 86_400n), lte(earnReserveSamples.asOf, BigInt(snapshot.asOf))))
  .orderBy(asc(earnReserveSamples.asOf))).map(row => ({ block: row.block, asOf: row.asOf, assets: row.assets }));
const reserveRate = createReserveRateSource(publicClients[CHAIN_NAME], { samples: reserveSamples });

export const earnApi = createEarnApi({ deployment: configured, store: earnStore, keeperFetch: fetchKeeper, reserveRate });
export const earnHealth = () => earnIndexerHealth(earnStore, configured);
