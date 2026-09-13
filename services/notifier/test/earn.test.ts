import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EarnAccount, EarnApproval, EarnKeeperHealth, EarnLoan, EarnNotice, EarnStrategy } from "../../../shared/earn.js";
import { openDb } from "../src/db.js";
import { makeIndexer } from "../src/indexer.js";
import { violations } from "../src/messages.js";
import { Poller } from "../src/poller.js";
import { DEFAULT_PREFS } from "../src/prefs.js";
import { approvalNotice, claimableNotice, listingNotice, outcomeNotices } from "../src/earn.js";
import { consoleChannels, designDeal, NVDA, testConfig, testLogger } from "./helpers.js";

const NOW = 1_800_000_000;
const address = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const STRATEGY = address(1), CURATOR = address(2), ACCOUNT = address(3);
const snapshot = { chainId: 46630, strategy: STRATEGY, blockNumber: "100", asOf: NOW };
const strategy: EarnStrategy = {
  ...snapshot, id: "earn", title: "Gage USDG Mix", address: STRATEGY, core: address(4), coreRewards: address(12), registry: address(5), reserveAsset: address(6), reserveSymbol: "USDG",
  rewardToken: { address: address(7), symbol: "sGAGE", decimals: 18 }, reserve: address(8),
  curator: CURATOR, usdg: address(6), usdgDecimals: 6, reserveDecimals: 18, shareDecimals: 18, paused: false, feeBps: 1000,
  fees: address(10), feeRecipient: CURATOR, protocolShareBps: 2500, protocolRecipient: address(11), feeAccrued: "0", curatorAccrued: "0", protocolAccrued: "0", highWaterPrice: "0", grace: 172800,
  mandate: { minDeposit: "1", maxTotalDeposits: "10000000000", maxLoanTerm: 21 * 86400, minReturnBps: 50, maxGageExposureBps: 10000 },
  lanes: [{ lane: "STOCK", weightBps: 10000, principal: "0", cap: "10000000000", headroom: "10000000000" }],
  tokens: [{ token: NVDA, symbol: "NVDA", decimals: 18, unit: "1000000000000000000", lane: "STOCK", ceiling: "100000000", allowed: true, uiMultiplier: "2000000000000000000", principal: "0" }],
  shares: { totalSupply: "1000000000000000000000", virtualShares: "1000000000000", price: "1000000", fullPrice: "1000000" },
  totals: { cash: "1000000000", reserveShares: "0", reserveAssets: "0", performingPrincipal: "0", overduePrincipal: "0", fullAssets: "1000000000", totalAssets: "1000000000", lockedProfit: "0", unlockStart: 0, unlockEnd: 0, profitUnlockSeconds: 7 * 86400,
    freeLiquidity: "1000000000", pendingShares: "0", pendingRequestAssets: "0", openRequests: 0, claimableTotal: "0", harvestedCash: "0", assignedCash: "0", accRewardPerShare: "0", rewardRemainder: "0" },
  pockets: [],
};
const approval: EarnApproval = { ...snapshot, dealId: "11", kind: "ERC20", token: NVDA, lane: "STOCK", principal: "1000000000", units: 4, validUntil: NOW + 600, funded: false, revoked: false };
const loan: EarnLoan = {
  ...snapshot, id: "12", dealId: "12", borrower: address(10), kind: "ERC20", token: NVDA, lane: "STOCK",
  principal: "1000000000", cap: "1050000000", collateralAmount: "1000000000000000000",
  positionPrincipal: "1000000000", units: 4, slots: 15, withdrawn: false, overdue: false, carried: "1000000000",
  state: "Claimable", coreState: "ACTIVE", fundingDeadline: NOW - 9 * 86400, fundedAt: NOW - 8 * 86400,
  expiry: NOW - 86400, claimableAt: NOW, settled: false, outcome: null, payout: "0", profit: "0", fee: "0", feeBps: 1000, pocketId: null, pocketIds: [], rewards: "0",
};
const notices: EarnNotice[] = ["repayment", "collateral", "refund", "overdue", "served"].map((kind, i) => ({
  ...snapshot, id: `notice-${i}`, kind: kind as EarnNotice["kind"], account: kind === "served" ? ACCOUNT : STRATEGY, dealId: kind === "served" ? null : "12",
  token: kind === "collateral" ? NVDA : strategy.usdg, amount: kind === "collateral" ? "1000000000000000000" : "1045000000", transactionHash: `0x${"a".repeat(64)}`,
}));
const holder = (account: `0x${string}`, patch: Partial<EarnAccount> = {}): EarnAccount => ({ ...snapshot, account, shares: "1000000000000", lockedShares: "0", freeShares: "1000000000000", value: "1000000", withdrawable: "1000000", claimable: "0", rewards: "0", requests: [], pockets: [], collateralReceived: [], ...patch });
const keeper: EarnKeeperHealth = {
  ok: false, chainId: 46630, strategy: STRATEGY, mode: "execute", lastTickAt: NOW, staleAfterSeconds: 120,
  pendingTransaction: null, failures: [], alerts: ["keeper_revert", "harvest_failed", "reserve_redemption_failed"].map((code, i) => ({
    id: `failure-${i}`, code: code as EarnKeeperHealth["alerts"][number]["code"], action: "unsafe implementation detail vault", strategy: STRATEGY, at: NOW, attempts: 3,
  })),
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "earn-notifier-")); dirs.push(dir);
  const file = join(dir, "notifier.db");
  const state = {
    strategies: [structuredClone(strategy)], approvals: [structuredClone(approval)],
    loans: [structuredClone(loan)], notices: structuredClone(notices), accounts: [holder(ACCOUNT)],
    keeper: structuredClone(keeper), listings: [{ id: "10", engine: strategy.core, loan: { kind: 0, token: NVDA, state: 1 } }, { id: "90", engine: strategy.core, loan: { kind: 0, token: address(90), state: 1 } }],
    funded: [designDeal({ id: "12", lender: STRATEGY, expiry: NOW - 86400, graceEnd: NOW })], now: NOW, unavailable: false,
    wrongPage: false,
  };
  const calls: URL[] = [];
  const respond = (input: Parameters<typeof fetch>[0]): Response => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); calls.push(url);
    if (state.unavailable) return Response.json({}, { status: 503 });
    if (url.pathname === "/health/indexer") return Response.json({ ok: true, chainId: 46630 });
    if (url.pathname === "/deals") return Response.json({ items: state.funded, nextCursor: null });
    if (url.pathname === "/listings") return Response.json({ items: [], nextCursor: null });
    if (url.pathname === "/v2/positions") {
      if (url.searchParams.get("engine") !== strategy.core || url.searchParams.get("state") !== "funding") throw new Error(`Unexpected V2 query ${url.href}`);
      return Response.json({ chainId: 46630, engine: strategy.core, items: state.listings, nextCursor: null });
    }
    if (url.pathname === "/assets") return Response.json({ assets: [] });
    // Routes of a listed non-flagship strategy answer with that strategy's own snapshot and no history.
    const other = state.strategies.find(row => row.address !== STRATEGY && url.pathname.startsWith(`/earn/${row.address}/`));
    if (url.pathname === `/earn/${STRATEGY}/keeper`) return Response.json(state.keeper);
    if (other?.address && url.pathname.endsWith("/keeper")) return Response.json({ ...state.keeper, strategy: other.address, alerts: [] });
    const items = url.pathname === "/earn/strategies" ? state.strategies : other ? [] : url.pathname.endsWith("/approvals") ? state.approvals
      : url.pathname.endsWith("/loans") ? state.loans : url.pathname.endsWith("/events") ? state.notices : url.pathname.endsWith("/accounts") ? state.accounts : undefined;
    if (!items) throw new Error(`Unexpected URL ${url.href}`);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const envelope = other ? { chainId: other.chainId, strategy: other.strategy, blockNumber: other.blockNumber, asOf: other.asOf } : snapshot;
    return Response.json({ ...envelope, blockNumber: state.wrongPage && offset ? "101" : envelope.blockNumber, items: items.slice(offset, offset + 1), nextCursor: offset + 1 < items.length ? String(offset + 1) : null });
  };
  const fetchFn: typeof fetch = input => Promise.resolve(respond(input));
  const { log, lines } = testLogger();
  let db = openDb(file);
  for (const [wallet, channel, destination] of [[CURATOR, "telegram", "222"], [ACCOUNT, "email", "account@example.com"], [STRATEGY, "email", "contract@example.com"]] as const) {
    db.upsertSubscription({ wallet, channel, address: destination, prefs: { ...DEFAULT_PREFS }, createdAt: NOW });
  }
  const channels = consoleChannels(log);
  const indexer = makeIndexer({ baseUrl: "http://indexer.test", fetchFn });
  const create = () => new Poller({ db, indexer, channels, config: testConfig(), log, now: () => state.now });
  let poller = create();
  return { state, calls, indexer, channels, lines, get db() { return db; }, get poller() { return poller; },
    restart() { db.close(); db = openDb(file); poller = create(); }, close() { db.close(); },
    sends() { return lines.filter(row => row.msg === "dry_send"); },
  };
}

