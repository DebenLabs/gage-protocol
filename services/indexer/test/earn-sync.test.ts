import { describe, expect, it } from "vitest";
import { EARN_ACCOUNT_REFRESH_BATCH, earnFlowOf, earnSettlementNotices, syncEarnStrategy, syncEarnAccount, syncEarnAccounts, syncEarnCoreLoan, syncEarnLoan, syncEarnLoans, syncEarnApproval, syncEarnPocket, syncEarnRequest, type EarnSyncStore } from "../src/lib/earn-sync";
import { earnPerformance, reserveRatio, shareAssets, type EarnValueSample } from "../src/lib/earn-accounting";
import { earnEventPosition, materializeEarnAccount, projectEarnAccount, publicEarnAccount, type EarnAccountRecord, type EarnPocketRecord } from "../src/lib/earn-account-state";
import { createEarnApi } from "../src/lib/earn-api";
import type { EarnLoan, EarnRequest, EarnStrategy } from "../../../shared/earn";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const E12 = 10n ** 12n, E18 = 10n ** 18n;
const params = { core: a(6), reserve: a(3), minDeposit: 10n, maxTotalDeposits: 10000n, maxLoanTerm: 604800, minReturnBps: 300, maxGageExposureBps: 10000 };
const config = { chainId: 31337, HybridVault: a(1), HybridReserve: a(3), USDG: a(4), EarnCore: a(6) };
const REGISTRY = a(5), CORE_REWARDS = a(13), FEES = a(15), FLOOR = a(16);
function harness() {
  let saved: EarnStrategy | undefined;
  let ratio: { numerator: bigint; denominator: bigint } | undefined;
  const reads: { target: string; name: string; block: bigint }[] = [];
  const loans = new Map<string, EarnLoan>(), requests = new Map<string, EarnRequest>(), pockets = new Map<string, EarnPocketRecord>();
  const accounts = new Map<string, EarnAccountRecord>();
  const cachedPockets: string[] = [];
  const reserveSamples: { block: bigint; asOf: bigint; assets: bigint }[] = [];
  const pocketCursors = new Map<string, string>();
  let cursor: { after?: `0x${string}`; active?: `0x${string}`; pocketAfter?: string } = {};
  const store: EarnSyncStore = {
    accountPage: async (after, limit) => [...accounts.values()].filter(row => !after || row.account > after).sort((x, y) => x.account.localeCompare(y.account)).slice(0, limit),
    accountCursor: async () => cursor, saveAccountCursor: async next => { cursor = next; },
    pocketPage: async (after, limit) => [...pockets.values()].filter(row => !after || BigInt(row.id) > BigInt(after)).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).slice(0, limit),
    accountPocketCursor: async account => pocketCursors.get(account), saveAccountPocketCursor: async (account, after) => { pocketCursors.set(account, after); },
    accountPocket: async (account, pocket) => { cachedPockets.push(`${account}:${pocket.id}`); },
    account: async account => accounts.get(account), saveAccount: async value => { accounts.set(value.account, value); }, history: async () => [], saveHistory: async () => {},
    loans: async () => [...loans.values()], loan: async id => loans.get(id), saveLoan: async v => { loans.set(v.id, v); },
    openRequestCount: async () => [...requests.values()].filter(row => row.status === "pending" || row.status === "partial").length,
    requests: async account => [...requests.values()].filter(r => !account || r.account === account), request: async id => requests.get(id), saveRequest: async v => { requests.set(v.id, v); },
    pockets: async () => [...pockets.values()], pocket: async id => pockets.get(id), savePocket: async v => { pockets.set(v.id, v); },
    approvals: async () => [], approval: async () => undefined, saveApproval: async () => {}, notice: async () => {}, admittedTokens: async () => [],
    strategy: async () => saved, saveStrategy: async (value: EarnStrategy, rate: typeof ratio) => { saved = value; ratio = rate; },
    latestReserveSample: async () => reserveSamples.at(-1), saveReserveSample: async row => { reserveSamples.push(row); },
  };
  const read = async (target: string, name: string, _args: readonly unknown[], block: bigint): Promise<unknown> => {
    reads.push({ target, name, block });
    if (name === "MANDATE_VERSION") return 2n;
    if (name === "params") return params;
    if (name === "rewardState") return [0n, 0n];
    if (name === "USDG") return config.USDG;
    if (name === "REGISTRY") return REGISTRY;
    if (name === "VAULT") return config.EarnCore;
    if (name === "RESERVE") return config.HybridReserve;
    if (name === "CORE_REWARDS" || name === "REWARDS") return CORE_REWARDS;
    if (name === "GRACE") return 200;
    if (name === "STRATEGY") return config.HybridVault;
    if (name === "REWARD_TOKEN") return a(12);
    if (name === "asset") return config.USDG;
    if (name === "symbol") return target === config.HybridReserve ? "Reserve" : "sGAGE";
    if (name === "CURATOR" || name === "curatorRecipient") return a(7);
    if (name === "fees") return FEES;
    if (name === "PROTOCOL_SHARE_BPS") return 2500;
    if (name === "PROTOCOL_RECIPIENT") return FLOOR;
    if (name === "decimals") return target === config.USDG ? 6 : 18;
    if (name === "cash") return 100n;
    if (name === "reserveShares") return 100n * E12;
    if (name === "performingPrincipal") return 100n;
    if (name === "overduePrincipal") return 7n;
    if (name === "fullAssets") return 398n;
    if (name === "totalAssets") return 390n;
    if (name === "lockedProfit") return 10n;
    if (name === "lockedProfitNow") return 8n;
    if (name === "unlockEnd") return 1500;
    if (name === "PROFIT_UNLOCK") return 604800;
    if (name === "VIRTUAL_SHARES" || name === "virtualShares") return E12;
    if (name === "totalSupply") return target === config.HybridVault ? 398n * E12 : 99n * E12;
    if (name === "pendingShares") return 10n * E12;
    if (name === "laneWeightBps") return _args[0] === 0 ? 6000 : 2000;
    if (name === "lanePrincipal") return _args[0] === 0 ? 100n : 0n;
    if (name === "accrueInterestView") return [199n, E12, 0n];
    if (name === "convertToAssets") return target === config.HybridReserve ? 198n : BigInt(_args[0] as bigint) * 391n / (399n * E12);
    if (name === "paused") return false;
    return 0n;
  };
  return { store, read, reads, saved: () => saved, ratio: () => ratio, loans, requests, pockets, accounts, cachedPockets, reserveSamples };
}
const repaid = { kind: 0, originator: a(8), token: a(9), state: 3, filled: 4, fundedAt: 100, term: 700, fundingDeadline: 90, cap: 1050n, principal: 1000n, collateral: 10n };

