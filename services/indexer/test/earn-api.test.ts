import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnAccount, EarnApproval, EarnKeeperHealth, EarnLoan, EarnNotice, EarnPocket, EarnRequest, EarnStrategy } from "../../../shared/earn";
import { createEarnApi, earnIndexerHealth, mergeEarnCoreState, withEarnStrategyPockets, type EarnApiDeployment, type EarnStore, type EarnStoredRow, type EarnStoredStrategy } from "../src/lib/earn-api";

const STRATEGY = "0x00000000000000000000000000000000000000aa";
const ACCOUNT = "0x00000000000000000000000000000000000000bb";
const TOKEN = "0x00000000000000000000000000000000000000cc";
const RESERVE = "0x00000000000000000000000000000000000000dd";
const CORE = "0x00000000000000000000000000000000000000ee";
const OTHER = "0x00000000000000000000000000000000000000ff";
const SNAPSHOT = { chainId: 4663, strategy: STRATEGY, blockNumber: "100", asOf: 1000 } as const;
const STOCKS = "0x00000000000000000000000000000000000000bb";
const CONTRACTS = { HybridVault: STRATEGY, HybridReserve: RESERVE, EarnCore: CORE } as const;
const DEPLOYMENT = { chainId: 4663, strategies: [{ id: "earn", ...CONTRACTS }] } as const;
const pocket: EarnPocket = { ...SNAPSHOT, id: "1", dealId: "2", token: TOKEN, amount: "1000", supply: "2000000000000", claimed: "0", openedAt: 900 };
const strategy: EarnStrategy = {
  ...SNAPSHOT, id: "earn", title: "Gage USDG Mix", address: STRATEGY, core: CORE, coreRewards: OTHER, registry: OTHER, reserveAsset: TOKEN, reserveSymbol: "Reserve", rewardToken: { address: OTHER, symbol: "sGAGE", decimals: 18 }, reserve: RESERVE, curator: OTHER, usdg: TOKEN,
  usdgDecimals: 6, reserveDecimals: 18, shareDecimals: 18, paused: false, feeBps: 1000, fees: OTHER, feeRecipient: OTHER, protocolShareBps: 2500, protocolRecipient: OTHER, feeAccrued: "5", curatorAccrued: "0", protocolAccrued: "0", highWaterPrice: "0", grace: 200,
  mandate: { minDeposit: "1", maxTotalDeposits: "10000", maxLoanTerm: 1814400, minReturnBps: 100, maxGageExposureBps: 8000 },
  lanes: [{ lane: "STOCK", weightBps: 6000, principal: "90", cap: "0", headroom: "0" }, { lane: "MEME", weightBps: 4000, principal: "80", cap: "0", headroom: "0" }],
  tokens: [{ token: TOKEN, symbol: "NVDA", decimals: 18, unit: "1000000000000000000", lane: "STOCK", ceiling: "100", allowed: true, uiMultiplier: "1", principal: "170" }],
  shares: { totalSupply: "2000000000000", virtualShares: "1000000000000", price: "63333", fullPrice: "67000" },
  totals: { cash: "10", reserveShares: "1000000000000", reserveAssets: "20", performingPrincipal: "170", overduePrincipal: "0", fullAssets: "200", totalAssets: "189", lockedProfit: "20", unlockStart: 900, unlockEnd: 1500, profitUnlockSeconds: 604800,
    freeLiquidity: "30", pendingShares: "0", pendingRequestAssets: "0", openRequests: 1, claimableTotal: "0", harvestedCash: "0", assignedCash: "0", accRewardPerShare: "0", rewardRemainder: "0" },
  pockets: [pocket],
};
const request = (id: string, patch: Partial<EarnRequest> = {}): EarnRequest => ({ ...SNAPSHOT, id, account: ACCOUNT, shares: "5", servedShares: "0", servedAssets: "0", status: "pending", position: Number(id), requestedAt: 950, ...patch });
const account: EarnAccount = { ...SNAPSHOT, account: ACCOUNT, shares: "1000000000001", lockedShares: "5", freeShares: "999999999996", value: "0", withdrawable: "30", claimable: "4", rewards: "3", requests: [request("1")], pockets: [{ pocketId: "1", dealId: "2", token: TOKEN, claimable: "8", claimed: false, balanceAt: "16" }], collateralReceived: [{ token: TOKEN, amount: "8" }] };
const loan: EarnLoan = { ...SNAPSHOT, id: "1", dealId: "1", borrower: OTHER, token: TOKEN, lane: "STOCK", kind: "ERC20", principal: "100", cap: "105", collateralAmount: "1", positionPrincipal: "100", units: 4, slots: 15, withdrawn: false, overdue: false, carried: "100", state: "Active", coreState: "ACTIVE", fundingDeadline: 450, fundedAt: 500, expiry: 900, claimableAt: 1100, settled: false, outcome: null, payout: "0", profit: "0", fee: "0", feeBps: 1000, pocketId: null, pocketIds: [], rewards: "0" };
const approval: EarnApproval = { ...SNAPSHOT, dealId: "1", token: TOKEN, lane: "STOCK", kind: "ERC20", principal: "100", units: 4, validUntil: 1200, funded: false, revoked: false };
const notice: EarnNotice = { ...SNAPSHOT, id: "event-1", kind: "repayment", account: STRATEGY, dealId: "1", token: TOKEN, amount: "1045", transactionHash: `0x${"1".repeat(64)}` };
const keeper: EarnKeeperHealth = { ok: true, chainId: 4663, strategy: STRATEGY, mode: "execute", lastTickAt: 990, staleAfterSeconds: 120, pendingTransaction: null, failures: [], alerts: [] };

