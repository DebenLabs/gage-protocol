/**
 * Read-only client for the indexer (docs/api.md). Every call has a timeout and throws on failure; the poller
 * treats a throw as "indexer down" and tries again next minute.
 */
import type { EarnAccount, EarnApproval, EarnKeeperHealth, EarnLoan, EarnNotice, EarnPage, EarnSnapshot, EarnStrategy } from "../../../shared/earn.js";

export interface EarnNotificationsSnapshot {
  approvals: EarnApproval[];
  loans: EarnLoan[];
  events: EarnNotice[];
  /** Holder discovery: strategy-wide outcomes fan out to subscribed holders of shares, served USDG or pocket entitlements. */
  accounts: EarnAccount[];
  keeper: EarnKeeperHealth;
}

export interface IndexedDeal {
  id: string;
  borrower: string;
  lender: string | null;
  kind: "ERC20" | "UNIV4_POSITION" | "UNIV3_POSITION";
  token: string;
  amountOrTokenId: string;
  cap: string;
  price: string;
  fee: string | null;
  term: number;
  fundedAt: number;
  expiry: number;
  graceEnd: number;
  state: string;
  lane: string;
}

/** Before funding, price and loan timestamps are null; listing alerts need only these fields. */
export interface IndexedListing {
  id: string;
  kind: "ERC20" | "UNIV4_POSITION" | "UNIV3_POSITION";
  token: string;
}

export interface IndexedEpoch {
  n: number;
  startsAt: number;
  endsAt: number;
  dealBudget7: string;
  dealBudget21: string;
  released: boolean;
}

export interface PoolResponse {
  epoch: IndexedEpoch | undefined;
  budgets: { dealsRemaining7: string; dealsRemaining21: string; liquidity: string } | undefined;
}

export interface IndexedAsset {
  token: string;
  symbol: string;
  decimals: number;
  uiMultiplier: string | null;
}

export interface Indexer {
  fundedDeals(): Promise<IndexedDeal[]>;
  listings(): Promise<IndexedListing[]>;
  /** Open V2 listings on the strategy's own engine: the curator's candidates. */
  earnListings(strategy: EarnStrategy): Promise<IndexedListing[]>;
  earnStrategies(): Promise<EarnStrategy[]>;
  earnNotifications(strategy: EarnStrategy): Promise<EarnNotificationsSnapshot>;
  pool(): Promise<PoolResponse>;
  epochs(): Promise<IndexedEpoch[]>;
  assets(): Promise<IndexedAsset[]>;
  health(): Promise<{ ok: boolean; chainId?: number }>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Lenient parse of a Deal; undefined when a field the notifier needs is missing. */
export function parseDeal(v: unknown): IndexedDeal | undefined {
  if (!isRec(v)) return undefined;
  const id = str(v.id);
  const borrower = str(v.borrower);
  const token = str(v.token);
  const amountOrTokenId = str(v.amountOrTokenId);
  const cap = str(v.cap);
  const price = str(v.price);
  const term = num(v.term);
  const fundedAt = num(v.fundedAt);
  const expiry = num(v.expiry);
  const graceEnd = num(v.graceEnd);
  const state = str(v.state);
  if (!id || !borrower || !token || !amountOrTokenId || !cap || !price || term === undefined || expiry === undefined || !state) {
    return undefined;
  }
  return {
    id,
    borrower,
    lender: str(v.lender) ?? null,
    kind: v.kind === "UNIV4_POSITION" || v.kind === "UNIV3_POSITION" ? v.kind : "ERC20",
    token,
    amountOrTokenId,
    cap,
    price,
    fee: str(v.fee) ?? null,
    term,
    fundedAt: fundedAt ?? expiry - term,
    expiry,
    graceEnd: graceEnd ?? expiry + 48 * 3_600,
    state,
    lane: str(v.lane) ?? "STOCK",
  };
}

export function parseEpoch(v: unknown): IndexedEpoch | undefined {
  if (!isRec(v)) return undefined;
  const n = num(v.n);
  const startsAt = num(v.startsAt);
  const endsAt = num(v.endsAt);
  if (n === undefined || startsAt === undefined || endsAt === undefined) return undefined;
  return { n, startsAt, endsAt, dealBudget7: str(v.dealBudget7) ?? "0", dealBudget21: str(v.dealBudget21) ?? "0", released: v.released === true };
}

export function parseAsset(v: unknown): IndexedAsset | undefined {
  if (!isRec(v)) return undefined;
  const token = str(v.token);
  const decimals = num(v.decimals);
  if (!token || decimals === undefined) return undefined;
  return { token, symbol: str(v.symbol) ?? token.slice(0, 8), decimals, uiMultiplier: str(v.uiMultiplier) ?? null };
}

export interface IndexerOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export function makeIndexer(o: IndexerOptions): Indexer {
  const base = o.baseUrl.replace(/\/$/, "");
  const timeoutMs = o.timeoutMs ?? 10_000;
  const fetchFn = o.fetchFn ?? fetch;