it("records one reserve conversion sample about every hour, whatever the sync cadence", async () => {
  const h = harness();
  await syncEarnStrategy(config, h.read, h.store, 100n, 1000n);
  await syncEarnStrategy(config, h.read, h.store, 110n, 1000n + 600n);
  await syncEarnStrategy(config, h.read, h.store, 120n, 1000n + 3599n);
  await syncEarnStrategy(config, h.read, h.store, 130n, 1000n + 3600n);
  await syncEarnStrategy(config, h.read, h.store, 140n, 1000n + 9000n);
  expect(h.reserveSamples.map(sample => [sample.block, sample.asOf])).toEqual([[100n, 1000n], [130n, 4600n], [140n, 10000n]]);
  // Assets per 1e18 reserve shares follow the same conversion the snapshot's reserveAssets uses (accrual and virtual shares included).
  expect(h.reserveSamples[0]!.assets).toBe(shareAssets(10n ** 18n, reserveRatio(199n, 100n * E12, E12)));
});

it("publishes the core term and the strategy's slice of the ledger's lender allocation on every loan row", async () => {
  const h = harness();
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return { ...repaid, state: 2 };
    if (name === "funded") return true;
    if (name === "loanSlots") return 1;
    if (name === "positionPrincipal") return 250n;
    if (name === "allocation") { expect(target).toBe(CORE_REWARDS); return { borrower: a(8), start: 100, end: 0, term: 700, borrowerTotal: 3n, lenderTotal: 1001n, borrowerAccounted: 0n, lenders: [config.HybridVault, a(10), a(10), a(10)] }; }
    return h.read(target, name, args, block);
  };
  const loan = await syncEarnLoan(config, read, h.store, 1n, 100n, 200n);
  // 1001 sGAGE over four quarters: the first quarter carries the remainder, exactly as the ledger slices it.
  expect(loan).toMatchObject({ term: 700, rewardTotal: "251", units: 1, slots: 1 });
  const whole = await syncEarnLoan(config, async (t, n, g, b) => n === "loanSlots" ? 15 : read(t, n, g, b), h.store, 1n, 100n, 200n);
  expect(whole).toMatchObject({ rewardTotal: "1001" });
  // A ledger that answers nothing useful (no allocation yet) publishes zero rather than failing the row.
  expect(await syncEarnLoan(config, async (t, n, g, b) => n === "allocation" ? 0n : read(t, n, g, b), h.store, 1n, 100n, 200n)).toMatchObject({ rewardTotal: "0", term: 700 });
});

it("refreshes an externally activated partial position with its real activation time, then reconciles overdue state", async () => {
  const h = harness();
  let core = { ...repaid, state: 1, fundedAt: 0 };
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return core;
    if (name === "funded") return true;
    if (name === "lenders") return [config.HybridVault, a(10), a(10), a(10)];
    if (name === "loanSlots") return 1;
    if (name === "positionPrincipal") return 250n;
    return h.read(target, name, args, block);
  };
  await syncEarnLoan(config, read, h.store, 1n, 80n, 80n);
  expect(await h.store.loan("1")).toMatchObject({ coreState: "FUNDING", fundedAt: 0, expiry: 0 });
  core = { ...core, state: 2, fundedAt: 85 };
  await syncEarnCoreLoan(config, read, h.store, config.EarnCore, 1n, 85n, 85n);
  expect(await h.store.loan("1")).toMatchObject({ coreState: "ACTIVE", state: "Active", fundedAt: 85, expiry: 785, claimableAt: 985, blockNumber: "85" });
  await syncEarnLoans(config, read, h.store, 786n, 786n);
  expect(await h.store.loan("1")).toMatchObject({ coreState: "ACTIVE", state: "Overdue", expiry: 785, claimableAt: 985, blockNumber: "786" });
  expect(h.reads.every(call => [80n, 85n, 786n].includes(call.block))).toBe(true);
});

it("ignores another engine or a position with no vault-owned lender slot, while retaining cancelled refunds", async () => {
  const h = harness();
  let core = { ...repaid, state: 1, fundedAt: 0 };
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return core;
    if (name === "funded") return true;
    if (name === "lenders") return [a(10), a(10), a(10), a(10)];
    if (name === "loanSlots") return 1;
    if (name === "positionPrincipal") return 250n;
    return h.read(target, name, args, block);
  };
  await syncEarnLoan(config, read, h.store, 1n, 80n, 80n);
  expect(await syncEarnCoreLoan(config, read, h.store, a(99), 1n, 85n, 85n)).toBeUndefined();
  expect(await syncEarnCoreLoan(config, read, h.store, config.EarnCore, 1n, 85n, 85n)).toBeUndefined();
  expect((await h.store.loan("1"))?.blockNumber).toBe("80");
  core = { ...core, state: 5 };
  expect(await syncEarnCoreLoan(config, read, h.store, config.EarnCore, 1n, 100n, 100n)).toMatchObject({ coreState: "CANCELLED", state: "Settling" });
});

it.each([
  { state: 2, at: 799n, closedAt: 0, carried: "250" },
  { state: 2, at: 800n, closedAt: 0, carried: "0" },
  { state: 4, at: 1000n, closedAt: 1000, carried: "0" },
  { state: 3, at: 900n, closedAt: 799, carried: "250" },
  { state: 3, at: 900n, closedAt: 800, carried: "0" },
])("projects loan carrying value before checkpoint: state=$state at=$at closed=$closedAt", async ({ state, at, closedAt, carried }) => {
  const h = harness();
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return { ...repaid, state, closedAt };
    if (name === "funded") return true;
    if (name === "loanSlots") return 1;
    if (name === "positionPrincipal") return 250n;
    return h.read(target, name, args, block);
  };
  expect(await syncEarnLoan(config, read, h.store, 1n, 100n, at)).toMatchObject({ carried, overdue: false, settled: false, positionPrincipal: "250" });
});