let stored: EarnStoredStrategy;
let rows: Record<string, EarnStoredRow[]>;
let store: EarnStore;
let keeperFetch: ReturnType<typeof vi.fn>;
const api = (deployment: EarnApiDeployment = DEPLOYMENT) => createEarnApi({ deployment, store, keeperFetch, now: () => 1000 });
const json = async (path: string) => { const response = await api().request(path); return { status: response.status, body: await response.json() }; };

beforeEach(() => {
  stored = { snapshot: structuredClone(strategy), shareAssetsNumerator: "190", shareAssetsDenominator: "3000000000000" };
  rows = { accounts: [{ id: ACCOUNT, snapshot: structuredClone(account) }], requests: ["1", "2", "3"].map(id => ({ id, snapshot: request(id) })), loans: [{ id: "1", snapshot: structuredClone(loan) }], pockets: [{ id: "1", snapshot: structuredClone(pocket) }], approvals: [{ id: "1", snapshot: structuredClone(approval) }], events: [{ id: "event-1", snapshot: structuredClone(notice) }] };
  store = {
    strategy: vi.fn(async () => stored),
    account: vi.fn(async () => rows.accounts![0]?.snapshot as EarnAccount | undefined),
    list: vi.fn(async (kind, query) => (rows[kind] ?? []).filter(row => (!query.afterId || row.id > query.afterId) && (!query.account || (row.snapshot as EarnAccount).account === query.account) && (!query.active || (!(row.snapshot as EarnApproval).funded && !(row.snapshot as EarnApproval).revoked && (row.snapshot as EarnApproval).validUntil >= query.asOf))).slice(0, query.limit)),
  };
  keeperFetch = vi.fn(async () => keeper);
});

describe("Earn reserve rate publication", () => {
  const sample = { yearlyBps: 412, windowSeconds: 604800, fromBlock: "1", toBlock: "100" };
  it("attaches the sampler's result to the strategy responses and omits the field when no sampler is configured", async () => {
    const reserveRate = vi.fn(async () => sample);
    const withRate = createEarnApi({ deployment: DEPLOYMENT, store, keeperFetch, reserveRate, now: () => 1000 });
    const one = await (await withRate.request(`/${STRATEGY}`)).json();
    expect(one.reserveRate).toEqual(sample);
    expect(reserveRate).toHaveBeenLastCalledWith(expect.objectContaining({ strategy: STRATEGY, blockNumber: "100" }));
    const list = await (await withRate.request("/strategies")).json();
    expect(list.items[0].reserveRate).toEqual(sample);
    expect("reserveRate" in (await json(`/${STRATEGY}`)).body).toBe(false);
  });
  it("publishes null, never an error, when the sampler fails", async () => {
    const failing = createEarnApi({ deployment: DEPLOYMENT, store, keeperFetch, reserveRate: async () => { throw new Error("no archive"); }, now: () => 1000 });
    const response = await failing.request(`/${STRATEGY}`);
    expect(response.status).toBe(200);
    expect((await response.json()).reserveRate).toBeNull();
  });
});

