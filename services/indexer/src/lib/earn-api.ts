import { Hono } from "hono";
import type { EarnAccount, EarnAddress, EarnApproval, EarnKeeperHealth, EarnLoan, EarnNotice, EarnPocket, EarnRequest, EarnReserveRate, EarnSnapshot, EarnStrategy } from "../../../../shared/earn";
import { earnLoanStateAt } from "./earn-sync";
import { projectEarnAccount, publicEarnAccount } from "./earn-account-state";

type EarnEntity = EarnAccount | EarnRequest | EarnLoan | EarnPocket | EarnApproval | EarnNotice;
export type EarnCollection = "accounts" | "requests" | "loans" | "pockets" | "approvals" | "events";
export interface EarnStoredRow { id: string; snapshot: EarnEntity }
export interface EarnStoredStrategy {
  snapshot: EarnStrategy;
  /** The strategy's exact share conversion at this snapshot: (totalAssets + 1) / (totalSupply + virtualShares). */
  shareAssetsNumerator: string;
  shareAssetsDenominator: string;
}
export interface EarnListQuery { strategy: EarnAddress; account?: EarnAddress; afterId?: string; limit: number; asOf: number; blockNumber: string; active?: boolean }
export interface EarnStore {
  strategy(address: EarnAddress, options?: { includePockets: boolean }): Promise<EarnStoredStrategy | undefined>;
  account(strategy: EarnAddress, account: EarnAddress): Promise<EarnAccount | undefined>;
  list(kind: EarnCollection, query: EarnListQuery): Promise<EarnStoredRow[]>;
}

/** Compact maintenance reads never invoke the historical-pocket loader. */
export async function withEarnStrategyPockets(current: EarnStoredStrategy, loadPockets: () => Promise<EarnPocket[]>, includePockets = true): Promise<EarnStoredStrategy> {
  return { ...current, snapshot: { ...current.snapshot, pockets: includePockets ? await loadPockets() : [] } };
}
export interface EarnApiStrategy { id: string; HybridVault: EarnAddress; HybridReserve: EarnAddress; EarnCore: EarnAddress }
export interface EarnApiDeployment {
  chainId: number;
  /** Every published strategy, the flagship first; empty when the deployment carries none. */
  strategies: readonly EarnApiStrategy[];
}
interface EarnApiOptions {
  deployment: EarnApiDeployment;
  store: EarnStore;
  keeperFetch?: (strategy: EarnAddress) => Promise<unknown>;
  /** The reserve's recent yearly rate for this snapshot (docs/api.md); omitted from responses when not configured, null when unavailable. */
  reserveRate?: (snapshot: EarnStrategy) => Promise<EarnReserveRate | null>;
  now?: () => number;
}
interface Cursor { v: 1; scope: string; blockNumber: string; asOf: number; id: string }
interface Query { limit: number; cursor?: Cursor; blockNumber?: string; account?: EarnAddress }

class EarnApiError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) { super(message); }
}
const unavailable = () => new EarnApiError(503, "EARN_UNAVAILABLE", "Earn information is temporarily unavailable.");
const changed = () => new EarnApiError(409, "SNAPSHOT_CHANGED", "Earn information has changed. Refresh before continuing.");
const badInput = (name: string) => new EarnApiError(400, "BAD_EARN_QUERY", `Invalid ${name}.`);
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as EarnAddress;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const address = (raw: string): EarnAddress => {
  if (!addressPattern.test(raw)) throw badInput("address");
  return raw.toLowerCase() as EarnAddress;
};
const record = (raw: unknown): raw is Record<string, unknown> => typeof raw === "object" && raw !== null && !Array.isArray(raw);
const safeInteger = (raw: unknown): raw is number => Number.isSafeInteger(raw) && Number(raw) >= 0;
const snapshotOf = (s: EarnSnapshot): EarnSnapshot => ({ chainId: s.chainId, strategy: s.strategy, blockNumber: s.blockNumber, asOf: s.asOf });
const scopeFor = (strategy: EarnAddress, kind: string, account?: EarnAddress) => `${strategy}/${kind}/${account ?? ""}`;