describe("Earn notifications", () => {
  it("links to the strategy's published catalog slug and names it, never an address route", () => {
    const options = { appUrl: "https://gage.cash", timezone: "UTC" };
    const expiry = approvalNotice(strategy, approval, NOW, options);
    const served = outcomeNotices(strategy, notices[4]!, [ACCOUNT], options)[0];
    expect(expiry?.message.subject).toBe("Earn · Gage USDG Mix · Approval #11 expires soon");
    expect(expiry?.message.text).toContain("Open the Manage page of Gage USDG Mix.");
    expect(served?.message.text).toContain("is ready to claim from Gage USDG Mix.");
    for (const row of [expiry, served]) {
      expect(row?.message.text).toMatch(/ gage\.cash\/earn\/earn$/);
      expect(row?.message.text).not.toContain(`/earn/${STRATEGY}`);
      expect(violations(row!.message.text)).toEqual([]);
    }
    const stocks: EarnStrategy = { ...strategy, id: "stocks", title: "Gage USDG Stocks", address: address(20), strategy: address(20) };
    expect(approvalNotice(stocks, approval, NOW, options)?.message.text).toMatch(/Earn · Gage USDG Stocks: .* gage\.cash\/earn\/stocks$/);
    const unlisted = { ...strategy, id: undefined, title: undefined } as unknown as EarnStrategy;
    expect(approvalNotice(unlisted, approval, NOW, options)?.message.text).toMatch(/^Earn · the strategy: .* gage\.cash\/earn$/);
    expect(approvalNotice({ ...strategy, id: "0xabc" }, approval, NOW, options)?.message.text).toMatch(/ gage\.cash\/earn$/);
  });

  it("polls every listed strategy, checking each item against its own snapshot and the page's chain", async () => {
    const f = fixture();
    const stocks: EarnStrategy = { ...strategy, id: "stocks", title: "Gage USDG Stocks", address: address(20), strategy: address(20), blockNumber: "98", asOf: NOW - 5, curator: address(21) };
    f.state.strategies.push(stocks);
    expect(await f.indexer.earnStrategies()).toEqual([strategy, stocks]);
    expect((await f.poller.pollOnce()).indexerOk).toBe(true);
    const sent = f.sends();
    expect(sent).toHaveLength(15);
    expect(sent.every(row => String(row.text).endsWith(" gage.cash/earn/earn"))).toBe(true);
    expect(f.calls.filter(url => url.pathname.startsWith(`/earn/${address(20)}/`)).map(url => url.searchParams.get("blockNumber") ?? url.pathname.split("/").at(-1)))
      .toEqual(expect.arrayContaining(["98", "keeper"]));
    f.state.strategies[1] = { ...stocks, chainId: 4663 };
    await expect(f.indexer.earnStrategies()).rejects.toThrow("snapshot changed");
    f.state.strategies[1] = { ...stocks, blockNumber: "" };
    await expect(f.indexer.earnStrategies()).rejects.toThrow("snapshot changed");
    f.close();
  });

  it("describes late USDG repayment as a recovery claim for the original holders", () => {
    const recovered = { ...strategy, pockets: [{ ...snapshot, id: "1", dealId: "12", token: strategy.usdg, amount: "1045000000", supply: "1000000000000000000000", claimed: "0", openedAt: NOW }] };
    const [notice] = outcomeNotices(recovered, notices[0]!, [ACCOUNT], { appUrl: "https://gage.cash", timezone: "UTC" });
    expect(notice?.message.text).toContain("USDG recovery pocket for the holders of record at write-down");
    expect(notice?.message.text).not.toContain("share price");
  });
  it("reads open V2 listings on the strategy's own engine", async () => {
    const f = fixture();
    expect(await f.indexer.earnListings(strategy)).toEqual([
      { id: "10", kind: "ERC20", token: NVDA }, { id: "90", kind: "ERC20", token: address(90) },
    ]);
    f.close();
  });

  it("preserves both LP collateral kinds and excludes unknown V2 kinds", async () => {
    const f = fixture();
    f.state.listings = [
      { id: "10", engine: strategy.core, loan: { kind: 1, token: address(50), state: 1 } },
      { id: "11", engine: strategy.core, loan: { kind: 2, token: address(51), state: 1 } },
      { id: "12", engine: strategy.core, loan: { kind: 3, token: address(52), state: 1 } },
    ];
    expect(await f.indexer.earnListings(strategy)).toEqual([
      { id: "10", kind: "UNIV4_POSITION", token: address(50) },
      { id: "11", kind: "UNIV3_POSITION", token: address(51) },
    ]);
    f.close();
  });

  it.each(["UNIV3_POSITION", "UNIV4_POSITION"] as const)("alerts the curator to %s listings only when the LP category is open", kind => {
    const options = { appUrl: "https://gage.cash", timezone: "UTC" };
    const listing = { id: "13", kind, token: address(50) };
    expect(listingNotice(strategy, listing, options)).toBeUndefined();
    const lpStrategy: EarnStrategy = { ...strategy, lanes: [{ lane: "LP", weightBps: 10000, principal: "0", cap: "10000000000", headroom: "10000000000" }] };
    const notice = listingNotice(lpStrategy, listing, options);
    expect(notice?.wallet).toBe(CURATOR);
    expect(notice?.message.text).toContain("Review its pool, underlying assets and mandate before approving.");
    expect(notice?.message.text).toContain("LP position's underlying assets instead of USDG");
    expect(violations(notice!.message.text)).toEqual([]);
    expect(listingNotice({ ...lpStrategy, lanes: [{ ...lpStrategy.lanes[0]!, weightBps: 0 }] }, listing, options)).toBeUndefined();
    expect(approvalNotice(lpStrategy, { ...approval, kind, lane: "LP" }, NOW, options)?.message.text).toContain("LP position's underlying assets instead of USDG");
  });

  it("describes settled LP collateral as separate underlying pockets", () => {
    const notice = claimableNotice(strategy, { ...loan, kind: "UNIV4_POSITION", lane: "LP", coreState: "DEFAULTED", state: "Collateral", settled: true, pocketId: "1", pocketIds: ["1", "2"] }, NOW, { appUrl: "https://gage.cash", timezone: "UTC" });
    expect(notice?.message.text).toContain("Its underlying assets were recovered into separate side pockets for the holders of record.");
  });

  it("uses recovered underlying metadata without requiring an ERC20 loan admission", () => {
    const underlying = address(60);
    const lpStrategy: EarnStrategy = { ...strategy, pockets: [{ ...snapshot, id: "3", dealId: "12", token: underlying, amount: "4500000", supply: "1000", claimed: "0", openedAt: NOW, metadata: { symbol: "USDC", decimals: 6, uiMultiplier: "1000000000000000000" } }] };
    const [notice] = outcomeNotices(lpStrategy, { ...notices[1]!, token: underlying, amount: "4500000" }, [ACCOUNT], { appUrl: "https://gage.cash", timezone: "UTC" });
    expect(notice?.message.text).toContain("4.5 USDC was recovered into a side pocket");
  });

  it("delivers every LP underlying recovery once, including native ETH and USDG", async () => {
    const f = fixture();
    f.state.listings = []; f.state.approvals = []; f.state.keeper.alerts = []; f.state.loans = [];
    const collateral = notices.find(notice => notice.kind === "collateral")!;
    f.state.notices = [
      { ...collateral, id: "lp-pocket-1", token: address(0), amount: "1500000000000000000" },
      { ...collateral, id: "lp-pocket-2", token: strategy.usdg, amount: "2000000" },
    ];
    expect((await f.poller.pollOnce()).dry).toBe(4);
    expect(f.sends().map(row => row.text).filter(text => String(text).includes("1.5 ETH was recovered"))).toHaveLength(2);
    expect(f.sends().map(row => row.text).filter(text => String(text).includes("2 USDG was recovered"))).toHaveLength(2);
    f.restart();
    expect((await f.poller.pollOnce()).dry).toBe(0);
    expect(f.sends()).toHaveLength(4);
    f.close();
  });

  it("reads a complete large history without truncating after 200 pages", async () => {
    const indexer = makeIndexer({ baseUrl: "http://indexer.test", fetchFn: input => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/keeper")) return Promise.resolve(Response.json(keeper));
      const page = Number(url.searchParams.get("cursor") ?? 0);
      return Promise.resolve(Response.json({ ...snapshot, items: url.pathname.endsWith("/approvals") ? [{ ...approval, dealId: String(page) }] : [],
        nextCursor: url.pathname.endsWith("/approvals") && page < 200 ? String(page + 1) : null }));
    } });
    expect((await indexer.earnNotifications(strategy)).approvals).toHaveLength(201);
  });

  it("delivers all eleven kinds once across two polls and a persisted restart, to the curator, holders or requester", async () => {
    const f = fixture();
    expect((await f.poller.pollOnce()).dry).toBe(15);
    expect((await f.poller.pollOnce()).dry).toBe(0);
    f.restart();
    expect((await f.poller.pollOnce()).dry).toBe(0);
    const sent = f.sends();
    expect(sent.filter(row => row.channel === "telegram")).toHaveLength(10);
    expect(sent.filter(row => row.channel === "email")).toHaveLength(5);
    const text = sent.map(row => String(row.text)).join("\n");
    for (const phrase of ["New listing #10", "Approval #11", "Loan #12 is claimable", "Keeper action failed", "Collection failed", "External lending withdrawal failed", "Repayment received", "Collateral received", "Commitment refunded", "Loan #12 is overdue", "Request served"]) expect(text).toContain(phrase);
    expect(text).toContain("2 NVDA");
    expect(text).toContain("over 7 days");
    expect(text).not.toContain("yours to claim");
    expect(text).not.toContain("#90");
    expect(violations(text)).toEqual([]);
    expect(text).not.toMatch(/\block\b/i);
    for (const path of ["loans", "events", "accounts"]) {
      const pages = f.calls.filter(url => url.pathname.endsWith(`/${path}`));
      expect(pages.every(url => url.searchParams.get("blockNumber") === "100" && url.searchParams.get("limit") === "100")).toBe(true);
    }
    expect(f.calls.filter(url => url.pathname.endsWith("/events")).some(url => url.searchParams.has("cursor"))).toBe(true);
    expect(await f.indexer.health()).toEqual({ ok: true, chainId: 46630 });
    f.close();
  });

  it("fans strategy-wide outcomes out to holders of shares, served USDG or pocket entitlements, and served requests to the requester only", async () => {
    const f = fixture();
    f.state.listings = []; f.state.approvals = []; f.state.loans = []; f.state.keeper.alerts = [];
    f.state.notices = notices.filter(notice => notice.kind === "collateral" || notice.kind === "served");
    f.state.accounts = [holder(ACCOUNT), holder(address(21), { shares: "0", freeShares: "0", value: "0", withdrawable: "0", pockets: [{ pocketId: "1", dealId: "12", token: NVDA, claimable: "5", claimed: false, balanceAt: "7" }] }), holder(address(22), { shares: "0", freeShares: "0", value: "0", withdrawable: "0" })];
    for (const wallet of [address(21), address(22)]) f.db.upsertSubscription({ wallet, channel: "email", address: `${wallet}@example.com`, prefs: { ...DEFAULT_PREFS }, createdAt: NOW });
    expect((await f.poller.pollOnce()).dry).toBe(4);
    const destinations = f.sends().map(row => String(row.to));
    expect(destinations.some(to => to.includes(address(22)))).toBe(false);
    expect(destinations.filter(to => to.includes(address(21)))).toHaveLength(1);
    expect(f.sends().filter(row => String(row.text).includes("Request served"))).toHaveLength(1);
    f.close();
  });

  it("waits for the ten-minute boundary and suppresses funded, revoked, expired, nonclaimable and de-admitted rows", async () => {
    const f = fixture();
    f.state.approvals = [
      { ...approval, validUntil: NOW + 601 }, { ...approval, dealId: "21", funded: true },
      { ...approval, dealId: "22", revoked: true }, { ...approval, dealId: "23", validUntil: NOW },
    ];
    f.state.loans = [{ ...loan, state: "Overdue", claimableAt: NOW + 1 }, { ...loan, id: "22", dealId: "22", state: "Settling", coreState: "REPAID" }, { ...loan, id: "24", dealId: "24", state: "Funding", coreState: "FUNDING", fundedAt: 0, claimableAt: 0 }, { ...loan, id: "25", dealId: "25", state: "Settling", withdrawn: true }];
    f.state.notices = []; f.state.keeper.alerts = []; f.state.strategies[0]!.tokens[0]!.ceiling = "0";
    expect((await f.poller.pollOnce()).dry).toBe(0);
    f.state.now += 1;
    expect((await f.poller.pollOnce()).dry).toBe(2);
    f.close();
  });

  it("reports claimable time once even when the keeper settled the default before the first poll", async () => {
    const f = fixture();
    f.state.listings = []; f.state.approvals = []; f.state.keeper.alerts = []; f.state.notices = [];
    f.state.loans = [{ ...loan, state: "Collateral", coreState: "DEFAULTED", settled: true, outcome: "collateral", carried: "0", pocketId: "1", pocketIds: ["1"] },
      { ...loan, id: "13", dealId: "13", state: "Repaid", coreState: "REPAID", settled: true, outcome: "cash", carried: "0" }];
    expect((await f.poller.pollOnce()).dry).toBe(1);
    expect(f.sends()[0]!.text).toContain("Loan #12 reached claimable time");
    expect(f.sends()[0]!.text).toContain("recovered into a side pocket for the holders of record");
    expect((await f.poller.pollOnce()).dry).toBe(0);
    f.restart(); expect((await f.poller.pollOnce()).dry).toBe(0);
    f.close();
  });

  it("does not repeat an earlier claimable alert after the keeper settles collateral", async () => {
    const f = fixture();
    f.state.listings = []; f.state.approvals = []; f.state.keeper.alerts = []; f.state.notices = [];
    expect((await f.poller.pollOnce()).dry).toBe(1);
    f.state.loans = [{ ...loan, state: "Collateral", coreState: "DEFAULTED", settled: true, outcome: "collateral", carried: "0", pocketId: "1", pocketIds: ["1"] }];
    f.restart(); expect((await f.poller.pollOnce()).dry).toBe(0);
    f.close();
  });

  it("describes a side pocket truthfully after a holder already claimed their part", async () => {
    const f = fixture();
    f.state.listings = []; f.state.approvals = []; f.state.keeper.alerts = []; f.state.loans = [];
    f.state.notices = notices.filter(notice => notice.kind === "collateral");
    expect((await f.poller.pollOnce()).dry).toBe(2);
    for (const row of f.sends()) {
      expect(row.text).toContain("was recovered into a side pocket for the holders of record");
      expect(row.text).not.toContain("is available to claim");
    }
    f.close();
  });

  it("describes a served request truthfully after the requester already claimed the USDG", async () => {
    const f = fixture();
    f.state.listings = []; f.state.approvals = []; f.state.keeper.alerts = []; f.state.loans = [];
    f.state.notices = notices.filter(notice => notice.kind === "served");
    expect((await f.poller.pollOnce()).dry).toBe(1);
    expect(f.sends()[0]!.text).toContain("is ready to claim from Gage USDG Mix");
    expect(f.sends()[0]!.channel).toBe("email");
    f.close();
  });

  it("persists a failed approval envelope across restart and expiry, retries during indexer outage, then stops", async () => {
    const f = fixture();
    f.state.listings = []; f.state.loans = []; f.state.notices = []; f.state.keeper.alerts = [];
    const send = f.channels.telegram.send.bind(f.channels.telegram);
    let attempts = 0;
    f.channels.telegram.send = async (destination, message) => { attempts += 1; if (attempts === 1) throw new Error("temporary transport failure"); return send(destination, message); };
    expect((await f.poller.pollOnce()).failed).toBe(1);
    expect(attempts).toBe(1);
    f.state.now += 601; f.state.unavailable = true; f.restart();
    expect((await f.poller.pollOnce()).retried).toBe(1);
    expect(f.sends()).toHaveLength(1);
    f.restart();
    await f.poller.pollOnce();
    expect(attempts).toBe(2);
    f.close();
  });

  it("honors expiry preferences and unsubscribing even for persisted retries", async () => {
    const f = fixture();
    f.db.upsertSubscription({ wallet: CURATOR, channel: "telegram", address: "222", prefs: { ...DEFAULT_PREFS, expiry: false }, createdAt: NOW });
    expect((await f.poller.pollOnce()).dry).toBe(5);
    f.db.upsertSubscription({ wallet: CURATOR, channel: "telegram", address: "222", prefs: { ...DEFAULT_PREFS }, createdAt: NOW });
    f.channels.telegram.send = () => Promise.reject(new Error("temporary failure"));
    expect((await f.poller.pollOnce()).failed).toBe(10);
    f.db.deleteSubscription(CURATOR, "telegram"); f.restart();
    expect((await f.poller.pollOnce()).failed).toBe(0);
    expect(f.db.countPending(5)).toBe(0);
    f.close();
  });

  it("rejects a mixed-block response before delivering any Earn message", async () => {
    const f = fixture(); f.state.wrongPage = true;
    expect((await f.poller.pollOnce()).indexerOk).toBe(false);
    expect(f.sends()).toHaveLength(0);
    f.close();
  });

  it("drops a persisted legacy grace-end alert addressed to the strategy contract", async () => {
    const f = fixture();
    const sub = f.db.listSubscriptions(STRATEGY)[0]!;
    const item = { key: `claimable:12:${STRATEGY}:email`, kind: "claimable", ref: "deal:12", sub, message: { subject: "Old lender alert", text: "The collateral is yours to claim." } };
    f.db.record({ key: item.key, kind: item.kind, ref: item.ref, wallet: STRATEGY, channel: "email", status: "failed", error: "old delivery error", sentAt: NOW - 1 });
    f.db.setKv(`message:${item.key}`, JSON.stringify(item));
    f.restart();
    await f.poller.pollOnce();
    expect(f.sends().some(row => String(row.text).includes("yours to claim"))).toBe(false);
    expect(f.db.getSent(item.key)?.status).toBe("skipped");
    f.close();
  });

  it("stops at the configured attempt limit even while an approval is still visible", async () => {
    const f = fixture();
    f.state.listings = []; f.state.loans = []; f.state.notices = []; f.state.keeper.alerts = [];
    let attempts = 0;
    f.channels.telegram.send = () => { attempts += 1; return Promise.reject(new Error("provider down")); };
    for (let i = 0; i < 8; i += 1) { await f.poller.pollOnce(); f.restart(); }
    expect(attempts).toBe(5);
    expect(f.db.countPending(5)).toBe(0);
    f.close();
  });

  it("rejects the wrong chain or stale strategy before delivering any Earn message", async () => {
    const f = fixture(); f.state.strategies[0]!.chainId = 4663;
    expect((await f.poller.pollOnce()).indexerOk).toBe(false);
    expect(f.sends()).toHaveLength(0);
    f.state.strategies[0]!.chainId = 46630; f.state.strategies[0]!.asOf = NOW - 3600;
    expect((await f.poller.pollOnce()).indexerOk).toBe(false);
    expect(f.sends()).toHaveLength(0);
    f.close();
  });
});