  const get = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`indexer ${path} returned ${res.status}`);
    return res.json();
  };

  const paged = async (path: string, params: Record<string, string>): Promise<unknown[]> => {
    const items: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const body = await get(path, cursor === undefined ? params : { ...params, cursor });
      if (!isRec(body) || !Array.isArray(body.items)) throw new Error(`indexer ${path}: no items array`);
      items.push(...(body.items as unknown[]));
      const next = body.nextCursor;
      if (next === null || next === undefined) return items;
      if (typeof next !== "string" || next === "" || cursors.has(next)) throw new Error(`indexer ${path}: invalid cursor`);
      cursors.add(next);
      cursor = next;
    }
  };

  const sameSnapshot = (row: EarnSnapshot, expected: EarnSnapshot): boolean =>
    row.chainId === expected.chainId && row.strategy === expected.strategy && row.blockNumber === expected.blockNumber && row.asOf === expected.asOf;
  const validSnapshot = (row: unknown): row is EarnSnapshot => isRec(row) && Number.isSafeInteger(row.chainId) && typeof row.strategy === "string" && /^0x[0-9a-f]{40}$/.test(row.strategy)
    && typeof row.blockNumber === "string" && /^\d+$/.test(row.blockNumber) && Number.isSafeInteger(row.asOf);
  /** The `/earn/strategies` listing carries the flagship's snapshot in its envelope while every item carries its own: only the chain is page-wide. */
  const earnPaged = async <T extends EarnSnapshot>(path: string, expected?: EarnSnapshot, listing = false): Promise<T[]> => {
    const items: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let snapshot = expected;
    for (;;) {
      const body = await get(path, { limit: "100", ...(snapshot ? { blockNumber: snapshot.blockNumber } : {}), ...(cursor ? { cursor } : {}) });
      if (!isRec(body) || !Array.isArray(body.items) || !validSnapshot(body)) throw new Error(`indexer ${path}: invalid Earn snapshot`);
      const result = body as unknown as EarnPage<T>;
      snapshot ??= result;
      if (!sameSnapshot(result, snapshot)) throw new Error(`indexer ${path}: Earn snapshot changed`);
      if (listing ? !result.items.every(item => validSnapshot(item) && item.chainId === result.chainId) : !result.items.every(item => isRec(item) && sameSnapshot(item, result))) throw new Error(`indexer ${path}: Earn snapshot changed`);
      items.push(...result.items);
      if (result.nextCursor === null) return items;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error(`indexer ${path}: invalid cursor`);
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  };

  return {
    fundedDeals: async () => {
      const items = await paged("/deals", { state: "FUNDED", limit: "200" });
      return items.map(parseDeal).filter((d): d is IndexedDeal => d !== undefined && d.state === "FUNDED");
    },
    listings: async () => {
      const items = await paged("/listings", { limit: "100" });
      return items.flatMap(item => {
        if (!isRec(item) || item.state !== "LISTED" || typeof item.token !== "string" || !str(item.id)
          || (item.kind !== "ERC20" && item.kind !== "UNIV4_POSITION" && item.kind !== "UNIV3_POSITION")) return [];
        return [{ id: str(item.id)!, kind: item.kind, token: item.token } satisfies IndexedListing];
      });
    },
    earnListings: async strategy => {
      const items = await paged("/v2/positions", { engine: strategy.core, state: "funding", limit: "100" });
      return items.flatMap(item => {
        if (!isRec(item) || !isRec(item.loan) || !str(item.id) || typeof item.loan.token !== "string" || item.loan.state !== 1) return [];
        const kind = item.loan.kind === 0 ? "ERC20" : item.loan.kind === 1 ? "UNIV4_POSITION" : item.loan.kind === 2 ? "UNIV3_POSITION" : undefined;
        if (!kind) return [];
        return [{ id: str(item.id)!, kind, token: item.loan.token } satisfies IndexedListing];
      });
    },
    earnStrategies: () => earnPaged<EarnStrategy>("/earn/strategies", undefined, true),
    earnNotifications: async strategy => {
      const prefix = `/earn/${strategy.address}`;
      const [approvals, loans, events, accounts, rawKeeper] = await Promise.all([
        earnPaged<EarnApproval>(`${prefix}/approvals`, strategy), earnPaged<EarnLoan>(`${prefix}/loans`, strategy),
        earnPaged<EarnNotice>(`${prefix}/events`, strategy), earnPaged<EarnAccount>(`${prefix}/accounts`, strategy), get(`${prefix}/keeper`),
      ]);
      if (!isRec(rawKeeper) || rawKeeper.chainId !== strategy.chainId || rawKeeper.strategy !== strategy.address || !Array.isArray(rawKeeper.alerts)
        || !rawKeeper.alerts.every(alert => isRec(alert) && alert.strategy === strategy.address && typeof alert.id === "string" && ["keeper_revert", "harvest_failed", "reserve_redemption_failed"].includes(String(alert.code)))) throw new Error(`indexer ${prefix}/keeper: invalid Earn identity or alerts`);
      return { approvals, loans, events, accounts, keeper: rawKeeper as unknown as EarnKeeperHealth };
    },
    pool: async () => {
      const body = await get("/pool");
      if (!isRec(body)) throw new Error("indexer /pool: not an object");
      const budgets = isRec(body.budgets)
        ? {
            dealsRemaining7: str(body.budgets.dealsRemaining7) ?? "0",
            dealsRemaining21: str(body.budgets.dealsRemaining21) ?? "0",
            liquidity: str(body.budgets.liquidity) ?? "0",
          }
        : undefined;
      return { epoch: parseEpoch(body.epoch), budgets };
    },
    epochs: async () => {
      const body = await get("/epochs");
      const list = isRec(body) && Array.isArray(body.epochs) ? body.epochs : [];
      return list.map(parseEpoch).filter((e): e is IndexedEpoch => e !== undefined);
    },
    assets: async () => {
      const body = await get("/assets");
      const list = isRec(body) && Array.isArray(body.assets) ? body.assets : [];
      return list.map(parseAsset).filter((a): a is IndexedAsset => a !== undefined);
    },
    health: async () => {
      const body = await get("/health/indexer");
      return { ok: isRec(body) && body.ok === true, ...(isRec(body) && typeof body.chainId === "number" ? { chainId: body.chainId } : {}) };
    },
  };
}