it("materializes late USDG recovery and claims from write-down ownership even after a full exit", async () => {
  const h = harness();
  const samples = new Map<bigint, EarnValueSample & { block: bigint }>();
  h.store.saveHistory = async (_, sample) => { samples.set(sample.block, sample); };
  h.store.history = async () => { throw Error("Event sync must not scan account history"); };
  let shares = 100n * E12, shareValue = 250n;
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "balanceOf") return shares;
    if (name === "convertToAssets" && target === config.HybridVault) return shareValue;
    return h.read(target, name, args, block);
  };
  await syncEarnAccount(config, read, h.store, a(8), 100n, 1000n, 250n);
  shares = 0n; shareValue = 0n;
  let account = await syncEarnAccount(config, read, h.store, a(8), 101n, 1001n, -100n);
  const pocket: EarnPocketRecord = { chainId: config.chainId, strategy: config.HybridVault, blockNumber: "102", asOf: 1002, id: "1", dealId: "1", token: config.USDG, amount: "700", supply: String(400n * E12), claimed: "0", openedAt: 1002, snapshotPosition: String(earnEventPosition(100n, 2)), createdPosition: String(earnEventPosition(102n, 1)) };
  const changes = [{ position: earnEventPosition(100n, 1), balance: 100n * E12 }, { position: earnEventPosition(101n, 1), balance: 0n }];
  await syncEarnStrategy(config, h.read, h.store, 102n, 1002n);
  const current = () => ({ snapshot: h.saved()!, shareAssetsNumerator: "391", shareAssetsDenominator: String(399n * E12) });
  expect(materializeEarnAccount(account, current(), [pocket], changes, [], [...samples.values()])).toMatchObject({ shares: "0", pockets: [{ token: config.USDG, claimable: "175", balanceAt: String(100n * E12) }], performance: { valueUSDG: "175", profitUSDG: "25", withdrawalsUSDG: "100" } });
  const outflow = earnFlowOf("PocketClaimed", { token: config.USDG, amount: 175n }, config.USDG);
  expect(outflow).toBe(-175n);
  expect(earnFlowOf("PocketClaimed", { token: a(9), amount: 175n }, config.USDG)).toBe(0n);
  account = await syncEarnAccount(config, read, h.store, a(8), 103n, 1003n, outflow);
  await syncEarnStrategy(config, h.read, h.store, 103n, 1003n);
  expect(materializeEarnAccount(account, current(), [pocket], changes, [{ pocketId: "1", position: earnEventPosition(103n, 1) }], [...samples.values()])).toMatchObject({ collateralReceived: [{ token: config.USDG, amount: "175" }], pockets: [{ claimable: "0", claimed: true }], performance: { valueUSDG: "0", profitUSDG: "25", withdrawalsUSDG: "275" } });
});

describe("Earn pinned block snapshots", () => {
  it("uses impairment-aware NAV before a checkpoint moves principal between stored buckets", async () => {
    const h = harness();
    await syncEarnStrategy(config, async (...args) => args[1] === "fullAssets" || args[1] === "totalAssets" ? 298n : args[1] === "lockedProfitNow" ? 0n : h.read(...args), h.store, 100n, 1000n);
    expect(h.saved()?.totals).toMatchObject({ cash: "100", reserveAssets: "198", performingPrincipal: "0", overduePrincipal: "107", fullAssets: "298", totalAssets: "298" });
    expect(h.ratio()).toEqual({ numerator: 299n, denominator: 399n * E12 });
  });

  it.each([0n, 5n, 1000n])("uses a positive reserve withdrawal limit without treating zero as empty (%s)", async limit => {
    const h = harness();
    await syncEarnStrategy(config, async (...args) => args[0] === config.HybridReserve && args[1] === "maxWithdraw" ? limit : h.read(...args), h.store, 100n, 1000n);
    expect(h.saved()?.totals).toMatchObject({ cash: "100", reserveAssets: "198", freeLiquidity: limit === 5n ? "105" : "298" });
  });

  it("does not read or embed historical pockets during publication", async () => {
    const h = harness();
    h.store.pockets = async () => { throw Error("Historical pockets must be joined only for API responses"); };
    await syncEarnStrategy(config, h.read, h.store, 100n, 1000n);
    expect(h.saved()?.pockets).toEqual([]);
  });

  it("prices shares on total assets, includes pending reserve fee shares and uses one explicit block for every read", async () => {
    const h = harness();
    await syncEarnStrategy(config, h.read, h.store, 100n, 1000n);
    expect(h.reads.every(v => v.block === 100n)).toBe(true);
    expect(h.ratio()).toEqual({ numerator: 391n, denominator: 399n * E12 });
    expect(h.saved()).toMatchObject({ core: config.EarnCore, coreRewards: CORE_REWARDS, registry: REGISTRY, grace: 200, reserveAsset: config.USDG, reserveSymbol: "Reserve", rewardToken: { address: a(12), symbol: "sGAGE", decimals: 18 }, fees: FEES, feeRecipient: a(7), protocolShareBps: 2500, protocolRecipient: FLOOR, shareDecimals: 18, pockets: [] });
    expect(h.saved()?.mandate).toEqual({ minDeposit: "10", maxTotalDeposits: "10000", maxLoanTerm: 604800, minReturnBps: 300, maxGageExposureBps: 10000 });
    expect(h.saved()?.totals).toMatchObject({ cash: "100", reserveAssets: "198", performingPrincipal: "100", overduePrincipal: "7", fullAssets: "398", totalAssets: "390", lockedProfit: "10", unlockEnd: 1500, profitUnlockSeconds: 604800, freeLiquidity: "298", pendingShares: String(10n * E12), pendingRequestAssets: "9", openRequests: 0 });
    // convertToAssets(1e18) at 390 total assets over 398e12 + 1e12 shares; the full price ignores the unlocking profit.
    expect(h.saved()?.shares).toEqual({ totalSupply: String(398n * E12), virtualShares: String(E12), price: "979949", fullPrice: "1000000" });
    expect(h.saved()?.lanes[0]).toEqual({ lane: "STOCK", weightBps: 6000, principal: "100", cap: "238", headroom: "138" });
  });
  it("fails closed when the reserve's conversion no longer matches its indexed ratio", async () => {
    const h = harness();
    await expect(syncEarnStrategy(config, async (...args) => args[1] === "convertToAssets" && args[0] === config.HybridReserve ? 197n : h.read(...args), h.store, 100n, 1000n)).rejects.toThrow(/reserve conversion/);
    expect(h.saved()).toBeUndefined();
  });
});

