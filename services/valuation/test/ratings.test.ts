import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { SampleStore } from "../src/facts/store.js";
import { Pricer } from "../src/pricing/pricer.js";
import { assessMarket, coverageGrade, GRADES, headroom, headroomGrade, horizonSigma, MODEL, notchUp, slice, stressScenarios, stressShocks, stressVolatility,
  volatilityScore, type Grade, type MarketEvidence } from "../src/ratings/model.js";
import { evaluateOutcomes, wilson, type Outcome } from "../src/ratings/calibration.js";
import { RatingStore } from "../src/ratings/store.js";
import { A, FakeReader, FakeExplorer, FakeIndexer, fixtureDeployment, NVDA_KEY, POOL_ID } from "./helpers/fake.js";

const now = Math.floor(Date.now() / 1000);
const good: MarketEvidence = { price: "0.00123", depth: "5000000000000", mcap: "100000000000000", ageDays: 400,
  volatility: 0.5, topTen: 0.08, at: now, decimals: 6 };
const rank = (grade: string) => GRADES.indexOf(grade as Grade & typeof GRADES[number]);
function build(): AppDeps {
  const reader = new FakeReader(), deployment = fixtureDeployment();
  return { reader, pricer: new Pricer(reader, deployment), deployment, explorer: new FakeExplorer(), indexer: new FakeIndexer(),
    store: SampleStore.inMemory(), sampler: null, config: { knownLockers: [], rangeSigmaMultiplier: 1.5, factsTtlMs: 60000 }, log: () => {} };
}
/** Five days of hourly samples with alternating moves whose realised volatility annualises exactly to `annualised`. */
function seedSamples(store: SampleStore, token: string, annualised: number): void {
  const hourly = annualised / Math.sqrt(365 * 24);
  let price = 100;
  for (let i = 5 * 24; i >= 0; i--) {
    store.addTokenSample(token, { at: now - i * 3600, priceUSDG: price.toFixed(8), mcapUSDG: "0" });
    price *= Math.exp(i % 2 ? hourly : -hourly);
  }
}
describe("advisory ratings", () => {
  it("supports sub-cent prices, reserves the top bands and does not turn missing data into safety", () => {
    expect(assessMarket(good, now).grade).toBe("BBB");
    expect(assessMarket({ ...good, depth: null }, now).grade).toBe("NR");
    expect(assessMarket({ ...good, at: now - 601 }, now).grade).toBe("NR");
    // Missing holder data lowers confidence; it neither invents a poor observation nor caps a measured market.
    expect(assessMarket({ ...good, topTen: null }, now)).toMatchObject({ grade: "BBB", confidence: "low" });
    // Unmeasured volatility is the gap that caps the baseline: an unknown market is scored neither calm nor wild.
    const unmeasured = assessMarket({ ...good, volatility: null }, now);
    expect(unmeasured.factors[3]?.score).toBeNull();
    expect(unmeasured).toMatchObject({ grade: "B", confidence: "low" });
    expect(assessMarket({ ...good, volatility: -1 }, now).factors[3]?.score).toBeNull();
  });
  it("cannot improve with less liquidity or more volatility", () => {
    const before = assessMarket(good, now).grade;
    for (const depth of ["4000000000000", "10000000000", "0"]) expect(rank(assessMarket({ ...good, depth }, now).grade)).toBeGreaterThanOrEqual(rank(before));
    for (const volatility of [1, 3, 8, 20]) expect(rank(assessMarket({ ...good, volatility }, now).grade)).toBeGreaterThanOrEqual(rank(before));
    expect(volatilityScore(0.15)).toBe(100);
    expect(volatilityScore(15)).toBe(0);
    expect(volatilityScore(1.5)).toBeCloseTo(50, 6);
    expect(coverageGrade(49n, 100n)).toBe("C");
    expect(coverageGrade(150n, 100n)).toBe("BBB");
  });
  it("grades a loan by its headroom before loss in standard deviations of the horizon", () => {
    expect(headroomGrade(2.5)).toBe("BBB");
    expect(headroomGrade(2)).toBe("BB");
    expect(headroomGrade(1.5)).toBe("B");
    expect(headroomGrade(1)).toBe("CCC");
    expect(headroomGrade(0.5)).toBe("CC");
    expect(headroomGrade(0.49)).toBe("C");
    expect(headroomGrade(-3)).toBe("C");
    expect(headroomGrade(null)).toBe("NR");
    // Nine days at 30% annualised: a 12.8% cushion is 2.7 sigmas; at 300% it is 0.27 sigmas.
    expect(horizonSigma(0.3, 9 * 86_400)).toBeCloseTo(0.0471, 4);
    expect(headroom(100n, 88n, horizonSigma(0.3, 9 * 86_400))).toBeCloseTo(2.71, 2);
    expect(headroom(100n, 88n, horizonSigma(3, 9 * 86_400))).toBeCloseTo(0.27, 2);
    expect(headroom(88n, 100n, 0.05)).toBeLessThan(0);
    expect(headroom(0n, 100n, 0.05)).toBe(-Infinity);
    expect(headroom(100n, 50n, 0)).toBe(Infinity);
    expect(headroom(100n, 0n, 0.05)).toBeNull();
    // Lane floors and fallbacks are policy, not observations: measured evidence above the floor passes through.
    expect(stressVolatility("STOCK", 0.05)).toEqual({ annualised: 0.3, source: "floor" });
    expect(stressVolatility("STOCK", 0.64)).toEqual({ annualised: 0.64, source: "measured" });
    expect(stressVolatility("STOCK", null)).toEqual({ annualised: 0.45, source: "fallback" });
    expect(stressVolatility("MEME", 2.5)).toEqual({ annualised: 2.5, source: "measured" });
    expect(stressVolatility(null, undefined)).toEqual({ annualised: 3, source: "fallback" });
    expect(stressVolatility("ETH", 0.46)).toEqual({ annualised: 0.5, source: "floor" });
    expect(notchUp("CCC")).toBe("B");
    expect(notchUp("BBB")).toBe("BBB");
    expect(notchUp("NR")).toBe("NR");
  });
  it("does not equate a stock's token float, pool age or missing holders with a distressed company", () => {
    const liveStock = { ...good, profile: "stock" as const, mcap: "5000000000000", ageDays: null, topTen: null, volatility: null };
    const result = assessMarket(liveStock, now);
    expect(result.grade).toBe("BB");
    expect(result.confidence).toBe("low");
    expect(result.factors.map(f => f.name)).toEqual(["Active liquidity · proxy", "Stock-token volatility · 30d"]);
    expect(assessMarket({ ...liveStock, mcap: "1", ageDays: 0, topTen: 1 }, now).grade).toBe("BB");
    expect(assessMarket({ ...liveStock, profile: "token" }, now).grade).toBe("B");
    expect(assessMarket({ ...liveStock, depth: "5000000000" }, now).grade).toBe("C");
    expect(assessMarket({ ...liveStock, depth: null }, now).grade).toBe("NR");
    expect(assessMarket({ ...liveStock, at: now - 601 }, now).grade).toBe("NR");
    expect(assessMarket({ ...good, profile: "stock" }, now)).toMatchObject({ grade: "BBB", confidence: "moderate" });
    expect(assessMarket({ ...good, profile: "stock", volatility: 10 }, now).grade).toBe("CC");
    // The issuer market is a second exit: a stock sits one band above its on-chain liquidity band, a token does not.
    expect(assessMarket({ ...good, profile: "stock", depth: "20000000000" }, now).grade).toBe("CCC");
    expect(assessMarket({ ...good, depth: "20000000000" }, now).grade).toBe("CC");
  });
  it("separates strong observed token markets from thin markets despite identical data gaps", () => {
    const missing = { ...good, ageDays: null, topTen: null, volatility: null };
    // Recorded live snapshots: AI ~5m liquidity/298m float; BONER ~1.87m/37.8m (USDG).
    expect(assessMarket({ ...missing, depth: "4998233488816", mcap: "297716094553716" }, now).grade).toBe("B");
    expect(assessMarket({ ...missing, depth: "1869990461936", mcap: "37822217162536" }, now).grade).toBe("B");
    // Measured 493% volatility (AI, September 2026) keeps it at B on its own evidence; a calm liquid token can pass.
    expect(assessMarket({ ...missing, depth: "4998233488816", mcap: "297716094553716", volatility: 4.93 }, now)).toMatchObject({ grade: "B", confidence: "low" });
    expect(assessMarket({ ...good, volatility: 0.6 }, now)).toMatchObject({ grade: "BBB", confidence: "moderate" });
    expect(assessMarket({ ...missing, depth: "94299506820", mcap: "54963437207204", ageDays: 6.84 }, now).grade).toBe("CCC");
    expect(assessMarket({ ...missing, depth: "20000000000", mcap: "500000000000" }, now).grade).toBe("CC");
    // Even immense token market cap cannot raise a 20k liquidity market above CC.
    expect(assessMarket({ ...good, depth: "20000000000" }, now).grade).toBe("CC");
    expect(assessMarket({ ...missing, depth: "5000000000" }, now).grade).toBe("C");
  });
  it("uses exact pool liquidity as a constraint without invented missing token fundamentals", () => {
    const pool = { ...good, profile: "pool" as const, mcap: null, ageDays: null, volatility: null, topTen: null };
    expect(assessMarket(pool, now).grade).toBe("BBB");
    expect(assessMarket({ ...pool, depth: "5000000000" }, now).grade).toBe("C");
  });
  it("rewards liquidity relative to token size without overriding absolute exit limits", () => {
    const base = { ...good, depth: "800000000000", ageDays: 30, volatility: null, topTen: null };
    const liquid = assessMarket({ ...base, mcap: "14000000000000" }, now);
    const smallRatio = assessMarket({ ...base, mcap: "1400000000000000" }, now);
    expect(liquid.factors[5]?.score).toBeGreaterThan(smallRatio.factors[5]!.score!);
    expect(liquid.grade).toBe("B");
    expect(assessMarket({ ...base, depth: "20000000000", mcap: "200000000000" }, now).grade).toBe("CC");
  });
  it("bounds direct, LP and claim liquidity by exact reported quantities and fails to NR when that source is lost", async () => {
    const deps = build();
    deps.deployment.chainId = 4663;
    deps.reader.chainId = async () => 4663;
    deps.ratingStockLookup = async () => ({ kind: "stock", symbol: "NVDA", active: true, checkedAt: now });
    deps.ratingReserveLookup = async (_chain, pool) => pool.poolId === POOL_ID.nvdaUsdg
      ? { amount0: 10_000, amount1: 100, createdAt: null, checkedAt: now } : null;
    const app = createApp(deps);
    for (const query of [`token=${A.NVDAx}`, `poolId=${POOL_ID.nvdaUsdg}`,
      `token=${A.NVDAx}&mode=lender-sale&collateral=1000000000000000000&principal=1000000&repayment=1100000&term=604800&ask=500000&mask=15`]) {
      const response = await app.request(`/ratings/assessment?${query}`);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ grade: "CC", evidence: { [A.NVDAx]: { reportedDepth: "20000000000" } } });
    }
    for (const unavailable of [null, { amount0: 10_000, amount1: 100, createdAt: null, checkedAt: now - 601 }]) {
      deps.ratingReserveLookup = async () => unavailable;
      for (const query of [`token=${A.NVDAx}`, `poolId=${POOL_ID.nvdaUsdg}`]) {
        expect(await (await createApp(deps).request(`/ratings/assessment?${query}`)).json()).toMatchObject({ grade: "NR" });
      }
    }
  });
  it("applies the verified stock profile to direct collateral and LP legs and stresses the loan by the stock's own volatility", async () => {
    const deps = build();
    deps.ratingStockLookup = async (_chain, token) => token === A.NVDAx
      ? { kind: "stock", symbol: "NVDA", active: true, checkedAt: now } : { kind: "other" };
    const app = createApp(deps);
    const baseline = await (await app.request(`/ratings/assessment?token=${A.NVDAx}`)).json();
    expect(baseline).toMatchObject({ grade: "BB", confidence: "low", evidence: { [A.NVDAx]: { profile: "stock", lane: "STOCK", stressVolatility: { annualised: 0.45, source: "fallback" } } } });
    const pool = await (await app.request(`/ratings/assessment?poolId=${POOL_ID.nvdaUsdg}`)).json();
    expect(pool).toMatchObject({ grade: "BB" });
    // One NVDAx is 100 USDG in the fixture: the app's default 88% stock loan for seven days, plus two days of grace.
    type Loan = { grade: string; marketGrade: string; scenarios: { shock: number; sigmas: number }[]; factors: { name: string; value: string | null }[] };
    const loan = `token=${A.NVDAx}&mode=loan&collateral=1000000000000000000&principal=88000000&repayment=90200000&term=604800`;
    const unmeasured = await (await app.request(`/ratings/assessment?${loan}`)).json() as Loan;
    // Fallback 45% annualised over nine days is a 7.1% sigma, so 12.8% of headroom is 1.8 sigmas: B, not the old flat-shock CC.
    expect(unmeasured).toMatchObject({ grade: "B", marketGrade: "BB" });
    expect(unmeasured.scenarios.map(s => s.sigmas)).toEqual([0, 1, 2, 3]);
    expect(unmeasured.scenarios[2]!.shock).toBeCloseTo(13.2, 1);
    expect(unmeasured.factors.find(f => f.name === "Stress horizon")?.value).toBe("9 days");
    expect(unmeasured.factors.find(f => f.name === "Stress volatility")?.value).toBe("45% annualised · fallback");
    expect(unmeasured.factors.find(f => f.name === "Headroom before loss")?.value).toBe("1.8σ · 12.0% fall");
    // Measured calm history: 20% annualised is raised to the 30% stock floor; the same loan is then 2.7 sigmas from loss.
    seedSamples(deps.store, A.NVDAx, 0.2);
    const measured = await (await createApp(deps).request(`/ratings/assessment?${loan}`)).json() as Loan & { evidence: Record<string, unknown> };
    expect(measured).toMatchObject({ evidence: { [A.NVDAx]: { stressVolatility: { annualised: 0.3, source: "floor" } } } });
    expect(measured.factors.find(f => f.name === "Headroom before loss")?.value).toBe("2.7σ · 12.0% fall");
    expect(measured.grade).toBe(measured.marketGrade);
    expect(rank(measured.grade)).toBeLessThanOrEqual(rank("BB"));
    // A longer term lowers the headroom instead of a fixed term cap: 21 days plus grace leaves 1.7 sigmas.
    expect(await (await createApp(deps).request(`/ratings/assessment?${loan.replace("term=604800", "term=1814400")}`)).json()).toMatchObject({ grade: "B" });
    deps.ratingStockLookup = async () => ({ kind: "unavailable" });
    expect(await (await createApp(deps).request(`/ratings/assessment?token=${A.NVDAx}`)).json()).toMatchObject({ grade: "NR" });
    deps.ratingStockLookup = async () => ({ kind: "stock", symbol: "NVDA", active: false, checkedAt: now });
    expect(await (await createApp(deps).request(`/ratings/assessment?token=${A.NVDAx}`)).json()).toMatchObject({ grade: "NR" });
  });
  it("preserves every raw unit across quarter masks and measures loss at the buyer's price", () => {
    for (let total = 1n; total < 25n; total++) {
      expect(slice(total, 1) + slice(total, 2) + slice(total, 4) + slice(total, 8)).toBe(total);
      expect(slice(total, 5) + slice(total, 10)).toBe(total);
    }
    expect(() => slice(1n, 0)).toThrow();
    const shocks = stressShocks(Math.log(2) / 2);
    expect(shocks.map(s => s.shock)).toEqual([0, 29.3, 50, 64.6]);
    expect(stressScenarios(bps => 200n * BigInt(10_000 - bps) / 10_000n, 120n, shocks)[2]).toEqual({ shock: 50, sigmas: 2, value: "100", coverageBps: "8333", shortfall: "20" });
    expect(stressShocks(0).map(s => s.shock)).toEqual([0, 0.1, 0.1, 0.1]);
    expect(stressShocks(40).map(s => s.shock)).toEqual([0, 99.9, 99.9, 99.9]);
  });
  it("stresses a meme by its own volatility, so the same terms on a wild token grade far below a calm stock", async () => {
    const deps = build();
    (deps.reader as FakeReader).configs.set(A.NVDAx, { allowed: true, lane: "MEME", minAmount: 1n, maxDealRaw: 10n ** 30n, maxOpenRaw: 10n ** 32n });
    seedSamples(deps.store, A.NVDAx, 3);
    const app = createApp(deps);
    type Loan = { grade: string; marketGrade: string; scenarios: { shock: number; sigmas: number }[]; factors: { name: string; value: string | null }[] };
    const terms = `token=${A.NVDAx}&mode=loan&collateral=1000000000000000000&repayment=90200000&term=604800`;
    const wild = await (await app.request(`/ratings/assessment?${terms}&principal=88000000`)).json() as Loan & { evidence: Record<string, { stressVolatility: { annualised: number } }> };
    // 300% annualised over nine days is a 47% sigma: 12.8% of headroom is 0.27 sigmas, and a two-sigma fall is 61%.
    expect(wild).toMatchObject({ grade: "C", evidence: { [A.NVDAx]: { profile: "token", lane: "MEME", stressVolatility: { source: "measured" } } } });
    expect(wild.evidence[A.NVDAx]!.stressVolatility.annualised).toBeCloseTo(3, 6);
    expect(wild.scenarios[2]!.shock).toBeCloseTo(61, 0);
    expect(wild.factors.find(f => f.name === "Headroom before loss")?.value).toBe("0.3σ · 12.0% fall");
    // Half the value borrowed is 1.5 sigmas: CCC, unless the market baseline is worse.
    const half = await (await app.request(`/ratings/assessment?${terms}&principal=50000000`)).json() as Loan;
    expect(rank(half.grade)).toBeLessThan(rank("C"));
    expect(half.factors.find(f => f.name === "Headroom before loss")?.value).toBe("1.5σ · 50.0% fall");
    // A funded loan is stressed over the time left until lenders can finalize, never less than a day.
    const closing = await (await app.request(`/ratings/assessment?${terms}&principal=50000000&endAt=${now + 3600}`)).json() as Loan;
    expect(closing.factors.find(f => f.name === "Stress horizon")?.value).toBe("1 day");
    expect(rank(closing.grade)).toBeLessThanOrEqual(rank(half.grade));
  });
  it("serves source-qualified market/loan previews with CORS and never reads legacy deal IDs", async () => {
    const deps = build();
    const app = createApp(deps);
    const query = `token=${A.NVDAx}&mode=loan&collateral=1000000000000000000&principal=1000000&repayment=1100000&term=604800&loanId=99`;
    const response = await app.request(`/ratings/assessment?${query}`, { headers: { Origin: "http://localhost:3000" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(await response.json()).toMatchObject({ model: MODEL, engine: deps.deployment.dealVault, label: "Borrow rating", economics: { cost: "1000000", repayment: "1100000" } });
    expect((await app.request(`/ratings/assessment?token=${A.NVDAx}&engine=${A.alice}`)).status).toBe(404);
    expect((await app.request(`/ratings/assessment?token=${A.NVDAx}&wallet=private`)).status).toBe(400);
  });
  it("prices borrower rights as ask plus repayment and slices lender claims", async () => {
    const app = createApp(build());
    const common = `token=${A.NVDAx}&collateral=1000000000000000003&principal=1000001&repayment=1100003&term=604800`;
    const right = await (await app.request(`/ratings/assessment?${common}&mode=borrower-right&ask=200000`)).json() as { economics: { cost: string; repayment: string | null }; label: string };
    expect(right).toMatchObject({ label: "Market rating", economics: { cost: "1300003", repayment: null } });
    const claim = await (await app.request(`/ratings/assessment?${common}&mode=lender-sale&ask=500000&mask=5`)).json() as { economics: { repayment: string } };
    expect(claim.economics.repayment).toBe(slice(1100003n, 5).toString());
  });
  it("checks exact LP identity before applying range-aware scenarios", async () => {
    const deps = build();
    (deps.reader as FakeReader).addPositionDeal(1n, 7n, 100n, NVDA_KEY, -887220, 887220, 10n ** 15n);
    const app = createApp(deps);
    const params = `collateral=7&principal=1000&repayment=1100&term=604800&mode=loan`;
    const response = await app.request(`/ratings/assessment?poolId=${POOL_ID.nvdaUsdg}&${params}`);
    expect(response.status).toBe(200);
    const result = await response.json() as { scenarios: { shock: number; sigmas: number; value: string }[] };
    // A full-range USDG pair keeps its USDG side fixed; repricing must not scale the entire LP linearly with the fall.
    const two = result.scenarios.find(s => s.sigmas === 2)!;
    expect(two.shock).toBeGreaterThan(0);
    expect(BigInt(two.value)).toBeGreaterThan(BigInt(result.scenarios[0]!.value) * BigInt(Math.round((100 - two.shock) * 100)) / 10_000n);
    expect((await app.request(`/ratings/assessment?poolId=${POOL_ID.gageSgage}&${params}`)).status).toBe(400);
  });
  it("keeps active lender claims rated past grace while flagging the right's finalization risk", async () => {
    const app = createApp(build());
    const common = `token=${A.NVDAx}&collateral=1000000000000000000&principal=1000000&repayment=1100000&term=604800&endAt=${now - 1}&ask=1000`;
    const claim = await (await app.request(`/ratings/assessment?${common}&mode=lender-sale&mask=1`)).json() as { grade: string; reasons: string[] };
    expect(claim.grade).toBe("CCC");
    expect(claim.reasons).toContain("Past grace: a lender can finalize collateral entitlement at any time. Repayment and lender sales remain possible while the loan is active; inspect current on-chain state.");
    const right = await (await app.request(`/ratings/assessment?${common}&mode=borrower-right`)).json();
    expect(right).toMatchObject({ grade: "NR", economics: { graceEnd: now - 1 } });
  });
  it("persists observations but public events cannot write outcomes or grades", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gage-ratings-"));
    const file = join(dir, "ratings.sqlite");
    try {
      const store = new RatingStore(file), deps = { ...build(), ratingStore: store }, app = createApp(deps);
      const result = await (await app.request(`/ratings/assessment?token=${A.NVDAx}`)).json() as { id: string; recorded: boolean };
      expect(result.recorded).toBe(true);
      const event = { assessmentId: result.id, session: "11111111-1111-1111-1111-111111111111", event: "details", surface: "market" };
      const request = (body: unknown) => app.request("/ratings/interactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect((await request(event)).status).toBe(200);
      expect((await request({ ...event, event: "repaid" })).status).toBe(400);
      expect(await (await request({ ...event, assessmentId: "0".repeat(64) })).json()).toEqual({ recorded: false });
      store.close();
      const reopened = new RatingStore(file);
      expect(reopened.interaction(result.id, event.session, "details", "market", now)).toBe(true);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("outcome evaluation", () => {
  const row: Outcome = { chainId: 4663, engine: A.bob, loanId: "1", fundingTx: `0x${"a".repeat(64)}`, settlementTx: `0x${"b".repeat(64)}`,
    borrower: A.alice, lender: A.NVDAx, cohort: "token:7d", model: MODEL, grade: "B", snapshotAt: 1000, fundedAt: 1100,
    settledAt: 1200, principal: "100", recovery: "110", costs: "1", kind: "repaid", independentlyVerified: true };
  it("excludes clicks, self-funding, quote recoveries, duplicate loans and leaked future outcomes", () => {
    const report = evaluateOutcomes([row, row, { ...row, kind: "quote" }, { ...row, lender: row.borrower }, { ...row, settledAt: 1800 },
      { ...row, loanId: "2", fundedAt: 1700, snapshotAt: 1600, settledAt: 2000, recovery: "50" }], 1500);
    expect(report.groups).toHaveLength(2);
    expect(report.groups[0]).toMatchObject({ partition: "training", loans: 1, realizedLossBps: "0" });
    expect(report.groups[1]).toMatchObject({ partition: "holdout", loans: 1, realizedLossBps: "5100" });
    expect(report.excluded).toEqual({ "duplicate loan": 1, "recovery is not realized": 1, "self-funded": 1, "unresolved at training cutoff": 1 });
    expect(report.promotion).toBe("manual-review-required");
  });
  it("reports uncertainty rather than treating a few repayments as proof of safety", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(0, 2)![1]).toBeGreaterThan(0.5);
    expect(wilson(0, 100)![1]).toBeLessThan(0.04);
    expect(evaluateOutcomes([{ ...row, independentlyVerified: false }], 1500).groups).toEqual([]);
  });
  it("keeps identical addresses and loan IDs on different chains in separate cohorts", () => {
    const report = evaluateOutcomes([row, { ...row, chainId: 46630, recovery: "50" }], 1500);
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map(g => g.loans)).toEqual([1, 1]);
  });
});