describe("Earn indexed HTTP API", () => {
  it("serves compact strategies without loading pockets while preserving the default frontend response", async () => {
    const loadPockets = vi.fn(async () => stored.snapshot.pockets);
    vi.mocked(store.strategy).mockImplementation(async (_address, options) => withEarnStrategyPockets(stored, loadPockets, options?.includePockets ?? true));
    const compact = await json(`/${STRATEGY}?includePockets=false&blockNumber=100`);
    expect(compact.status).toBe(200);
    expect(compact.body).toMatchObject({ ...SNAPSHOT, pockets: [], shares: strategy.shares, totals: strategy.totals });
    expect(loadPockets).not.toHaveBeenCalled();
    expect(store.strategy).toHaveBeenLastCalledWith(STRATEGY, { includePockets: false });
    expect((await json(`/${STRATEGY}`)).body.pockets).toEqual([pocket]);
    expect((await json(`/${STRATEGY}?includePockets=true`)).body.pockets).toEqual([pocket]);
    expect(loadPockets).toHaveBeenCalledTimes(2);
    expect(stored.snapshot.pockets).toEqual([pocket]);
    expect((await json(`/${STRATEGY}?includePockets=false&blockNumber=99`)).status).toBe(409);
    expect((await json(`/${STRATEGY}?includePockets=0`)).status).toBe(400);
  });

  it("keeps keeper collection pagination independent of the full pocket inventory", async () => {
    const loadPockets = vi.fn(async () => { throw Error("Historical pockets must not be loaded for maintenance pages"); });
    vi.mocked(store.strategy).mockImplementation(async (_address, options) => withEarnStrategyPockets(stored, loadPockets, options?.includePockets ?? true));
    for (const path of ["loans", "approvals?active=true"]) expect((await json(`/${STRATEGY}/${path}`)).status).toBe(200);
    expect(loadPockets).not.toHaveBeenCalled();
    for (const call of vi.mocked(store.strategy).mock.calls) expect(call[1]).toEqual({ includePockets: false });
  });

  it("does no historical-pocket work for a compact response even with a large legacy snapshot", async () => {
    const large = { ...stored, snapshot: { ...stored.snapshot, pockets: Array.from({ length: 10000 }, (_, id) => ({ ...pocket, id: String(id + 1) })) } };
    const loadPockets = vi.fn(async () => large.snapshot.pockets);
    const compact = await withEarnStrategyPockets(large, loadPockets, false);
    expect(compact.snapshot.pockets).toEqual([]);
    expect(loadPockets).not.toHaveBeenCalled();
    expect(large.snapshot.pockets).toHaveLength(10000);
  });

  it("does not label stale passive account rewards or performance as current", async () => {
    stored.snapshot.blockNumber = "101"; stored.snapshot.asOf = 1001;
    for (const suffix of [`accounts/${ACCOUNT}`, "accounts"]) {
      expect(await json(`/${STRATEGY}/${suffix}`)).toMatchObject({ status: 503, body: { error: { code: "EARN_UNAVAILABLE" } } });
    }
  });

  it("caps account withdrawable at the actual positive reserve withdrawal limit", async () => {
    stored.snapshot.totals.freeLiquidity = "15";
    expect((await json(`/${STRATEGY}/accounts/${ACCOUNT}`)).body.withdrawable).toBe("15");
  });

  it("serves the deployed strategy, immutable mandate and cap headroom on full assets", async () => {
    const list = await json("/strategies");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ ...SNAPSHOT, nextCursor: null, items: [{ address: STRATEGY, feeBps: 1000, shares: { price: "63333" }, pockets: [pocket], lanes: [{ cap: "120", headroom: "30" }, { cap: "80", headroom: "0" }] }] });
    expect((await json(`/${STRATEGY}`)).body).toEqual(list.body.items[0]);
    stored.snapshot.lanes[0]!.principal = "150";
    expect((await json(`/${STRATEGY}`)).body.lanes[0].headroom).toBe("0");
  });

  it("serves every collection, canonical raw amounts, and the share value at the latest snapshot price", async () => {
    for (const path of ["accounts", `accounts/${ACCOUNT}`, "requests", "loans", "pockets", "approvals", "events", "keeper"]) expect((await json(`/${STRATEGY}/${path}`)).status).toBe(200);
    const single = await json(`/${STRATEGY}/accounts/${ACCOUNT}`);
    // 1000000000001 shares × 190 / 3000000000000, floored: the stored zero is replaced.
    expect(single.body).toMatchObject({ ...SNAPSHOT, shares: "1000000000001", value: "63", withdrawable: "30", claimable: "4", rewards: "3", requests: [request("1")], pockets: [{ pocketId: "1", claimable: "8" }], collateralReceived: [{ token: TOKEN, amount: "8" }] });
    expect((await json(`/${STRATEGY}/accounts`)).body.items[0]).toEqual(single.body);
    expect((await json(`/${STRATEGY}/events`)).body.items).toEqual([notice]);
    expect((await json(`/${STRATEGY}/approvals`)).body.items).toEqual([approval]);
    expect((await json(`/${STRATEGY}/pockets`)).body.items).toEqual([pocket]);
    expect((await json(`/${STRATEGY}/loans`)).body.items[0]).not.toHaveProperty("account");
  });

  it("returns zero balances at the same snapshot for an account with no activity", async () => {
    vi.mocked(store.account).mockResolvedValue(undefined);
    expect((await json(`/${STRATEGY}/accounts/${OTHER}`)).body).toEqual({ ...SNAPSHOT, account: OTHER, shares: "0", lockedShares: "0", freeShares: "0", value: "0", withdrawable: "0", claimable: "0", rewards: "0", requests: [], pockets: [], collateralReceived: [] });
  });

  it("paginates every indexed collection by stable ID, without skipping the lookahead row", async () => {
    const first = await json(`/${STRATEGY}/requests?limit=2&account=${ACCOUNT}`);
    expect(first.body.items.map((v: EarnRequest) => v.id)).toEqual(["1", "2"]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await json(`/${STRATEGY}/requests?limit=2&account=${ACCOUNT}&cursor=${first.body.nextCursor}&blockNumber=100`);
    expect(second.body.items.map((v: EarnRequest) => v.id)).toEqual(["3"]);
    expect(second.body.nextCursor).toBeNull();
    expect(store.list).toHaveBeenLastCalledWith("requests", expect.objectContaining({ afterId: "2", account: ACCOUNT, limit: 3 }));
  });

  it("rejects stale blocks and cursors, including changes while a page is read", async () => {
    expect((await json(`/${STRATEGY}/requests?blockNumber=99`)).status).toBe(409);
    const first = await json(`/${STRATEGY}/requests?limit=1`);
    stored.snapshot.blockNumber = "101";
    expect((await json(`/${STRATEGY}/requests?cursor=${first.body.nextCursor}`))).toMatchObject({ status: 409, body: { error: { code: "SNAPSHOT_CHANGED" } } });
    vi.mocked(store.list).mockImplementationOnce(async () => { stored.snapshot.blockNumber = "102"; return []; });
    expect((await json(`/${STRATEGY}/requests`)).status).toBe(409);
  });

  it("rejects cursors reused across endpoint or account filters", async () => {
    const first = await json(`/${STRATEGY}/requests?limit=1&account=${ACCOUNT}`);
    for (const path of [`loans?account=${ACCOUNT}`, `requests?account=${OTHER}`, "requests?"]) {
      expect((await json(`/${STRATEGY}/${path}&cursor=${first.body.nextCursor}`)).status).toBe(400);
    }
  });

  it("pages only live approvals without including historical rows and scopes cursors to that filter", async () => {
    rows.approvals = Array.from({ length: 10000 }, (_, i) => ({ id: String(i + 1), snapshot: { ...approval, dealId: String(i + 1), validUntil: 999, funded: i % 2 === 0, revoked: i % 3 === 0 } }));
    rows.approvals.push(...["10001", "10002"].map((id, index) => ({ id, snapshot: { ...approval, dealId: id, validUntil: 1000 + index, funded: false, revoked: false } })));
    const first = await json(`/${STRATEGY}/approvals?active=true&limit=1`);
    expect(first.body.items.map((row: EarnApproval) => row.dealId)).toEqual(["10001"]);
    expect(store.list).toHaveBeenLastCalledWith("approvals", expect.objectContaining({ active: true, asOf: 1000, limit: 2 }));
    const second = await json(`/${STRATEGY}/approvals?active=true&limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((row: EarnApproval) => row.dealId)).toEqual(["10002"]);
    expect(second.body.nextCursor).toBeNull();
    expect((await json(`/${STRATEGY}/approvals?cursor=${first.body.nextCursor}`)).status).toBe(400);
    expect((await json(`/${STRATEGY}/requests?active=true`)).status).toBe(400);
    expect((await json(`/${STRATEGY}/approvals?active=false`)).status).toBe(400);
  });

  it.each([[999, false], [1000, true], [1001, true]])("reports approval validity at the current snapshot including its final second (%s)", async (validUntil, included) => {
    rows.approvals = [{ id: "1", snapshot: { ...approval, validUntil: Number(validUntil), funded: false, revoked: false } }];
    const response = await json(`/${STRATEGY}/approvals?active=true&blockNumber=100`);
    expect(response.status).toBe(200);
    expect(response.body.asOf).toBe(1000);
    expect(response.body.items).toHaveLength(included ? 1 : 0);
  });

  it.each(["limit=0", "limit=101", "limit=2.5", "limit=-1", "limit=x", "limit=", "cursor=%%", "cursor=e30", "blockNumber=-1", "blockNumber=x", "account=broken"])("rejects malformed pagination/filter input %s", async query => {
    expect((await json(`/${STRATEGY}/requests?${query}`)).status).toBe(400);
  });

  it("rejects malformed addresses and normalizes valid mixed-case addresses", async () => {
    expect((await json("/bad-address")).status).toBe(400);
    expect((await json(`/${STRATEGY}/accounts/nope`)).status).toBe(400);
    expect((await json(`/${STRATEGY.toUpperCase().replace("0X", "0x")}`)).status).toBe(200);
  });

  it("never exposes undeployed strategies or historical rows from another deployment", async () => {
    const disabled = createEarnApi({ deployment: { chainId: 4663, strategies: [] }, store });
    expect(await (await disabled.request("/strategies")).json()).toMatchObject({ items: [], nextCursor: null, blockNumber: "0", asOf: 0 });
    expect((await disabled.request(`/${STRATEGY}`)).status).toBe(404);
    expect((await json(`/${OTHER}`))).toMatchObject({ status: 404, body: { error: { code: "EARN_NOT_DEPLOYED" } } });
    stored.snapshot.chainId = 46630;
    expect((await json(`/${STRATEGY}`))).toMatchObject({ status: 503, body: { error: { code: "EARN_UNAVAILABLE" } } });
    stored.snapshot.chainId = 4663; stored.snapshot.core = OTHER;
    expect((await json(`/${STRATEGY}`))).toMatchObject({ status: 503, body: { error: { code: "EARN_UNAVAILABLE" } } });
  });

  it("maps missing snapshots and failed reads to safe 503 responses", async () => {
    vi.mocked(store.strategy).mockResolvedValueOnce(undefined);
    expect((await json(`/${STRATEGY}`)).status).toBe(503);
    vi.mocked(store.list).mockRejectedValueOnce(new Error("postgres://private-credential"));
    const result = await json(`/${STRATEGY}/requests`);
    expect(result).toMatchObject({ status: 503, body: { error: { code: "EARN_UNAVAILABLE" } } });
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it.each([
    [899, "ACTIVE", false, null, "Active"], [900, "ACTIVE", false, null, "Overdue"],
    [1100, "ACTIVE", false, null, "Claimable"], [1101, "ACTIVE", false, null, "Claimable"],
    [1000, "REPAID", false, null, "Settling"], [1101, "DEFAULTED", false, null, "Settling"],
    [449, "FUNDING", false, null, "Funding"], [450, "FUNDING", false, null, "Settling"], [1000, "CANCELLED", false, null, "Settling"],
    [1000, "REPAID", true, "cash", "Repaid"], [1101, "DEFAULTED", true, "collateral", "Collateral"], [1000, "CANCELLED", true, "refund", "Refunded"],
  ] as const)("maps loan state at indexed second %s, core %s, settled %s", async (asOf, coreState, settled, outcome, state) => {
    stored.snapshot.asOf = asOf;
    rows.loans = [{ id: "1", snapshot: { ...loan, asOf, coreState, settled, outcome } }];
    expect((await json(`/${STRATEGY}/loans`)).body.items[0]).toMatchObject({ asOf, coreState, state, settled, outcome });
  });

  it("marks a released commitment as settling until Earn refunds it", async () => {
    rows.loans = [{ id: "1", snapshot: { ...loan, coreState: "FUNDING", withdrawn: true } }];
    expect((await json(`/${STRATEGY}/loans`)).body.items[0]).toMatchObject({ state: "Settling" });
  });

  it("keeps the settlement payout, booked profit, fee and pocket after settlement", async () => {
    rows.loans = [{ id: "1", snapshot: { ...loan, coreState: "REPAID", settled: true, outcome: "cash", carried: "0", payout: "105", profit: "5", fee: "1" } }, { id: "2", snapshot: { ...loan, id: "2", dealId: "2", coreState: "DEFAULTED", overdue: true, settled: true, outcome: "collateral", carried: "0", profit: "-100", pocketId: "1" } }];
    const items = (await json(`/${STRATEGY}/loans`)).body.items;
    expect(items[0]).toMatchObject({ payout: "105", profit: "5", fee: "1", carried: "0" });
    expect(items[1]).toMatchObject({ state: "Collateral", profit: "-100", pocketId: "1", overdue: true });
  });

  it("rejects a loan row from a different strategy or a newer indexed block", async () => {
    rows.loans = [{ id: "1", snapshot: { ...loan, strategy: OTHER } }];
    expect((await json(`/${STRATEGY}/loans`)).status).toBe(503);
    rows.loans = [{ id: "1", snapshot: { ...loan, blockNumber: "101" } }];
    expect((await json(`/${STRATEGY}/loans`)).status).toBe(409);
  });

  it("includes core settlement at the selected block, excluding a later block in the same second", () => {
    expect(mergeEarnCoreState(loan, { state: "REPAID", settledBlock: 100n }, "100").coreState).toBe("REPAID");
    expect(mergeEarnCoreState(loan, { state: "DEFAULTED", settledBlock: 101n }, "100").coreState).toBe("ACTIVE");
    expect(mergeEarnCoreState(loan, { state: "ACTIVE", settledBlock: null }, "100")).toEqual(loan);
    expect(mergeEarnCoreState(loan, undefined, "100")).toEqual(loan);
  });

  it("stamps unchanged event-derived request rows but requires a refreshed account snapshot", async () => {
    stored.snapshot.blockNumber = "123";
    stored.snapshot.asOf = 1050;
    expect((await json(`/${STRATEGY}/requests`)).body.items[0]).toMatchObject({ blockNumber: "123", asOf: 1050 });
    expect((await json(`/${STRATEGY}/accounts/${ACCOUNT}`)).status).toBe(503);
  });

  it("reports configured Earn contracts and snapshot through indexer health", async () => {
    expect(await earnIndexerHealth(store, DEPLOYMENT)).toEqual({ contracts: CONTRACTS, indexedBlock: "100", asOf: 1000, strategies: [{ id: "earn", contracts: CONTRACTS, indexedBlock: "100", asOf: 1000 }] });
    expect(await earnIndexerHealth(store, { chainId: 4663, strategies: [] })).toBeNull();
    vi.mocked(store.strategy).mockResolvedValue(undefined);
    expect(await earnIndexerHealth(store, DEPLOYMENT)).toEqual({ contracts: CONTRACTS, indexedBlock: null, asOf: null, strategies: [{ id: "earn", contracts: CONTRACTS, indexedBlock: null, asOf: null }] });
  });

  it("lists every published strategy behind the flagship envelope and pages them by vault address", async () => {
    const stocks: EarnStoredStrategy = { ...stored, snapshot: { ...structuredClone(strategy), id: "stocks", title: "Gage USDG Stocks", strategy: STOCKS, address: STOCKS, blockNumber: "101", asOf: 1001, pockets: [] } };
    vi.mocked(store.strategy).mockImplementation(async (address, options) => {
      const current = address === STOCKS ? stocks : address === STRATEGY ? stored : undefined;
      return current && withEarnStrategyPockets(current, async () => current.snapshot.pockets, options?.includePockets ?? true);
    });
    const two = { chainId: 4663, strategies: [{ id: "earn", ...CONTRACTS }, { id: "stocks", ...CONTRACTS, HybridVault: STOCKS }] } as const;
    const list = await (await api(two).request("/strategies")).json();
    expect(list).toMatchObject({ ...SNAPSHOT, nextCursor: null });
    expect(list.items.map((item: EarnStrategy) => [item.id, item.address, item.blockNumber])).toEqual([["earn", STRATEGY, "100"], ["stocks", STOCKS, "101"]]);
    const first = await (await api(two).request("/strategies?limit=1")).json();
    expect(first.items.map((item: EarnStrategy) => item.id)).toEqual(["earn"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await (await api(two).request(`/strategies?limit=1&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((item: EarnStrategy) => item.id)).toEqual(["stocks"]);
    expect(second.nextCursor).toBeNull();
    expect((await (await api(two).request(`/${STOCKS}`)).json()).id).toBe("stocks");
    expect((await api(two).request(`/${OTHER}`)).status).toBe(404);
    expect(await earnIndexerHealth(store, two)).toMatchObject({ contracts: CONTRACTS, strategies: [{ id: "earn", indexedBlock: "100" }, { id: "stocks", indexedBlock: "101", contracts: { HybridVault: STOCKS } }] });
  });
});

