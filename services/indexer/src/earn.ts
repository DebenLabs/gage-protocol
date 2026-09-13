import { ponder, type Context } from "ponder:registry";
import { earnReserveSamples, earnTokenInventory, earnAccountRefresh, earnAccountHistory, earnAccountPockets, earnAccountPocketProgress, earnShareChanges, earnLoanSnapshots, earnPocketClaims, earnAccounts, earnApprovals, earnEvents, earnLoans, earnPockets, earnRequests, earnRequestCounts, earnStrategies } from "ponder:schema";
import { and, asc, desc, eq, gt, gte, lte } from "ponder";
import { parseAbi, type Abi } from "viem";
import type { EarnAddress, EarnApproval, EarnLoan, EarnNotice, EarnRequest, EarnStrategy } from "../../../shared/earn";
import { earnEventPosition, type EarnAccountRecord, type EarnPocketRecord } from "./lib/earn-account-state";
import { HybridVaultAbi } from "../abis/HybridVault";
import { HybridFeesAbi } from "../abis/HybridFees";
import { HybridReserveAbi } from "../abis/HybridReserve";
import { GageV2VaultAbi } from "../abis/v2/GageV2Vault";
import { CollateralRegistryAbi } from "../abis/CollateralRegistry";
import { ERC20MetadataAbi } from "../abis/ERC20Metadata";
import { envInt } from "./lib/env";
import { loadDeployment } from "./lib/deployment";
import { earnFlowOf, earnSettlementNotices, syncEarnAccount, syncEarnAccounts, syncEarnApproval, syncEarnCoreLoan, syncEarnLoan, syncEarnLoans, syncEarnPocket, syncEarnRequest, syncEarnStrategy, type EarnConfig, type EarnReader, type EarnSyncStore } from "./lib/earn-sync";

const deployment = loadDeployment();
const strategies = deployment.earnStrategies;
const byVault = new Map(strategies.map(entry => [entry.HybridVault.toLowerCase(), entry]));
const snapshotInterval = envInt("EARN_SNAPSHOT_INTERVAL", 100);
if (snapshotInterval < 1) throw new Error("EARN_SNAPSHOT_INTERVAL must be positive");
// A rebuilt index replays the whole Earn history: a periodic refresh costs about fifty chain reads per strategy, so
// blocks older than the backfill age refresh at the backfill interval (about ten minutes of chain), which still
// records the hourly reserve sample. Strategy events refresh at every block they touch, whatever the age.
const backfillInterval = envInt("EARN_BACKFILL_INTERVAL", 6000);
if (backfillInterval < snapshotInterval) throw new Error("EARN_BACKFILL_INTERVAL must not be below EARN_SNAPSHOT_INTERVAL");
const BACKFILL_AGE_SECONDS = 900n;
const backfilling = (asOf: bigint) => asOf < BigInt(Math.floor(Date.now() / 1000)) - BACKFILL_AGE_SECONDS;
const zero = "0x0000000000000000000000000000000000000000";
const lower = (s: string) => s.toLowerCase() as EarnAddress;
const stringify = (value: unknown) => JSON.stringify(value);
const readAbi: Abi = [...HybridVaultAbi, ...HybridFeesAbi, ...HybridReserveAbi, ...GageV2VaultAbi, ...CollateralRegistryAbi, ...ERC20MetadataAbi, ...parseAbi([
  "function uiMultiplier() view returns (uint256)",
  // GageV2Rewards.allocation: the lender total is what the strategy's quarters earn over the term.
  "function allocation(uint256 id) view returns ((address borrower, uint40 start, uint40 end, uint32 term, uint128 borrowerTotal, uint128 lenderTotal, uint128 borrowerAccounted, address[4] lenders))",
])];
const EVENTS = ["Deposited", "Withdrawn", "RedeemRequested", "RequestCancelled", "RequestServed", "Claimed", "ReserveInvested", "ReserveDivested", "LoanApproved", "LoanRevoked", "LoanFunded", "CommitmentWithdrawn", "LoanOverdue", "Settled", "ProfitReported", "LossReported", "CashHarvested", "CollateralRecovered", "PocketCreated", "PocketClaimed", "RewardsHarvested", "RewardsClaimed", "LaneWeightSet", "TokenCeilingSet", "FeeSet", "FeesSet", "FeesClaimed", "Paused", "MaxTotalDepositsSet"] as const;

type EarnEntry = (typeof strategies)[number];