function parseQuery(raw: Record<string, string>, scope: string): Query {
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if ((raw.limit !== undefined && !decimalPattern.test(raw.limit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw badInput("limit");
  if (raw.blockNumber !== undefined && (!decimalPattern.test(raw.blockNumber) || raw.blockNumber.length > 78)) throw badInput("block number");
  const result: Query = { limit, ...(raw.blockNumber === undefined ? {} : { blockNumber: raw.blockNumber }) };
  if (raw.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(raw.cursor) || raw.cursor.length > 2048) throw badInput("cursor");
      const decoded = Buffer.from(raw.cursor, "base64url");
      if (decoded.toString("base64url") !== raw.cursor) throw badInput("cursor");
      const cursor: unknown = JSON.parse(decoded.toString("utf8"));
      if (!record(cursor) || cursor.v !== 1 || cursor.scope !== scope || typeof cursor.blockNumber !== "string" || !decimalPattern.test(cursor.blockNumber) || !safeInteger(cursor.asOf) || typeof cursor.id !== "string" || cursor.id.length < 1 || cursor.id.length > 512) throw badInput("cursor");
      result.cursor = cursor as unknown as Cursor;
    } catch { throw badInput("cursor"); }
  }
  return result;
}

function checkQuery(snapshot: EarnSnapshot, query: Query) {
  if (query.blockNumber !== undefined && query.blockNumber !== snapshot.blockNumber) throw changed();
  if (query.cursor !== undefined && (query.cursor.blockNumber !== snapshot.blockNumber || query.cursor.asOf !== snapshot.asOf)) throw changed();
}

/** Lane caps follow full assets (docs/api.md); the stored totals are exact at the snapshot block. */
function normalizeStrategy(snapshot: EarnStrategy): EarnStrategy {
  const assets = BigInt(snapshot.totals.fullAssets);
  return { ...snapshot, lanes: snapshot.lanes.map(lane => {
    const cap = assets * BigInt(lane.weightBps) / 10000n;
    const headroom = cap - BigInt(lane.principal);
    return { ...lane, cap: cap.toString(), headroom: (headroom > 0n ? headroom : 0n).toString() };
  }) };
}

/** Share value follows the latest strategy snapshot; the reserve and profit unlocking move the price between account events. */
function normalizeAccount(account: EarnAccount, current: EarnStoredStrategy): EarnAccount {
  return publicEarnAccount(projectEarnAccount(account, current));
}

/** A default can be finalized at expiry + GRACE itself (GageV2Vault.finalizeDefault), never one second earlier. */
export function earnLoanState(loan: EarnLoan, at: number): EarnLoan["state"] {
  return earnLoanStateAt(loan, at);
}

/** Core events can resolve the loan before the keeper calls Earn settlement. Only use data at this snapshot. */
export function mergeEarnCoreState(loan: EarnLoan, core: { state: string | null; settledBlock: bigint | null } | undefined, blockNumber: string): EarnLoan {
  if (!loan.settled && core?.settledBlock !== null && core?.settledBlock !== undefined && core.settledBlock <= BigInt(blockNumber) && (core.state === "REPAID" || core.state === "DEFAULTED" || core.state === "CANCELLED")) return { ...loan, coreState: core.state };
  return loan;
}

function checkRow(row: EarnSnapshot, snapshot: EarnSnapshot) {
  if (row.strategy !== snapshot.strategy || row.chainId !== snapshot.chainId) throw unavailable();
  if (BigInt(row.blockNumber) > BigInt(snapshot.blockNumber) || row.asOf > snapshot.asOf) throw changed();
}

function missingAccount(who: EarnAddress, snapshot: EarnSnapshot): EarnAccount {
  return { ...snapshotOf(snapshot), account: who, shares: "0", lockedShares: "0", freeShares: "0", value: "0", withdrawable: "0", claimable: "0", rewards: "0", requests: [], pockets: [], collateralReceived: [] };
}

function keeperHealth(raw: unknown, deployment: EarnApiDeployment, strategy: EarnAddress, now: number): EarnKeeperHealth | undefined {
  if (!record(raw) || typeof raw.ok !== "boolean" || raw.chainId !== deployment.chainId || raw.strategy !== strategy || !["dry-run", "execute", "disabled"].includes(String(raw.mode)) || !(raw.lastTickAt === null || safeInteger(raw.lastTickAt)) || !safeInteger(raw.staleAfterSeconds) || raw.staleAfterSeconds < 1 || raw.staleAfterSeconds > 86400 || !(raw.pendingTransaction === null || (typeof raw.pendingTransaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw.pendingTransaction))) || !Array.isArray(raw.failures) || !Array.isArray(raw.alerts)) return undefined;
  if (!raw.failures.every(f => record(f) && typeof f.action === "string" && safeInteger(f.attempts) && safeInteger(f.retryAt))) return undefined;
  if (!raw.alerts.every(a => record(a) && typeof a.id === "string" && ["keeper_revert", "harvest_failed", "reserve_redemption_failed"].includes(String(a.code)) && typeof a.action === "string" && a.strategy === strategy && safeInteger(a.at) && safeInteger(a.attempts))) return undefined;
  const health = raw as unknown as EarnKeeperHealth;
  return { ok: health.ok && health.lastTickAt !== null && health.lastTickAt <= now + 30 && now - health.lastTickAt <= health.staleAfterSeconds, chainId: health.chainId, strategy, mode: health.mode, lastTickAt: health.lastTickAt, staleAfterSeconds: health.staleAfterSeconds, pendingTransaction: health.pendingTransaction, failures: health.failures.map(f => ({ action: f.action, attempts: f.attempts, retryAt: f.retryAt })), alerts: health.alerts.map(a => ({ id: a.id, code: a.code, action: a.action, strategy, at: a.at, attempts: a.attempts })) };
}