it("bounds account and pocket catch-up independently and resumes after restart with a large history", async () => {
  const h = harness();
  const first = await syncEarnAccount(config, h.read, h.store, a(100), 100n, 1000n, 98n);
  for (let i = 0; i < EARN_ACCOUNT_REFRESH_BATCH * 2 + 1; i++) h.accounts.set(a(100 + i), { ...structuredClone(first), account: a(100 + i) });
  const pocket: EarnPocketRecord = { chainId: config.chainId, strategy: config.HybridVault, blockNumber: "100", asOf: 1000, id: "1", dealId: "1", token: a(9), amount: "1000", supply: "1000", claimed: "0", openedAt: 1000, snapshotPosition: "1", createdPosition: "2" };
  for (let i = 1; i <= 10000; i++) h.pockets.set(String(i), { ...pocket, id: String(i) });
  h.store.history = async () => { throw Error("Complete history must not be read"); };
  h.store.pockets = async () => { throw Error("Complete pocket table must not be read"); };
  let accountRows = 0, pocketRows = 0;
  const page = h.store.accountPage, pocketPage = h.store.pocketPage;
  h.store.accountPage = async (after, limit) => { expect(limit).toBeLessThanOrEqual(32); const rows = await page(after, limit); accountRows += rows.length; return rows; };
  h.store.pocketPage = async (after, limit) => { expect(limit).toBeLessThanOrEqual(32); const rows = await pocketPage(after, limit); pocketRows += rows.length; return rows; };
  const noRpc = async () => { throw Error("Catch-up must not use RPC"); };
  const refresh = () => syncEarnAccounts(config, noRpc, { ...h.store }, 101n, 1001n);
  expect(await refresh()).toEqual({ accounts: 0, pockets: 32 });
  expect(accountRows).toBe(32); expect(pocketRows).toBe(32); expect(h.cachedPockets).toHaveLength(32);
  const cursor = await h.store.accountCursor();
  expect(cursor.active).toBe(a(100)); expect(cursor.pocketAfter).toBeDefined();
  expect(await refresh()).toEqual({ accounts: 0, pockets: 32 });
  expect(new Set(h.cachedPockets).size).toBe(64);
  expect((await h.store.accountCursor()).pocketAfter).not.toBe(cursor.pocketAfter);
  // Empty-pocket accounts are also capped, and finishing the last page restarts the pass.
  h.pockets.clear(); h.cachedPockets.length = 0;
  await h.store.saveAccountCursor({});
  expect(await refresh()).toEqual({ accounts: 32, pockets: 0 });
  expect(await refresh()).toEqual({ accounts: 32, pockets: 0 });
  expect(await refresh()).toEqual({ accounts: 1, pockets: 0 });
  expect(await h.store.accountCursor()).toEqual({});
});

it("projects a pending account's exact contract reward anchor without repeated rounding or duplicate flows", async () => {
  const h = harness();
  const account = await syncEarnAccount(config, async (target, name, args, block) => name === "balanceOf" ? 2n : name === "rewardState" ? [7n, 1n] : h.read(target, name, args, block), h.store, a(8), 100n, 1000n, 98n);
  await syncEarnStrategy(config, h.read, h.store, 101n, 1001n);
  const current = { snapshot: { ...h.saved()!, totals: { ...h.saved()!.totals, accRewardPerShare: String(E18 / 2n) } }, shareAssetsNumerator: "391", shareAssetsDenominator: String(399n * E12) };
  const projected = projectEarnAccount(account, current);
  // floor(2 * (0.5e18 - 1) / 1e18) is zero, while subtracting absolute floors would incorrectly add one.
  expect(projected.rewards).toBe("7");
  expect(projectEarnAccount(projected, current)).toEqual(projected);
  expect(projected.performance?.depositsUSDG).toBe("98");
});

it("only catches up new pocket IDs on later passes, including the numeric transition from 9 to 10", async () => {
  const h = harness();
  await syncEarnAccount(config, h.read, h.store, a(8), 100n, 1000n);
  const pocket: EarnPocketRecord = { chainId: config.chainId, strategy: config.HybridVault, blockNumber: "100", asOf: 1000, id: "9", dealId: "1", token: a(9), amount: "1000", supply: "1000", claimed: "0", openedAt: 1000, snapshotPosition: "1", createdPosition: "2" };
  h.pockets.set("9", pocket);
  const refresh = () => syncEarnAccounts(config, h.read, h.store, 101n, 1001n);
  expect(await refresh()).toEqual({ accounts: 1, pockets: 1 });
  expect(await refresh()).toEqual({ accounts: 1, pockets: 0 });
  h.pockets.set("10", { ...pocket, id: "10" });
  expect(await refresh()).toEqual({ accounts: 1, pockets: 1 });
  expect(h.cachedPockets).toEqual([`${a(8)}:9`, `${a(8)}:10`]);
});