function bindings(context: Context, entry: EarnEntry) {
  const config: EarnConfig = { chainId: deployment.chainId, id: entry.id, title: entry.title, HybridVault: entry.HybridVault, HybridReserve: entry.HybridReserve, EarnCore: entry.core, USDG: deployment.m1.USDG, RewardToken: deployment.token.sGAGE };
  const strategy = entry.HybridVault;
  const key = (id: string) => `${strategy}:${id}`;
  const read: EarnReader = async (address, functionName, args, blockNumber) => context.client.readContract({ address, abi: readAbi, functionName, args, blockNumber, ...(functionName === "uiMultiplier" ? { retryEmptyResponse: false } : {}) });
  const store: EarnSyncStore = {
    accountPage: async (after, limit) => (await context.db.sql.select().from(earnAccounts).where(and(eq(earnAccounts.strategy, strategy), after ? gt(earnAccounts.account, after) : undefined)).orderBy(asc(earnAccounts.account)).limit(limit)).map(row => JSON.parse(row.snapshot) as EarnAccountRecord),
    accountCursor: async () => {
      const row = await context.db.find(earnAccountRefresh, { strategy });
      return { after: row?.after ?? undefined, active: row?.active ?? undefined, pocketAfter: row?.pocketAfter ?? undefined };
    },
    saveAccountCursor: async cursor => {
      const row = { strategy, after: cursor.after ?? null, active: cursor.active ?? null, pocketAfter: cursor.pocketAfter ?? null };
      await context.db.insert(earnAccountRefresh).values(row).onConflictDoUpdate(row);
    },
    pocketPage: async (after, limit) => (await context.db.sql.select().from(earnPockets).where(and(eq(earnPockets.strategy, strategy), after ? gt(earnPockets.number, BigInt(after)) : undefined)).orderBy(asc(earnPockets.number)).limit(limit)).map(row => JSON.parse(row.snapshot) as EarnPocketRecord),
    accountPocketCursor: async account => (await context.db.find(earnAccountPocketProgress, { key: key(account) }))?.after.toString(),
    saveAccountPocketCursor: async (account, after) => {
      const row = { key: key(account), after: BigInt(after) };
      await context.db.insert(earnAccountPocketProgress).values(row).onConflictDoUpdate(row);
    },
    accountPocket: async (account, pocket) => {
      if (pocket.snapshotPosition === undefined) throw new Error("Earn pocket snapshot event missing");
      const [balance] = await context.db.sql.select().from(earnShareChanges).where(and(eq(earnShareChanges.strategy, strategy), eq(earnShareChanges.account, account), lte(earnShareChanges.position, BigInt(pocket.snapshotPosition)))).orderBy(desc(earnShareChanges.position)).limit(1);
      const row = { key: `${strategy}:${account}:${pocket.id}`, strategy, account, pocketId: pocket.id, balanceAt: balance?.balance ?? 0n };
      await context.db.insert(earnAccountPockets).values(row).onConflictDoUpdate(row);
    },
    admittedTokens: async () => (await context.db.sql.select().from(earnTokenInventory).where(eq(earnTokenInventory.strategy, strategy))).map(row => row.token),
    strategy: async () => {
      const row = await context.db.find(earnStrategies, { address: strategy });
      return row ? JSON.parse(row.snapshot) as EarnStrategy : undefined;
    },
    saveStrategy: async (value, ratio) => {
      const row = { address: strategy, ready: false, snapshot: stringify(value), block: BigInt(value.blockNumber), asOf: BigInt(value.asOf), shareAssetsNumerator: ratio.numerator, shareAssetsDenominator: ratio.denominator };
      await context.db.insert(earnStrategies).values(row).onConflictDoUpdate(row);
    },
    account: async account => {
      const row = await context.db.find(earnAccounts, { key: key(account) });
      return row ? JSON.parse(row.snapshot) as EarnAccountRecord : undefined;
    },
    saveAccount: async value => {
      const row = { key: key(value.account), strategy, account: value.account, snapshot: stringify(value) };
      await context.db.insert(earnAccounts).values(row).onConflictDoUpdate(row);
    },
    history: async account => (await context.db.sql.select().from(earnAccountHistory).where(and(eq(earnAccountHistory.strategy, strategy), eq(earnAccountHistory.account, account))).orderBy(earnAccountHistory.block)).map(row => ({ block: row.block, value: BigInt(row.value), flow: BigInt(row.flow), asOf: Number(row.asOf) })),
    saveHistory: async (account, row) => {
      const record = { key: `${strategy}:${account}:${row.block}`, strategy, account, block: row.block, asOf: BigInt(row.asOf), value: String(row.value), flow: String(row.flow) };
      await context.db.insert(earnAccountHistory).values(record).onConflictDoUpdate(record);
    },
    loans: async () => (await context.db.sql.select().from(earnLoans).where(and(eq(earnLoans.strategy, strategy), eq(earnLoans.settled, false)))).map(row => JSON.parse(row.snapshot) as EarnLoan),
    loan: async id => {
      const row = await context.db.find(earnLoans, { key: key(id) });
      return row ? JSON.parse(row.snapshot) as EarnLoan : undefined;
    },
    saveLoan: async value => {
      const row = { key: key(value.id), strategy, id: value.id, dealId: BigInt(value.dealId), settled: value.settled, snapshot: stringify(value) };
      await context.db.insert(earnLoans).values(row).onConflictDoUpdate(row);
    },
    openRequestCount: async () => (await context.db.find(earnRequestCounts, { strategy }))?.count ?? 0,
    requests: async account => (await context.db.sql.select().from(earnRequests).where(and(eq(earnRequests.strategy, strategy), account ? eq(earnRequests.account, account) : eq(earnRequests.open, true)))).map(row => JSON.parse(row.snapshot) as EarnRequest),
    request: async id => {
      const row = await context.db.find(earnRequests, { key: key(id) });
      return row ? JSON.parse(row.snapshot) as EarnRequest : undefined;
    },
    saveRequest: async value => {
      const row = { key: key(value.id), strategy, id: value.id, number: BigInt(value.id), account: value.account, open: value.status === "pending" || value.status === "partial", snapshot: stringify(value) };
      const previous = await context.db.find(earnRequests, { key: row.key });
      const change = Number(row.open) - Number(previous?.open ?? false);
      if (change !== 0) {
        const current = await context.db.find(earnRequestCounts, { strategy });
        const count = (current?.count ?? 0) + change;
        if (count < 0) throw new Error("Earn request count underflow");
        await context.db.insert(earnRequestCounts).values({ strategy, count }).onConflictDoUpdate({ count });
      }
      await context.db.insert(earnRequests).values(row).onConflictDoUpdate(row);
    },
    pockets: async () => (await context.db.sql.select().from(earnPockets).where(eq(earnPockets.strategy, strategy))).map(row => JSON.parse(row.snapshot) as EarnPocketRecord),
    pocket: async id => {
      const row = await context.db.find(earnPockets, { key: key(id) });
      return row ? JSON.parse(row.snapshot) as EarnPocketRecord : undefined;
    },
    savePocket: async value => {
      const row = { key: key(value.id), strategy, id: value.id, number: BigInt(value.id), snapshot: stringify(value) };
      await context.db.insert(earnPockets).values(row).onConflictDoUpdate(row);
    },
    approvals: async at => (await context.db.sql.select().from(earnApprovals).where(and(eq(earnApprovals.strategy, strategy), eq(earnApprovals.funded, false), eq(earnApprovals.revoked, false), at === undefined ? undefined : gte(earnApprovals.validUntil, at)))).map(row => JSON.parse(row.snapshot) as EarnApproval),
    approval: async id => {
      const row = await context.db.find(earnApprovals, { key: key(id) });
      return row ? JSON.parse(row.snapshot) as EarnApproval : undefined;
    },
    saveApproval: async value => {
      const row = { key: key(value.dealId), strategy, dealId: BigInt(value.dealId), snapshot: stringify(value), funded: value.funded, revoked: value.revoked, validUntil: BigInt(value.validUntil) };
      await context.db.insert(earnApprovals).values(row).onConflictDoUpdate(row);
    },
    notice: async value => {
      const row = { key: key(value.id), strategy, id: value.id, account: value.account, snapshot: stringify(value) };
      await context.db.insert(earnEvents).values(row).onConflictDoNothing();
    },
    latestReserveSample: async () => {
      const [row] = await context.db.sql.select().from(earnReserveSamples).where(eq(earnReserveSamples.strategy, strategy)).orderBy(desc(earnReserveSamples.asOf)).limit(1);
      return row ? { block: row.block, asOf: row.asOf, assets: row.assets } : undefined;
    },
    saveReserveSample: async row => {
      const record = { key: key(String(row.block)), strategy, block: row.block, asOf: row.asOf, assets: row.assets };
      await context.db.insert(earnReserveSamples).values(record).onConflictDoUpdate(record);
    },
  };
  return { config, read, store };
}