/** Hono routes depend only on an indexed store. No route performs an RPC read per account or request. */
export function createEarnApi({ deployment, store, keeperFetch, reserveRate, now = () => Math.floor(Date.now() / 1000) }: EarnApiOptions) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, c) => {
    const safe = error instanceof EarnApiError ? error : unavailable();
    return c.json({ error: { code: safe.code, message: safe.message } }, safe.status);
  });

  const published = (strategy: EarnAddress) => deployment.strategies.find(item => item.HybridVault === strategy);
  const configured = (raw: string): EarnAddress => {
    const requested = address(raw);
    if (!published(requested)) throw new EarnApiError(404, "EARN_NOT_DEPLOYED", "This Earn strategy is not available.");
    return requested;
  };
  const load = async (strategy: EarnAddress, includePockets = true): Promise<EarnStoredStrategy> => {
    const current = await store.strategy(strategy, { includePockets });
    const expected = published(strategy);
    if (!current || !expected || current.snapshot.chainId !== deployment.chainId || current.snapshot.strategy !== strategy || current.snapshot.address !== strategy || current.snapshot.reserve !== expected.HybridReserve || current.snapshot.core !== expected.EarnCore || !decimalPattern.test(current.snapshot.blockNumber) || !safeInteger(current.snapshot.asOf)) throw unavailable();
    return structuredClone(current);
  };
  /** The published strategy: normalized lanes plus the reserve rate sample, which never fails the response. */
  const publish = async (snapshot: EarnStrategy): Promise<EarnStrategy> => {
    const normalized = normalizeStrategy(snapshot);
    if (!reserveRate) return normalized;
    return { ...normalized, reserveRate: await reserveRate(normalized).catch(() => null) };
  };
  const stable = async (before: EarnStoredStrategy) => {
    const after = await load(before.snapshot.strategy, false);
    if (after.snapshot.blockNumber !== before.snapshot.blockNumber || after.snapshot.asOf !== before.snapshot.asOf) throw changed();
  };

  app.get("/strategies", async c => {
    const raw = c.req.query();
    const flagship = deployment.strategies[0]?.HybridVault ?? ZERO_ADDRESS;
    const query = parseQuery(raw, scopeFor(flagship, "strategies"));
    if (raw.account !== undefined) address(raw.account);
    if (!deployment.strategies.length) {
      const snapshot = { chainId: deployment.chainId, strategy: ZERO_ADDRESS, blockNumber: "0", asOf: 0 };
      checkQuery(snapshot, query);
      return c.json({ ...snapshot, items: [], nextCursor: null });
    }
    // The envelope is the flagship's snapshot; every item carries its own. Pages walk the vaults by address.
    const current = await load(flagship);
    checkQuery(current.snapshot, query);
    const ordered = [...deployment.strategies].map(item => item.HybridVault).sort();
    const remaining = ordered.filter(vault => !query.cursor || vault > query.cursor.id);
    const visible = remaining.slice(0, query.limit);
    const items = await Promise.all(visible.map(async vault => publish((vault === flagship ? current : await load(vault)).snapshot)));
    const last = visible.at(-1);
    const nextCursor = remaining.length > query.limit && last ? Buffer.from(JSON.stringify({ v: 1, scope: scopeFor(flagship, "strategies"), blockNumber: current.snapshot.blockNumber, asOf: current.snapshot.asOf, id: last } satisfies Cursor)).toString("base64url") : null;
    await stable(current);
    return c.json({ ...snapshotOf(current.snapshot), items, nextCursor });
  });

  app.get("/:strategy", async c => {
    const selected = configured(c.req.param("strategy"));
    const raw = c.req.query();
    if (raw.includePockets !== undefined && raw.includePockets !== "true" && raw.includePockets !== "false") throw badInput("includePockets");
    const query = parseQuery(raw, scopeFor(selected, "strategy"));
    const current = await load(selected, raw.includePockets !== "false");
    checkQuery(current.snapshot, query);
    return c.json(await publish(current.snapshot));
  });

  app.get("/:strategy/accounts/:account", async c => {
    const selected = configured(c.req.param("strategy"));
    const who = address(c.req.param("account"));
    const query = parseQuery(c.req.query(), scopeFor(selected, "account", who));
    const current = await load(selected, false);
    checkQuery(current.snapshot, query);
    const found = await store.account(selected, who);
    if (found && (found.account !== who || found.strategy !== selected || found.chainId !== deployment.chainId)) throw unavailable();
    if (found) checkRow(found, current.snapshot);
    const result = normalizeAccount(found ?? missingAccount(who, current.snapshot), current);
    await stable(current);
    return c.json(result);
  });

  for (const kind of ["accounts", "requests", "loans", "pockets", "approvals", "events"] as const) app.get(`/:strategy/${kind}`, async c => {
    const selected = configured(c.req.param("strategy"));
    const raw = c.req.query();
    const who = raw.account === undefined ? undefined : address(raw.account);
    if (raw.active !== undefined && (kind !== "approvals" || raw.active !== "true")) throw badInput("active filter");
    const active = raw.active === "true";
    const scope = scopeFor(selected, kind, who) + (active ? "/active" : "");
    const query = parseQuery(raw, scope);
    const current = await load(selected, false);
    checkQuery(current.snapshot, query);
    const rows = await store.list(kind, { strategy: selected, account: who, afterId: query.cursor?.id, limit: query.limit + 1, asOf: current.snapshot.asOf, blockNumber: current.snapshot.blockNumber, ...(active ? { active: true } : {}) });
    const visible = rows.slice(0, query.limit);
    const items = visible.map(({ snapshot }) => {
      checkRow(snapshot, current.snapshot);
      if (kind === "accounts") return normalizeAccount(snapshot as EarnAccount, current);
      const stamped = { ...snapshot, ...snapshotOf(current.snapshot) };
      if (kind === "loans") return { ...stamped, state: earnLoanState(stamped as EarnLoan, current.snapshot.asOf) };
      return stamped;
    });
    const last = visible.at(-1);
    const nextCursor = rows.length > query.limit && last ? Buffer.from(JSON.stringify({ v: 1, scope, blockNumber: current.snapshot.blockNumber, asOf: current.snapshot.asOf, id: last.id } satisfies Cursor)).toString("base64url") : null;
    await stable(current);
    return c.json({ ...snapshotOf(current.snapshot), items, nextCursor });
  });

  app.get("/:strategy/keeper", async c => {
    const selected = configured(c.req.param("strategy"));
    try {
      const health = keeperFetch && keeperHealth(await keeperFetch(selected), deployment, selected, now());
      if (health) return c.json(health);
    } catch { /* An offline worker leaves the manual recovery controls available. */ }
    return c.json({ ok: false, chainId: deployment.chainId, strategy: selected, mode: "disabled", lastTickAt: null, staleAfterSeconds: 120, pendingTransaction: null, failures: [], alerts: [] } satisfies EarnKeeperHealth);
  });
  return app;
}

export async function earnIndexerHealth(store: EarnStore, deployment: EarnApiDeployment) {
  if (!deployment.strategies.length) return null;
  const strategies = await Promise.all(deployment.strategies.map(async item => {
    const contracts = { HybridVault: item.HybridVault, HybridReserve: item.HybridReserve, EarnCore: item.EarnCore };
    let current: EarnStoredStrategy | undefined;
    try { current = await store.strategy(item.HybridVault, { includePockets: false }); } catch { /* Report configured contracts while indexing catches up. */ }
    if (!current || current.snapshot.chainId !== deployment.chainId || current.snapshot.strategy !== item.HybridVault) return { id: item.id, contracts, indexedBlock: null, asOf: null };
    return { id: item.id, contracts, indexedBlock: current.snapshot.blockNumber, asOf: current.snapshot.asOf };
  }));
  const flagship = strategies[0]!;
  return { contracts: flagship.contracts, indexedBlock: flagship.indexedBlock, asOf: flagship.asOf, strategies };
}