describe("Earn keeper health proxy", () => {
  it("proxies the matching healthy keeper without changing transaction state", async () => {
    expect((await json(`/${STRATEGY}/keeper`)).body).toEqual(keeper);
  });
  it.each([1, 30, 31])("bounds keeper clock skew at 30 seconds (%s seconds ahead)", async ahead => {
    keeperFetch.mockResolvedValueOnce({ ...keeper, lastTickAt: 1000 + ahead });
    expect((await json(`/${STRATEGY}/keeper`)).body).toMatchObject({ ok: ahead <= 30, lastTickAt: 1000 + ahead });
  });
  it.each(["offline", "wrong-chain", "wrong-strategy", "malformed", "stale", "future"])("returns unavailable health for %s", async reason => {
    if (reason === "offline") keeperFetch.mockRejectedValueOnce(new Error("private URL"));
    if (reason === "wrong-chain") keeperFetch.mockResolvedValueOnce({ ...keeper, chainId: 46630 });
    if (reason === "wrong-strategy") keeperFetch.mockResolvedValueOnce({ ...keeper, strategy: OTHER });
    if (reason === "malformed") keeperFetch.mockResolvedValueOnce({ ok: true });
    if (reason === "stale") keeperFetch.mockResolvedValueOnce({ ...keeper, lastTickAt: 700 });
    if (reason === "future") keeperFetch.mockResolvedValueOnce({ ...keeper, lastTickAt: 1100 });
    const result = await json(`/${STRATEGY}/keeper`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, chainId: 4663, strategy: STRATEGY });
    if (["offline", "wrong-chain", "wrong-strategy", "malformed"].includes(reason)) expect(result.body.lastTickAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