/** The strategy publishes once its fee companion is wired: `fees()` names a deployed contract that names the strategy back. */
async function readyForSnapshot(context: Context, block: bigint, entry: EarnEntry) {
  if (await context.db.find(earnStrategies, { address: entry.HybridVault })) return true;
  // A later instance of the factory does not exist before its recorded start block: no chain read for the
  // blocks between the earliest strategy's start and its own, which the shared block handler also visits.
  if (block < BigInt(entry.startBlock)) return false;
  const vaultCode = await context.client.getCode({ address: entry.HybridVault, blockNumber: block });
  if (!vaultCode || vaultCode === "0x") return false;
  const fees = lower(String(await context.client.readContract({ address: entry.HybridVault, abi: HybridVaultAbi, functionName: "fees", blockNumber: block })));
  if (fees === zero) return false;
  const feesCode = await context.client.getCode({ address: fees, blockNumber: block });
  if (!feesCode || feesCode === "0x") return false;
  return lower(String(await context.client.readContract({ address: fees, abi: HybridFeesAbi, functionName: "STRATEGY", blockNumber: block }))) === entry.HybridVault;
}

/** Ponder 0.17.9's default multichain runtime commits complete blocks atomically in both live and historical
 * indexing (runtime/multichain.ts; sync-store.getEventData preserves whole-block page boundaries). SQL cache
 * flushes use that same transaction. Later logs cannot expose an intermediate publication, and a failed
 * handler rolls the transaction back. Recheck these guarantees when upgrading Ponder. */