it("serves complete current account API results before pocket catch-up reaches the account", async () => {
  const h = harness();
  const account = await syncEarnAccount(config, async (target, name, args, block) => name === "balanceOf" ? 100n * E12 : h.read(target, name, args, block), h.store, a(8), 100n, 1000n, 97n);
  await syncEarnStrategy(config, h.read, h.store, 101n, 1001n);
  const current = { snapshot: { ...h.saved()!, totals: { ...h.saved()!.totals, accRewardPerShare: "500000" } }, shareAssetsNumerator: "391", shareAssetsDenominator: String(399n * E12) };
  const pocket: EarnPocketRecord = { chainId: config.chainId, strategy: config.HybridVault, blockNumber: "101", asOf: 1001, id: "1", dealId: "1", token: config.USDG, amount: "1000", supply: String(400n * E12), claimed: "0", openedAt: 1001, snapshotPosition: String(earnEventPosition(100n, 2)), createdPosition: String(earnEventPosition(101n, 1)) };
  const materialize = () => publicEarnAccount(materializeEarnAccount(account, current, [pocket], [{ position: earnEventPosition(100n, 1), balance: 100n * E12 }], [], [{ block: 100n, asOf: 1000, value: 97n, flow: 97n }]));
  // The stored strategy is compact; its HTTP store joins the complete indexed pocket inventory.
  const publicStrategy = { ...current, snapshot: { ...current.snapshot, pockets: [{ chainId: pocket.chainId, strategy: pocket.strategy, blockNumber: current.snapshot.blockNumber, asOf: current.snapshot.asOf, id: pocket.id, dealId: pocket.dealId, token: pocket.token, amount: pocket.amount, supply: pocket.supply, claimed: pocket.claimed, openedAt: pocket.openedAt }] } };
  const api = createEarnApi({ deployment: { chainId: config.chainId, strategies: [{ id: "earn", HybridVault: config.HybridVault, HybridReserve: config.HybridReserve, EarnCore: config.EarnCore }] }, store: { strategy: async () => publicStrategy, account: async () => materialize(), list: async () => [{ id: a(8), snapshot: materialize() }] } });
  const strategyResponse = await (await api.request(`/${config.HybridVault}`)).json();
  expect(strategyResponse.pockets).toMatchObject([{ id: "1", token: config.USDG, amount: "1000", blockNumber: "101" }]);
  for (const suffix of [`accounts/${a(8)}`, "accounts"]) {
    const response = await api.request(`/${config.HybridVault}/${suffix}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const result = suffix === "accounts" ? body.items[0] : body;
    expect(result).toMatchObject({ blockNumber: "101", value: "97", rewards: "50", pockets: [{ pocketId: "1", claimable: "250" }], performance: { depositsUSDG: "97", valueUSDG: "347", profitUSDG: "250" } });
    expect(result).not.toHaveProperty("_earnCheckpoint");
    expect(strategyResponse.pockets.some((pocket: { id: string }) => pocket.id === result.pockets[0].pocketId)).toBe(true);
  }
  expect(h.cachedPockets).toEqual([]);
});

it("records one row per loan, taking payout, profit and fee from the settlement events", async () => {
  const h = harness();
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return repaid;
    if (name === "funded" || name === "terminal") return true;
    if (name === "loanFeeBps") return 1000n;
    if (name === "loanLane") return 0;
    if (name === "loanSlots") return 15;
    if (name === "positionPrincipal") return 1000n;
    if (name === "withdrawn" || name === "overdue") return false;
    return h.read(target, name, args, block);
  };
  await syncEarnLoan(config, read, h.store, 1n, 100n, 1000n, { profit: 50n, fee: 5n });
  const loan = await syncEarnLoan(config, read, h.store, 1n, 100n, 1000n, { payout: 1050n });
  expect(loan).toMatchObject({ id: "1", dealId: "1", lane: "STOCK", coreState: "REPAID", units: 4, slots: 15, positionPrincipal: "1000", withdrawn: false, overdue: false, carried: "0", expiry: 800, claimableAt: 1000, settled: true, outcome: "cash", state: "Repaid", payout: "1050", profit: "50", fee: "5", feeBps: 1000, pocketId: null, pocketIds: [], rewards: "0" });
  expect(loan).not.toHaveProperty("account");
  await syncEarnLoan(config, read, h.store, 1n, 101n, 1001n, { rewards: 7n });
  expect((await h.store.loan("1"))?.rewards).toBe("7");
});

it("writes an overdue loan down to nothing, then nets the grace repayment against the booked loss", async () => {
  const h = harness();
  let loan: Record<string, unknown> = { ...repaid, state: 2 }, terminal = false, written = true, released = false;
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return loan;
    if (name === "funded") return true;
    if (name === "terminal") return terminal;
    if (name === "overdue") return written;
    if (name === "loanFeeBps") return 1000n;
    if (name === "loanLane") return 1;
    if (name === "loanSlots") return 3;
    if (name === "positionPrincipal") return 501n;
    if (name === "withdrawn") return released;
    return h.read(target, name, args, block);
  };
  expect(await syncEarnLoan(config, read, h.store, 1n, 100n, 900n, { profit: -501n })).toMatchObject({ lane: "MEME", units: 2, slots: 3, overdue: true, carried: "0", profit: "-501", state: "Overdue", settled: false, outcome: null });
  terminal = true; loan = { ...repaid, state: 3 };
  expect(await syncEarnLoan(config, read, h.store, 1n, 101n, 901n, { profit: 526n, fee: 2n })).toMatchObject({ profit: "25", fee: "2" });
  expect(await syncEarnLoan(config, read, h.store, 1n, 101n, 901n, { payout: 526n })).toMatchObject({ state: "Repaid", outcome: "cash", payout: "526", carried: "0" });
  // A commitment released before activation refunds the position principal and books nothing.
  written = false; released = true; loan = { ...repaid, state: 1, fundedAt: 0 };
  const refund = await syncEarnLoan(config, read, h.store, 2n, 102n, 902n, { payout: 501n });
  expect(refund).toMatchObject({ coreState: "FUNDING", withdrawn: true, outcome: "refund", state: "Refunded", expiry: 0, claimableAt: 0, payout: "501", profit: "0" });
  expect(await syncEarnLoan(config, async (t, n, g, b) => n === "funded" ? false : read(t, n, g, b), h.store, 3n, 102n, 902n)).toBeUndefined();
});

it("links a finalized default to its side pocket and keeps the collateral unpriced", async () => {
  const h = harness();
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return { ...repaid, state: 4 };
    if (name === "funded" || name === "terminal" || name === "overdue") return true;
    if (name === "pockets") return [1n, a(9), 10n, 398n * E12, 0n];
    if (name === "loanLane" || name === "withdrawn") return 0;
    if (name === "loanSlots") return 15;
    if (name === "positionPrincipal") return 1000n;
    return h.read(target, name, args, block);
  };
  const pocket = await syncEarnPocket(config, read, h.store, 1n, 100n, 1000n);
  expect(pocket).toMatchObject({ id: "1", dealId: "1", token: a(9), amount: "10", supply: String(398n * E12), claimed: "0", openedAt: 1000 });
  const loan = await syncEarnLoan(config, read, h.store, 1n, 100n, 1000n, { pocketId: 1n });
  expect(loan).toMatchObject({ state: "Collateral", outcome: "collateral", pocketId: "1", payout: "0", carried: "0" });
  await syncEarnStrategy(config, read, h.store, 100n, 1000n);
  expect(h.saved()?.pockets).toEqual([]);
  expect(await h.store.pocket("1")).toEqual(pocket);
});

it("invalidates approval rows whose funding epoch changed on pause", async () => {
  const h = harness();
  let saved: unknown;
  Object.assign(h.store, { approval: async () => undefined, saveApproval: async (v: unknown) => { saved = v; } });
  await syncEarnApproval(config, async (_target, name) => {
    if (name === "approvals") return [1300n, 600n, 1n, 2n];
    if (name === "approvalEpoch") return 2n;
    if (name === "getLoan") return { kind: 0, token: a(9), principal: 1200n };
    if (name === "getERC20Config") return { lane: 0 };
    if (name === "funded") return false;
    if (name === "REGISTRY") return REGISTRY;
    throw new Error(name);
  }, h.store, 1n, 100n, 1000n);
  expect(saved).toMatchObject({ revoked: true, principal: "600", units: 2, validUntil: 1300 });
});

it.each([
  { kind: 0, registryLane: 0, expectedKind: "ERC20", lane: "STOCK" },
  { kind: 0, registryLane: 1, expectedKind: "ERC20", lane: "STOCK" },
  { kind: 0, registryLane: 2, expectedKind: "ERC20", lane: "MEME" },
  { kind: 1, registryLane: undefined, expectedKind: "UNIV4_POSITION", lane: "LP" },
  { kind: 2, registryLane: undefined, expectedKind: "UNIV3_POSITION", lane: "LP" },
])("indexes $expectedKind approvals in $lane with registry lane $registryLane", async ({ kind, registryLane, expectedKind, lane }) => {
  const h = harness();
  let saved: unknown, registryReads = 0;
  h.store.saveApproval = async value => { saved = value; };
  await syncEarnApproval(config, async (_target, name) => {
    if (name === "approvals") return [1300n, 600n, 1n, 2n];
    if (name === "approvalEpoch") return 1n;
    if (name === "getLoan") return { kind, token: a(9), collateral: 98765432101234567890n, principal: 1200n };
    if (name === "getERC20Config") { registryReads++; if (kind !== 0) throw Error("An NFT manager is not an ERC20 lending asset"); return { lane: registryLane }; }
    if (name === "funded") return false;
    if (name === "REGISTRY") return REGISTRY;
    throw Error(name);
  }, h.store, 1n, 100n, 1000n);
  expect(saved).toMatchObject({ lane, kind: expectedKind, token: a(9), principal: "600", units: 2, revoked: false });
  expect(registryReads).toBe(kind === 0 ? 1 : 0);
});

it.each([{ kind: 1, expectedKind: "UNIV4_POSITION" }, { kind: 2, expectedKind: "UNIV3_POSITION" }])("keeps both $expectedKind recovery pockets, with one notice per underlying currency", async ({ kind, expectedKind }) => {
  const h = harness();
  const underlying = a(10), native = a(0);
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "getLoan") return { ...repaid, kind, state: 4, collateral: 98765432101234567890n };
    if (name === "funded" || name === "terminal" || name === "overdue") return true;
    if (name === "loanLane") return 2;
    if (name === "loanSlots") return 15;
    if (name === "positionPrincipal") return 1000n;
    if (name === "pockets") return [1n, args[0] === 1n ? underlying : native, args[0] === 1n ? 1500000n : 2n * E18, 398n * E12, 0n];
    if (target === underlying && name === "symbol") return "RECOVERED";
    if (target === underlying && name === "decimals") return 6;
    if (target === underlying && name === "uiMultiplier") throw Error("Optional method absent");
    if (target === native) throw Error("Never call ERC20 methods on native currency");
    return h.read(target, name, args, block);
  };
  for (const id of [1n, 2n]) {
    await syncEarnPocket(config, read, h.store, id, 100n, 1000n);
    await syncEarnLoan(config, read, h.store, 1n, 100n, 1000n, { pocketId: id });
  }
  // Reconciliation must retain both event links, and seeing a pocket again must not duplicate it.
  const loan = (await syncEarnLoan(config, read, h.store, 1n, 101n, 1001n, { pocketId: 2n }))!;
  expect(loan).toMatchObject({ kind: expectedKind, lane: "LP", token: a(9), collateralAmount: "98765432101234567890", outcome: "collateral", pocketId: "1", pocketIds: ["1", "2"] });
  expect(h.pockets.get("1")?.metadata).toEqual({ symbol: "RECOVERED", decimals: 6, uiMultiplier: String(E18) });
  expect(h.pockets.get("2")?.metadata).toEqual({ symbol: "ETH", decimals: 18, uiMultiplier: String(E18) });
  const notices = earnSettlementNotices(loan, [...h.pockets.values()], config.USDG, { id: "tx:12", transactionHash: "tx" });
  expect(notices.map(notice => [notice.id, notice.kind, notice.token, notice.amount])).toEqual([
    ["tx:12:1", "collateral", underlying, "1500000"], ["tx:12:2", "collateral", native, String(2n * E18)],
  ]);
  expect(notices.every(notice => notice.account === config.HybridVault && notice.dealId === "1")).toBe(true);
});

it("retains the side pocket if its recovered token has no metadata", async () => {
  const h = harness();
  const pocket = await syncEarnPocket(config, async (target, name, args, block) => {
    if (name === "pockets") return [1n, a(9), 100n, E18, 0n];
    if (target === a(9)) throw Error("Metadata unavailable");
    return h.read(target, name, args, block);
  }, h.store, 1n, 100n, 1000n);
  expect(pocket).toMatchObject({ amount: "100", token: a(9) });
  expect(pocket.metadata).toBeUndefined();
});

it.each([
  { symbol: "RECOVERED", decimals: 37 },
  { symbol: "", decimals: 18 },
  { symbol: "x".repeat(65), decimals: 18 },
])("omits unsupported optional recovery metadata without hiding claims: $symbol / $decimals", async ({ symbol, decimals }) => {
  const h = harness();
  const pocket = await syncEarnPocket(config, async (target, name, args, block) => {
    if (name === "pockets") return [1n, a(9), 100n, E18, 0n];
    if (target === a(9) && name === "symbol") return symbol;
    if (target === a(9) && name === "decimals") return decimals;
    return h.read(target, name, args, block);
  }, h.store, 1n, 100n, 1000n);
  expect(pocket).toMatchObject({ token: a(9), amount: "100", claimed: "0" });
  expect(pocket.metadata).toBeUndefined();
  expect(h.pockets.get("1")).toEqual(pocket);
});

it("publishes Earn lane indices independently of the registry, including WETH under stocks", async () => {
  const h = harness();
  h.store.admittedTokens = async () => [a(9), a(10), a(11)];
  await syncEarnStrategy(config, async (target, name, args, block) => {
    if (name === "tokenUnit") return E18;
    if (name === "getERC20Config") return { lane: [a(9), a(10), a(11)].indexOf(args[0] as `0x${string}`), allowed: true };
    if (name === "uiMultiplier" && target === a(10)) throw Error("WETH has no stock multiplier");
    return h.read(target, name, args, block);
  }, h.store, 100n, 1000n);
  expect(h.saved()?.lanes.map(lane => lane.lane)).toEqual(["STOCK", "MEME", "LP"]);
  expect(h.saved()?.tokens.map(token => token.lane)).toEqual(["STOCK", "STOCK", "MEME"]);
  expect(h.saved()?.mandate).not.toHaveProperty("maxPerLoan");
  expect(h.saved()?.mandate).not.toHaveProperty("maxPerBorrower");
});

it("ignores zero-ceiling events for tokens never admitted", async () => {
  const h = harness();
  await syncEarnStrategy(config, async (...args) => {
    if (args[0] === a(99)) throw new Error("EOA is not an ERC20");
    return h.read(...args);
  }, h.store, 100n, 1000n, a(99));
  expect(h.saved()?.tokens).toEqual([]);
});

it("rejects a deployment manifest whose core or reserve differs from the strategy", async () => {
  const h = harness();
  await expect(syncEarnStrategy(config, async (...args) => args[1] === "params" ? { ...params, reserve: a(99) } : h.read(...args), h.store, 100n, 1000n)).rejects.toThrow(/identity/);
  expect(h.saved()).toBeUndefined();
});

it.each([0n, 1n, 3n])("refuses to reinterpret another deployment's mandate version (%s)", async version => {
  const h = harness();
  await expect(syncEarnStrategy(config, async (...args) => args[1] === "MANDATE_VERSION" ? version : h.read(...args), h.store, 100n, 1000n)).rejects.toThrow("Unsupported Earn mandate version");
  expect(h.saved()).toBeUndefined();
});

it("rejects a fee companion attached to another strategy", async () => {
  const h = harness();
  await expect(syncEarnStrategy(config, async (...args) => args[1] === "STRATEGY" ? a(99) : h.read(...args), h.store, 100n, 1000n)).rejects.toThrow(/identity/);
});

it("publishes without a fee companion, reporting a zero fee split", async () => {
  const h = harness();
  await syncEarnStrategy(config, async (...args) => args[1] === "fees" ? a(0) : h.read(...args), h.store, 100n, 1000n);
  expect(h.saved()).toMatchObject({ fees: a(0), feeRecipient: a(0), protocolShareBps: 0, curatorAccrued: "0" });
});

it("uses event order for two pockets and keeps already claimed collateral", async () => {
  const h = harness();
  const account = await syncEarnAccount(config, h.read, h.store, a(10), 100n, 1000n);
  await syncEarnStrategy(config, h.read, h.store, 101n, 1001n);
  const p = { chainId: config.chainId, strategy: config.HybridVault, blockNumber: "101", asOf: 1001, token: a(9), claimed: "0", openedAt: 1001, createdPosition: String(earnEventPosition(101n, 1)) };
  const pockets = [{ ...p, id: "1", dealId: "1", amount: "100", supply: "1000", snapshotPosition: String(earnEventPosition(100n, 2)) }, { ...p, id: "2", dealId: "5", amount: "50", supply: "500", snapshotPosition: String(earnEventPosition(100n, 4)) }];
  const changes = [{ position: earnEventPosition(100n, 1), balance: 250n }, { position: earnEventPosition(100n, 3), balance: 100n }, { position: earnEventPosition(100n, 5), balance: 0n }];
  const result = materializeEarnAccount(account, { snapshot: h.saved()!, shareAssetsNumerator: "391", shareAssetsDenominator: String(399n * E12) }, pockets, changes, [{ pocketId: "2", position: earnEventPosition(101n, 2) }], []);
  expect(result).toMatchObject({ pockets: [{ pocketId: "1", claimable: "25", balanceAt: "250", claimed: false }, { pocketId: "2", claimable: "0", balanceAt: "100", claimed: true }], collateralReceived: [{ token: a(9), amount: "10" }] });
});

it("tracks request status and served amounts without rewriting other queue rows", async () => {
  const h = harness();
  const chain = new Map<bigint, [string, bigint]>([[1n, [a(10), 30n]], [2n, [a(11), 20n]], [3n, [a(10), 10n]]]);
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => name === "requests" ? chain.get(args[0] as bigint) : h.read(target, name, args, block);
  for (const id of [1n, 2n, 3n]) await syncEarnRequest(config, read, h.store, id, 100n, 1000n);
  expect([...h.requests.values()].map(r => [r.id, r.status, r.position])).toEqual([["1", "pending", 0], ["2", "pending", 0], ["3", "pending", 0]]);
  chain.set(1n, [a(10), 5n]);
  expect(await syncEarnRequest(config, read, h.store, 1n, 101n, 1001n, { served: { shares: 25n, assets: 24n } })).toMatchObject({ status: "partial", shares: "5", servedShares: "25", servedAssets: "24", position: 0, requestedAt: 1000 });
  chain.set(1n, [a(10), 0n]); chain.set(2n, [a(11), 0n]);
  await syncEarnRequest(config, read, h.store, 1n, 102n, 1002n, { served: { shares: 5n, assets: 5n } });
  await syncEarnRequest(config, read, h.store, 2n, 102n, 1002n, { cancelled: true });
  expect([...h.requests.values()].map(r => [r.id, r.status, r.position, r.servedAssets])).toEqual([["1", "served", 0, "29"], ["2", "cancelled", 0, "0"], ["3", "pending", 0, "0"]]);
  let account: unknown;
  h.store.saveAccount = async value => { account = value; };
  await syncEarnAccount(config, read, h.store, a(10), 102n, 1002n);
  // Historical requests are joined by the account API, not recopied during every account event.
  expect((account as { requests: EarnRequest[] }).requests).toEqual([]);
  expect((await h.store.requests(a(10))).map(r => r.id)).toEqual(["1", "3"]);
  await syncEarnStrategy(config, read, h.store, 102n, 1002n);
  expect(h.saved()?.totals.openRequests).toBe(1);
});

it("processes a request event with one read and one row write even with 10,000 queued requests", async () => {
  const h = harness();
  const row: EarnRequest = { chainId: config.chainId, strategy: config.HybridVault, blockNumber: "100", asOf: 1000, id: "1", account: a(8), shares: "1", servedShares: "0", servedAssets: "0", status: "pending", position: 0, requestedAt: 1000 };
  for (let i = 1; i <= 10000; i++) h.requests.set(String(i), { ...row, id: String(i) });
  h.store.requests = async () => { throw Error("A request event must not read the queue"); };
  let reads = 0, writes = 0;
  const save = h.store.saveRequest;
  h.store.saveRequest = async value => { writes++; await save(value); };
  const read = async () => { reads++; return [a(8), 0n]; };
  await syncEarnRequest(config, read, h.store, 1n, 101n, 1001n, { cancelled: true });
  expect(reads).toBe(1); expect(writes).toBe(1);
  expect(h.requests.get("1")?.status).toBe("cancelled");
  expect(h.requests.get("10000")).toEqual({ ...row, id: "10000" });
});

it("reads a changing stock multiplier at each block and never calls it for other lanes", async () => {
  const h = harness();
  h.store.admittedTokens = async () => [a(9), a(10)];
  const multiplierReads: string[] = [];
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => {
    if (name === "tokenUnit") return E18;
    if (name === "tokenCeiling") return 100n;
    if (name === "getERC20Config") return { allowed: true, lane: args[0] === a(9) ? 0 : 2 };
    if (name === "uiMultiplier") { multiplierReads.push(target); return block === 100n ? 2n * E18 : 3n * E18; }
    return h.read(target, name, args, block);
  };
  await syncEarnStrategy(config, read, h.store, 100n, 1000n);
  expect(h.saved()?.tokens.map(t => t.uiMultiplier)).toEqual(["2000000000000000000", "1000000000000000000"]);
  await syncEarnStrategy(config, read, h.store, 101n, 1001n);
  expect(h.saved()?.tokens[0]?.uiMultiplier).toBe("3000000000000000000");
  expect(multiplierReads).toEqual([a(9), a(9)]);
});

it("attributes outstanding position principal to each admitted token from open loans, written down or not", async () => {
  const h = harness();
  const row = (dealId: string, token: `0x${string}`, positionPrincipal: string, settled: boolean, overdue = false): EarnLoan => ({
    chainId: 31337, strategy: config.HybridVault, blockNumber: "99", asOf: 999, id: dealId, dealId, borrower: a(8), token, lane: "STOCK", kind: "ERC20",
    principal: "10", cap: "11", collateralAmount: "20", positionPrincipal, units: 4, slots: 15, withdrawn: false, overdue, carried: settled || overdue ? "0" : positionPrincipal,
    state: settled ? "Repaid" : "Active", coreState: settled ? "REPAID" : "ACTIVE", fundingDeadline: 5, fundedAt: 10, expiry: 20, claimableAt: 30, settled, outcome: settled ? "cash" : null,
    payout: "0", profit: "0", fee: "0", feeBps: 1000, pocketId: null, pocketIds: [], rewards: "0" });
  for (const loan of [row("1", a(9), "60", false), row("2", a(9), "40", false, true), row("3", a(9), "500", true)]) h.loans.set(loan.id, loan);
  h.store.admittedTokens = async () => [a(9)];
  const read = async (target: `0x${string}`, name: string, args: readonly unknown[], block: bigint) => name === "tokenUnit" ? E18 : name === "tokenCeiling" ? 70n : name === "getERC20Config" ? { lane: 0, allowed: true } : h.read(target, name, args, block);
  await syncEarnStrategy(config, read, h.store, 100n, 1000n);
  expect(h.saved()?.tokens.map(token => [token.token, token.principal])).toEqual([[a(9), "100"]]);
  expect(h.saved()?.lanes[0]?.principal).toBe("100");
});

describe("Earn account performance", () => {
  it("chains sub-period returns between flows and never annualizes", () => {
    // Deposit 100, grow to 110, deposit 110 more at that value, then a default takes the account from 220 to 200.
    const samples: EarnValueSample[] = [{ value: 100n, flow: 100n, asOf: 1 }, { value: 110n, flow: 0n, asOf: 2 }, { value: 220n, flow: 110n, asOf: 3 }, { value: 200n, flow: 0n, asOf: 4 }];
    const result = earnPerformance(samples);
    expect(result).toMatchObject({ deposits: 210n, withdrawals: 0n, value: 200n, profit: -10n, sinceAt: 1, samples: 4 });
    expect(result.twrBps).toBe(0); // 1.10 × 1.00 × (200/220) = 1.0000: the loss exactly undoes the gain in time-weighted terms
    expect(earnPerformance([{ value: 100n, flow: 100n, asOf: 1 }, { value: 50n, flow: -60n, asOf: 2 }]).twrBps).toBe(1000);
    expect(earnPerformance([{ value: 100n, flow: 100n, asOf: 1 }, { value: 0n, flow: -100n, asOf: 2 }, { value: 50n, flow: 50n, asOf: 3 }, { value: 55n, flow: 0n, asOf: 4 }]).twrBps).toBe(1000);
    expect(earnPerformance([]).twrBps).toBe(0);
    expect(() => earnPerformance([{ value: -1n, flow: 0n, asOf: 1 }])).toThrow("negative");
  });
  it("maps deposits, redemptions and claims to flows and treats serving and rewards as internal", () => {
    expect(earnFlowOf("Deposited", { assets: 40n, shares: 1n })).toBe(40n);
    expect(earnFlowOf("Withdrawn", { assets: 15n, shares: 1n })).toBe(-15n);
    expect(earnFlowOf("Claimed", { assets: 7n })).toBe(-7n);
    expect(earnFlowOf("RequestServed", { assets: 7n, shares: 1n })).toBe(0n);
    expect(earnFlowOf("RewardsClaimed", { amount: 7n })).toBe(0n);
  });
  it("records a value sample on every account sync, counting share value and unclaimed served USDG", async () => {
    const h = harness();
    const rows = new Map<bigint, EarnValueSample & { block: bigint }>();
    let account: unknown;
    Object.assign(h.store, { saveHistory: async (_who: string, row: EarnValueSample & { block: bigint }) => { rows.set(row.block, row); }, history: async () => [...rows.values()], saveAccount: async (value: EarnAccountRecord) => { account = value; h.accounts.set(value.account, value); } });
    const read = (value: bigint, claimable: bigint) => async (...args: Parameters<typeof h.read>) => {
      if (args[1] === "balanceOf") return 100n * E12;
      if (args[1] === "convertToAssets") return value;
      if (args[1] === "claimable") return claimable;
      if (args[1] === "lockedShares" || args[1] === "rewardClaimable" || args[1] === "maxWithdraw") return 0n;
      return h.read(...args);
    };
    // Two events in the deposit block: a reward claim (no flow) and the deposit itself; both read the same end-of-block state.
    await syncEarnAccount(config, read(100n, 0n), h.store, a(10), 101n, 1001n, 0n);
    await syncEarnAccount(config, read(100n, 0n), h.store, a(10), 101n, 1001n, 100n);
    await syncEarnAccount(config, read(90n, 30n), h.store, a(10), 102n, 1002n);
    expect([...rows.values()].map(row => [row.block, row.value, row.flow])).toEqual([[101n, 100n, 100n], [102n, 120n, 0n]]);
    expect(account).toMatchObject({ performance: { valueUSDG: "120", depositsUSDG: "100", withdrawalsUSDG: "0", profitUSDG: "20", twrBps: 2000, sinceAt: 1001, samples: 2 } });
  });
});
