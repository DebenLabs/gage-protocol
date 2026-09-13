import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import type { Indexer, IndexedDeal, PoolResponse } from "../src/indexer.js";
import { Poller } from "../src/poller.js";
import { DEFAULT_PREFS } from "../src/prefs.js";
import { consoleChannels, designDeal, EXPIRY, GRACE_END, nvdaAsset, testConfig, testLogger } from "./helpers.js";

const H = 3_600;

function fakeIndexer(state: { deals: IndexedDeal[]; pool: PoolResponse }): Indexer {
  return {
    fundedDeals: () => Promise.resolve(state.deals),
    listings: () => Promise.resolve([]),
    earnStrategies: () => Promise.resolve([]),
    earnListings: () => Promise.resolve([]),
    earnNotifications: () => Promise.reject(new Error("no strategy configured")),
    pool: () => Promise.resolve(state.pool),
    epochs: () => Promise.resolve([]),
    assets: () => Promise.resolve([nvdaAsset]),
    health: () => Promise.resolve({ ok: true }),
  };
}

function setup(now: { t: number }) {
  const { log, lines } = testLogger();
  const db = openDb(":memory:");
  const deal = designDeal();
  const state = { deals: [deal], pool: { epoch: undefined, budgets: undefined } as PoolResponse };
  db.upsertSubscription({ wallet: deal.borrower as `0x${string}`, channel: "telegram", address: "111", prefs: { ...DEFAULT_PREFS, epoch: true, budget: true }, createdAt: 0 });
  db.upsertSubscription({ wallet: deal.lender as `0x${string}`, channel: "email", address: "lender@example.com", prefs: { ...DEFAULT_PREFS }, createdAt: 0 });
  const poller = new Poller({ db, indexer: fakeIndexer(state), channels: consoleChannels(log), config: testConfig(), log, walletUSDG: () => Promise.resolve(2_102_400_000n), now: () => now.t });
  const sent = () => lines.filter((l) => l.msg === "dry_send").map((l) => `${String(l.channel)}:${String(l.text)}`);
  return { poller, state, db, lines, sent };
}

describe("Poller", () => {
  it("sends each reminder once to the borrower and the after-grace notice once to the lender", async () => {
    const now = { t: EXPIRY - 47 * H };
    const { poller, sent } = setup(now);
    expect((await poller.pollOnce()).dry).toBe(1);
    expect((await poller.pollOnce()).dry).toBe(0);
    expect(sent()).toEqual(["telegram:#4821 · 12.5 NVDA expires 8 Sep 16:40 UTC. Reclaim for 1,824.00 USDG before 9 Sep 16:40, or walk away and keep 1,814.88. gage.cash/deal/4821"]);

    now.t = EXPIRY - 24 * H;
    await poller.pollOnce();
    expect(sent().at(-1)).toBe("telegram:#4821 expires in 24 h. Reclaim 1,824.00 USDG or walk away. Wallet has 2,102.40. gage.cash/deal/4821");

    now.t = EXPIRY + 60;
    const s = await poller.pollOnce();
    expect(s.dry).toBe(1);
    expect(s.skipped).toBe(2); // t6 and t1 were never reached while running: skipped, never sent late
    expect(sent().at(-1)).toContain("#4821 · 12.5 NVDA expired 8 Sep 16:40 UTC. Grace runs to 9 Sep 16:40 UTC");

    now.t = GRACE_END;
    expect((await poller.pollOnce()).dry).toBe(1);
    expect(sent().at(-1)).toBe("email:#4821 · the borrower walked away, so 12.5 NVDA is yours to claim.");
    expect((await poller.pollOnce()).dry).toBe(0);
  });

  it("stops when the deal leaves FUNDED and keeps polling when the indexer is down", async () => {
    const now = { t: EXPIRY - 47 * H };
    const { poller, state, sent } = setup(now);
    state.deals = [];
    expect((await poller.pollOnce()).dry).toBe(0);
    expect(sent()).toEqual([]);
    const broken: Indexer = { ...fakeIndexer(state), fundedDeals: () => Promise.reject(new Error("ECONNREFUSED")) };
    const p2 = new Poller({ db: openDb(":memory:"), indexer: broken, channels: consoleChannels(testLogger().log), config: testConfig(), log: testLogger().log });
    const stats = await p2.pollOnce();
    expect(stats.indexerOk).toBe(false);
    expect(p2.status.lastError).toContain("ECONNREFUSED");
  });

  it("announces an epoch roll once, and a fully allocated budget once per term and epoch", async () => {
    const now = { t: EXPIRY - 100 * H };
    const { poller, state, sent } = setup(now);
    const epoch = { n: 36, startsAt: 0, endsAt: 604_800, dealBudget7: "0", dealBudget21: "0", released: true };
    state.pool = { epoch, budgets: { dealsRemaining7: "0", dealsRemaining21: "5", liquidity: "1" } };
    await poller.pollOnce(); // first sighting records the epoch; the budget notice goes out
    expect(sent().filter((s) => s.includes("fully allocated"))).toHaveLength(1);
    await poller.pollOnce();
    expect(sent().filter((s) => s.includes("fully allocated"))).toHaveLength(1);
    state.pool = { epoch: { ...epoch, n: 37, startsAt: 604_800, endsAt: 2 * 604_800, dealBudget7: "1000000000000000000000000" }, budgets: { dealsRemaining7: "1", dealsRemaining21: "1", liquidity: "1" } };
    await poller.pollOnce();
    await poller.pollOnce();
    expect(sent().filter((s) => s.includes("Week 37 opens"))).toEqual(["telegram:Week 37 opens 8 Jan 00:00 UTC · 1.00M sGAGE for deals this week, 1.00M on 7 days and 0 on 21 days. gage.cash/rewards"]);
  });
});