async function publishEarnStrategy(context: Context, entry: EarnEntry, block: bigint, asOf: bigint, token?: EarnAddress) {
  const { config, read, store } = bindings(context, entry);
  await syncEarnLoans(config, read, store, block, asOf);
  await syncEarnStrategy(config, read, store, block, asOf, token);
  await syncEarnAccounts(config, read, store, block, asOf);
  await context.db.update(earnStrategies, { address: entry.HybridVault }).set({ ready: true });
}

/** Called by the core's existing event registration so there is one handler per Ponder event. */
export async function refreshEarnCoreLoan(context: Context, engine: EarnAddress, id: bigint, block: bigint, asOf: bigint) {
  // Several strategies can lend through the same core; each one that holds the loan refreshes its own view.
  for (const entry of strategies) {
    if (lower(engine) !== entry.core || !await readyForSnapshot(context, block, entry)) continue;
    const { config, read, store } = bindings(context, entry);
    if (await syncEarnCoreLoan(config, read, store, engine, id, block, asOf)) await publishEarnStrategy(context, entry, block, asOf);
  }
}

if (strategies.length) {
  ponder.on("EarnSnapshot:block", async ({ event, context }) => {
    const cadence = BigInt(backfilling(event.block.timestamp) ? backfillInterval : snapshotInterval);
    for (const entry of strategies) {
      const current = await context.db.find(earnStrategies, { address: entry.HybridVault });
      const refresh = !current?.ready || event.block.number - current.block >= cadence;
      if (!refresh) continue;
      // Companion deployment and one-time wiring can follow the initial configuration events.
      if (!await readyForSnapshot(context, event.block.number, entry)) continue;
      await publishEarnStrategy(context, entry, event.block.number, event.block.timestamp);
    }
  });

  for (const name of EVENTS) {
    ponder.on(`HybridVault:${name}`, async ({ event, context }) => {
      // One handler serves every strategy address; the emitting vault selects the strategy.
      const entry = byVault.get(String(event.log.address).toLowerCase());
      if (!entry) throw new Error("Earn event from an unpublished strategy");
      const { config, read, store } = bindings(context, entry);
      const block = event.block.number, asOf = event.block.timestamp, tx = event.transaction.hash;
      const args = event.args as Record<string, unknown>;
      const token = "token" in event.args ? lower(event.args.token) : undefined;
      if (name === "TokenCeilingSet" && token) await context.db.insert(earnTokenInventory).values({ key: `${config.HybridVault}:${token}`, strategy: config.HybridVault, token }).onConflictDoNothing();
      if (!await readyForSnapshot(context, block, entry)) return;
      const stamp = { chainId: config.chainId, strategy: config.HybridVault, blockNumber: String(block), asOf: Number(asOf) };
      const notice = (kind: EarnNotice["kind"], account: EarnAddress, dealId: string | null, noticeToken: EarnAddress, amount: bigint) =>
        store.notice({ ...stamp, id: `${tx}:${event.log.logIndex}`, kind, account, dealId, token: noticeToken, amount: String(amount), transactionHash: tx });
      const accounts = new Set<EarnAddress>();
      if ("account" in event.args && lower(event.args.account) !== zero) accounts.add(lower(event.args.account));
      const position = earnEventPosition(block, event.log.logIndex);
      if ((name === "Deposited" || name === "Withdrawn" || name === "RequestServed") && "account" in event.args && "shares" in event.args) {
        const account = lower(event.args.account);
        const [previous] = await context.db.sql.select().from(earnShareChanges).where(and(eq(earnShareChanges.strategy, config.HybridVault), eq(earnShareChanges.account, account))).orderBy(desc(earnShareChanges.position)).limit(1);
        const balance = (previous?.balance ?? 0n) + (name === "Deposited" ? event.args.shares : -event.args.shares);
        if (balance < 0n) throw new Error("Earn share event ledger underflow");
        await context.db.insert(earnShareChanges).values({ key: `${config.HybridVault}:${position}`, strategy: config.HybridVault, account, position, balance });
      }
      if (name === "LoanOverdue" && "dealId" in event.args) {
        await context.db.insert(earnLoanSnapshots).values({ key: `${config.HybridVault}:${event.args.dealId}`, strategy: config.HybridVault, dealId: event.args.dealId, position });
      }
      if (name === "PocketClaimed" && "account" in event.args && "pocketId" in event.args) {
        const account = lower(event.args.account);
        await context.db.insert(earnPocketClaims).values({ key: `${config.HybridVault}:${account}:${event.args.pocketId}`, strategy: config.HybridVault, account, pocketId: String(event.args.pocketId), position });
      }
      // Entity rows first: the strategy snapshot derives token exposure, open requests and pockets from them.
      if (name === "Paused") for (const approval of await store.approvals(asOf)) {
        if (!approval.funded) await syncEarnApproval(config, read, store, BigInt(approval.dealId), block, asOf);
      }
      if ("dealId" in event.args) {
        const dealId = event.args.dealId;
        if (name === "LoanApproved" || name === "LoanRevoked" || name === "LoanFunded") await syncEarnApproval(config, read, store, dealId, block, asOf, name === "LoanRevoked");
        if (name === "PocketCreated" && "pocketId" in event.args) {
          const pocket = await syncEarnPocket(config, read, store, event.args.pocketId, block, asOf);
          const holderSnapshot = await context.db.find(earnLoanSnapshots, { key: `${config.HybridVault}:${dealId}` });
          if (!holderSnapshot) throw new Error("Earn pocket has no write-down ownership event");
          await store.savePocket({ ...pocket, snapshotPosition: String(holderSnapshot.position), createdPosition: String(position) });
        }
        const update = name === "Settled" && "payout" in event.args ? { payout: event.args.payout }
          : name === "ProfitReported" && "profit" in event.args && "fee" in event.args ? { profit: event.args.profit, fee: event.args.fee }
          : name === "LossReported" && "loss" in event.args ? { profit: -event.args.loss }
          : name === "PocketCreated" && "pocketId" in event.args ? { pocketId: event.args.pocketId }
          : name === "RewardsHarvested" && "amount" in event.args ? { rewards: event.args.amount } : undefined;
        const loan = name === "LoanApproved" || name === "LoanRevoked" || name === "CollateralRecovered" ? undefined : await syncEarnLoan(config, read, store, dealId, block, asOf, update);
        if (name === "LoanOverdue" && "principal" in event.args) await notice("overdue", config.HybridVault, String(dealId), config.USDG, event.args.principal);
        if (name === "Settled" && loan?.outcome) {
          const pockets = await Promise.all(loan.pocketIds.map(id => store.pocket(id)));
          for (const value of earnSettlementNotices(loan, pockets.filter((pocket): pocket is EarnPocketRecord => pocket !== undefined), config.USDG, { id: `${tx}:${event.log.logIndex}`, transactionHash: tx })) await store.notice(value);
        }
      }
      if ("requestId" in event.args) {
        const served = name === "RequestServed" && "shares" in event.args && "assets" in event.args ? { shares: event.args.shares, assets: event.args.assets } : undefined;
        await syncEarnRequest(config, read, store, event.args.requestId, block, asOf, { served, cancelled: name === "RequestCancelled" });
        if (served && "account" in event.args) await notice("served", lower(event.args.account), null, config.USDG, served.assets);
      }
      let accountFlow = earnFlowOf(name, args);
      if (name === "PocketClaimed" && "pocketId" in event.args) {
        const pocket = await syncEarnPocket(config, read, store, event.args.pocketId, block, asOf);
        accountFlow = earnFlowOf(name, { ...args, token: pocket.token }, config.USDG);
      }
      for (const account of accounts) await syncEarnAccount(config, read, store, account, block, asOf, "account" in event.args && account === lower(event.args.account) ? accountFlow : 0n);
      await publishEarnStrategy(context, entry, block, asOf, token);
    });
  }
}
