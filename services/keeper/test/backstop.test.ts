import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { DealState } from "../src/abi.js";
import { decideBackstopPhase, planBackstop, runBackstop, sizeBackstop, type PlanInput } from "../src/jobs/backstop.js";
import type { DealView, EmissionsState, EpochRates, RegistryConfig, Views } from "../src/views.js";
import { A, m6Deployment, mockCtx, msgs, streamerDeployment } from "./helpers.js";

const SGAGE = 10n ** 18n;
const USDG = 10n ** 6n;
const EPOCH = 604_800;
const WINDOW = 4 * 3_600;
const GRACE = 6 * 3_600;
const signer = "0x1000000000000000000000000000000000000001" as Address;
const KEY = `0x${"11".repeat(32)}`;
/** The run fixtures carry a 1,000,000 sGAGE remainder; "above the threshold" is strict, so the threshold sits under it. */
const MIN = { BACKSTOP_MIN_SGAGE: "500000" };

/** The live epoch-0 mainnet rates: 400,000 sGAGE per USDG, 2 raw USDG per 1e18 sGAGE, all to one party. */
const rates = (over: Partial<EpochRates> = {}): EpochRates =>
  ({ rate7: 4n * 10n ** 23n, rate21: 4n * 10n ** 23n, priceUSDGPerSGAGE: 2n, lenderShareBps: 0, set: true, ...over });
const WETH_MIN = 40_151_162_267_406_354n;
const registry = (over: Partial<RegistryConfig> = {}): RegistryConfig =>
  ({ allowed: true, minAmount: WETH_MIN, maxDealRaw: 10n * SGAGE, maxOpenRaw: 50n * SGAGE, feeBps: 100, term7Allowed: true, term21Allowed: true, newDealsPaused: false, ...over });
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  epoch: 3n, remaining7: 1_000_000n * SGAGE, remaining21: 2_000_000n * SGAGE, rates: rates(), usdgUnit: USDG, maxRewardShareBps: 8_000,
  registry: registry(), collateral: { token: A.weth, amount: WETH_MIN, open: 0n }, minSgage: 1_000_000n * SGAGE, covered: [], ...over,
});

describe("sizeBackstop", () => {
  const common = { priceUSDGPerSGAGE: 2n, usdgUnit: USDG, maxRewardShareBps: 8_000, feeBps: 100 };
  it("sizes the fee so fee × rate reserves the remainder, at the vault's 1% fee", () => {
    const s = sizeBackstop({ remaining: 1_000_000n * SGAGE, rate: 4n * 10n ** 23n, ...common })!;
    expect(s.fee).toBe(25n * USDG / 10n); // 2.5 USDG
    expect(s.price).toBe(250n * USDG);
    expect(s.reservation).toBe(1_000_000n * SGAGE);
  });
  it("clears the 80% price cap when that binds instead of the rate", () => {
    const s = sizeBackstop({ remaining: 1_000_000n * SGAGE, rate: 4n * 10n ** 23n, ...common, priceUSDGPerSGAGE: 4n })!;
    expect(s.fee).toBe(5n * USDG);
    expect(s.price).toBe(500n * USDG);
    expect(s.reservation).toBe(1_000_000n * SGAGE);
  });
  it("never reserves less than the remainder under rounding, and never more", () => {
    for (const odd of [1n, 3n, 999_999_999_999n, 123_456_789_012_345_678_901_234_567n]) {
      const s = sizeBackstop({ remaining: odd, rate: 4n * 10n ** 23n, ...common })!;
      expect(s.reservation).toBe(odd);
      expect((s.price * 100n) / 10_000n).toBe(s.fee);
    }
  });
  it("cannot size without a rate, a price, a fee or a remainder", () => {
    expect(sizeBackstop({ remaining: 0n, rate: 1n, ...common })).toBeUndefined();
    expect(sizeBackstop({ remaining: 1n, rate: 0n, ...common })).toBeUndefined();
    expect(sizeBackstop({ remaining: 1n, rate: 1n, ...common, feeBps: 0 })).toBeUndefined();
    expect(sizeBackstop({ remaining: 1n, rate: 1n, ...common, priceUSDGPerSGAGE: 0n })).toBeUndefined();
  });
});

describe("planBackstop", () => {
  it("plans one deal per bucket with a remainder, each reserving exactly its remainder", () => {
    const p = planBackstop(base());
    expect(p.aboveThreshold).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.deals.map((d) => [d.bucket, d.term, d.reservation])).toEqual([[7, 7 * 86_400, 1_000_000n * SGAGE], [21, 21 * 86_400, 2_000_000n * SGAGE]]);
    expect(p.deals.map((d) => d.fee)).toEqual([25n * USDG / 10n, 5n * USDG]);
    expect(p.usdgNeeded).toBe(250n * USDG + 25n * USDG / 10n + 500n * USDG + 5n * USDG);
    expect(p.collateralNeeded).toBe(2n * WETH_MIN);
  });
  it("plans nothing at or below the threshold", () => {
    const p = planBackstop(base({ remaining7: 600_000n * SGAGE, remaining21: 400_000n * SGAGE }));
    expect(p.aboveThreshold).toBe(false);
    expect(p.deals).toEqual([]);
    expect(p.skipped).toEqual(["below_threshold"]);
    expect(planBackstop(base({ remaining7: 0n, remaining21: 0n })).deals).toEqual([]);
  });
  it("skips a bucket without a remainder, without a rate, or already covered by a backstop deal", () => {
    expect(planBackstop(base({ remaining21: 0n, minSgage: 500_000n * SGAGE })).skipped).toEqual(["no_remainder:21"]);
    expect(planBackstop(base({ rates: rates({ rate21: 0n }) })).skipped).toEqual(["rate_zero:21"]);
    const p = planBackstop(base({ covered: [7] }));
    expect(p.skipped).toEqual(["already_backstopped:7"]);
    expect(p.deals.map((d) => d.bucket)).toEqual([21]);
    expect(planBackstop(base({ registry: registry({ term21Allowed: false }) })).skipped).toEqual(["term_not_allowed:21"]);
  });
  it("refuses a self-dealt deal while both parties would get a drip: the second grant reverts DripExists", () => {
    expect(planBackstop(base({ rates: rates({ lenderShareBps: 5_000 }) })).blockers).toEqual(["self_deal_needs_single_party_share"]);
    expect(planBackstop(base({ rates: rates({ lenderShareBps: 10_000 }) })).blockers).toEqual([]);
    expect(planBackstop(base({ rates: rates({ set: false }) })).blockers).toContain("rates_not_set");
  });
  it("names every registry and collateral blocker while still printing the sized deals", () => {
    expect(planBackstop(base({ collateral: undefined })).blockers).toEqual(["collateral_unconfigured"]);
    expect(planBackstop(base({ registry: registry({ newDealsPaused: true }) })).blockers).toEqual(["new_deals_paused"]);
    expect(planBackstop(base({ registry: registry({ allowed: false }) })).blockers).toEqual(["collateral_not_allowed"]);
    expect(planBackstop(base({ collateral: { token: A.weth, amount: WETH_MIN - 1n, open: 0n } })).blockers).toEqual(["collateral_amount_out_of_range"]);
    const capped = planBackstop(base({ collateral: { token: A.weth, amount: WETH_MIN, open: 50n * SGAGE - WETH_MIN } }));
    expect(capped.blockers).toEqual(["collateral_open_cap"]);
    expect(capped.deals).toHaveLength(2);
  });
});

describe("decideBackstopPhase", () => {
  const next = 10_000_000;
  const last = next - EPOCH;
  const i = { currentEpoch: 3n, weeks: 52n, nextBoundary: next, lastBoundary: last, windowSeconds: WINDOW, graceSeconds: GRACE };
  it("funds inside the last window of the epoch", () => {
    expect(decideBackstopPhase({ ...i, now: next - WINDOW - 1 })).toBeUndefined();
    expect(decideBackstopPhase({ ...i, now: next - WINDOW })).toEqual({ phase: "fund", epoch: 3n });
    expect(decideBackstopPhase({ ...i, now: next - 1 })).toEqual({ phase: "fund", epoch: 3n });
  });
  it("only registers inside the grace after the boundary, for the epoch that just ended", () => {
    const after = { ...i, currentEpoch: 4n, lastBoundary: next, nextBoundary: next + EPOCH };
    expect(decideBackstopPhase({ ...after, now: next })).toEqual({ phase: "grace", epoch: 3n });
    expect(decideBackstopPhase({ ...after, now: next + GRACE - 1 })).toEqual({ phase: "grace", epoch: 3n });
    expect(decideBackstopPhase({ ...after, now: next + GRACE })).toBeUndefined();
    expect(decideBackstopPhase({ ...i, currentEpoch: 0n, now: last + 10 })).toBeUndefined();
    expect(decideBackstopPhase({ ...i, currentEpoch: 52n, now: next - 1 })).toBeUndefined();
  });
});

const LAUNCH = 1_000n;
const emissions = (currentEpoch: bigint): EmissionsState => ({ launchAt: LAUNCH, currentEpoch, weeks: 52n, epochSeconds: BigInt(EPOCH), scheduleOver: false });
const boundary = (epoch: number): number => Number(LAUNCH) + epoch * EPOCH;

/** Reads the plan needs, for epoch 3 with a 1M sGAGE remainder in the 7-day bucket only. */
function planViews(over: Partial<Views> = {}): Partial<Views> {
  return {
    emissionsState: () => Promise.resolve(emissions(3n)),
    epochRemaining: (_e, epoch) => { expect(epoch).toBe(3n); return Promise.resolve({ remaining7: 1_000_000n * SGAGE, remaining21: 0n }); },
    effectiveRates: () => Promise.resolve(rates()),
    dealRewardsConstants: () => Promise.resolve({ usdgUnit: USDG, maxRewardShareBps: 8_000 }),
    registryConfig: (reg, token) => { expect(reg).toBe(A.registry); expect(token).toBe(A.weth); return Promise.resolve(registry()); },
    openRaw: () => Promise.resolve(0n),
    ...over,
  };
}

describe("runBackstop", () => {
  const inWindow = (boundary(4) - 3_600) * 1000;

  it("skips cleanly without the LPStreamer key", async () => {
    const ctx = mockCtx({ deployment: m6Deployment(), signer, env: { BACKSTOP_ENABLED: "true", KEEPER_KEY: KEY } });
    await runBackstop(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "job_skipped")?.missing).toEqual(["LPStreamer"]);
  });

  it("is idle outside the window and the grace", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), now: (boundary(4) - WINDOW - 60) * 1000, views: { emissionsState: () => Promise.resolve(emissions(3n)) } });
    await runBackstop(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(msgs(ctx)).toContain("backstop_idle");
  });

  it("only logs the plan, with every amount, unless BACKSTOP_ENABLED=true and a key are set", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), now: inWindow, views: planViews(), env: MIN });
    await runBackstop(ctx);
    expect(ctx.sender.calls).toEqual([]);
    const plan = ctx.lines.find((l) => l.msg === "backstop_plan")!;
    expect(plan.mode).toBe("plan_only");
    expect(plan.blockers).toEqual([]);
    expect(plan.deals).toEqual([{ bucket: 7, term: 7 * 86_400, remaining: "1000000", rate: "400000000000000000000000", priceUSDG: "250", feeUSDG: "2.5",
      expectedReservation: "1000000", raw: { price: "250000000", fee: "2500000", reservation: "1000000000000000000000000" } }]);
    expect(plan.collateral).toMatchObject({ token: A.weth, amount: WETH_MIN.toString() });
    expect(plan.usdgNeeded).toBe("252.5");
    expect(ctx.lines.find((l) => l.msg === "backstop_plan_only")?.reason).toBe("BACKSTOP_ENABLED is not true");
    // Enabled without a key: still plan only.
    const ctx2 = mockCtx({ deployment: streamerDeployment(), now: inWindow, views: planViews(), env: { ...MIN, BACKSTOP_ENABLED: "true" } });
    await runBackstop(ctx2);
    expect(ctx2.sender.calls).toEqual([]);
    expect(ctx2.lines.find((l) => l.msg === "backstop_plan_only")?.reason).toBe("no KEEPER_KEY");
  });

  it("prints the blocker and sends nothing when both parties would get a drip", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), signer, now: inWindow, env: { ...MIN, BACKSTOP_ENABLED: "true", KEEPER_KEY: KEY },
      views: planViews({ effectiveRates: () => Promise.resolve(rates({ lenderShareBps: 5_000 })) }) });
    await runBackstop(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "backstop_plan")?.blockers).toEqual(["self_deal_needs_single_party_share"]);
  });

  it("refuses to start while the wallet cannot cover the whole plan", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), signer, now: inWindow, env: { ...MIN, BACKSTOP_ENABLED: "true", KEEPER_KEY: KEY },
      views: planViews({ erc20Balance: (token) => Promise.resolve(token === A.usdg ? 100n * USDG : WETH_MIN) }) });
    await runBackstop(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "backstop_underfunded")).toMatchObject({ usdg: { have: "100", need: "252.5" } });
  });

  it("armed but DRY_RUN: approves and lists in simulation, then stops, recording nothing", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), signer, now: inWindow, env: { ...MIN, BACKSTOP_ENABLED: "true", KEEPER_KEY: KEY, DRY_RUN: "true" },
      views: planViews({ erc20Balance: (token) => Promise.resolve(token === A.usdg ? 1_000n * USDG : WETH_MIN), erc20Allowance: () => Promise.resolve(0n) }) });
    await runBackstop(ctx);
    expect(ctx.sender.calls.map((c) => [c.label, c.args])).toEqual([
      ["Collateral.approve", [A.vault, WETH_MIN]],
      ["DealVault.list", [{ kind: 0, token: A.weth, amountOrTokenId: WETH_MIN }, 250n * USDG, 7 * 86_400, 0, 250n * USDG]],
    ]);
    expect(ctx.state.backstop).toEqual({});
    expect(ctx.state.backstopDeals).toEqual([]);
    expect(msgs(ctx)).toContain("backstop_dry_run");
  });

  it("live: lists, funds itself, registers, withdraws, reclaims, withdraws the collateral and records the deal", async () => {
    let dealState: number = DealState.NONE;
    let registered = false;
    let usdgCredit = 0n;
    let wethCredit = 0n;
    let usdgAllowance = 0n;
    const deal = (): DealView => ({ borrower: signer, lender: signer, state: dealState, term: 7 * 86_400, token: A.weth, amountOrTokenId: WETH_MIN,
      cap: 250n * USDG, price: dealState >= DealState.FUNDED ? 250n * USDG : 0n, fee: dealState >= DealState.FUNDED ? 25n * USDG / 10n : 0n, fundedAt: 0n });
    const ctx = mockCtx({ deployment: streamerDeployment(), signer, now: inWindow, env: { ...MIN, BACKSTOP_ENABLED: "true", KEEPER_KEY: KEY, DRY_RUN: "false" },
      views: planViews({
        erc20Balance: (token) => Promise.resolve(token === A.usdg ? 1_000n * USDG : WETH_MIN),
        erc20Allowance: (token) => Promise.resolve(token === A.usdg ? usdgAllowance : WETH_MIN),
        deal: (vault, id) => { expect(vault).toBe(A.vault); expect(id).toBe(9n); return Promise.resolve(deal()); },
        registered: () => Promise.resolve([registered]),
        vaultBalanceUSDG: () => Promise.resolve(usdgCredit),
        vaultBalanceERC20: () => Promise.resolve(wethCredit),
      }) });
    const sent = { status: "sent" as const, hash: "0x01" as const, gasUsed: 1n, result: undefined };
    ctx.sender.script["DealVault.list"] = () => { dealState = DealState.LISTED; return { ...sent, result: 9n }; };
    ctx.sender.script["USDG.approve"] = (c) => { usdgAllowance = c.args![1] as bigint; return sent; };
    ctx.sender.script["DealVault.fund"] = () => { dealState = DealState.FUNDED; usdgCredit = 250n * USDG - 25n * USDG / 10n; return sent; };
    ctx.sender.script["DealRewards.register"] = () => { registered = true; return sent; };
    ctx.sender.script["DealVault.withdrawUSDG"] = () => { usdgCredit = 0n; return sent; };
    ctx.sender.script["DealVault.reclaim"] = () => { dealState = DealState.RECLAIMED; usdgCredit = 250n * USDG; wethCredit = WETH_MIN; return sent; };
    ctx.sender.script["DealVault.withdrawERC20"] = () => { wethCredit = 0n; return sent; };
    await runBackstop(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual([
      "DealVault.list", "USDG.approve", "DealVault.fund", "DealRewards.register", "DealVault.withdrawUSDG", "DealVault.reclaim",
      "DealVault.withdrawUSDG", "DealVault.withdrawERC20",
    ]);
    expect(ctx.sender.calls[1]!.args).toEqual([A.vault, 500n * USDG]);
    expect(ctx.sender.calls[2]!.args).toEqual([9n, signer]);
    expect(ctx.sender.calls[3]!.args).toEqual([9n]);
    expect(ctx.state.backstopDeals).toEqual(["9"]);
    expect(ctx.state.backstop["9"]).toMatchObject({ dealId: "9", epoch: "3", bucket: 7, price: (250n * USDG).toString(), fee: (25n * USDG / 10n).toString(),
      reservation: (1_000_000n * SGAGE).toString(), done: true });
    expect(ctx.state.registered).toContain("9");
    // A second run in the same window: the bucket is covered, nothing new is planned, nothing is sent.
    await runBackstop(ctx);
    expect(ctx.sender.calls).toHaveLength(8);
    expect(ctx.lines.filter((l) => l.msg === "backstop_plan").at(-1)?.skipped).toEqual(["already_backstopped:7", "no_remainder:21"]);
  });

  it("backs off an hour when register reverts, and finishes the deal on a later run", async () => {
    let registered = false;
    const ctx = mockCtx({ deployment: streamerDeployment(), signer, now: inWindow, env: { ...MIN, BACKSTOP_ENABLED: "true", KEEPER_KEY: KEY, DRY_RUN: "false" },
      views: planViews({
        deal: () => Promise.resolve({ borrower: signer, lender: signer, state: DealState.FUNDED, term: 7 * 86_400, token: A.weth, amountOrTokenId: WETH_MIN,
          cap: 250n * USDG, price: 250n * USDG, fee: 25n * USDG / 10n, fundedAt: 0n }),
        registered: () => Promise.resolve([registered]),
      }) });
    ctx.state.backstop["9"] = { dealId: "9", epoch: "3", bucket: 7, term: 7 * 86_400, token: A.weth, amount: WETH_MIN.toString(), price: (250n * USDG).toString(),
      fee: (25n * USDG / 10n).toString(), reservation: "1", createdAt: 0, done: false };
    ctx.state.backstopDeals = ["9"];
    ctx.sender.script["DealRewards.register"] = { status: "reverted", revert: { name: "DripExists", args: [], message: "" } };
    await runBackstop(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["DealRewards.register"]);
    expect(ctx.state.backstop["9"].retryAfter).toBe(ctx.now() + 3_600_000);
    expect(ctx.state.backstop["9"].done).toBe(false);
    expect(msgs(ctx)).toContain("backstop_register_reverted");
    // Not retried inside the hour.
    await runBackstop(ctx);
    expect(ctx.sender.calls).toHaveLength(1);
    registered = true;
    delete ctx.state.backstop["9"].retryAfter;
    ctx.sender.script["DealVault.reclaim"] = { status: "refused", reason: "gas_below_floor" };
    const views2 = planViews({ ...ctx.views, vaultBalanceUSDG: () => Promise.resolve(0n), erc20Allowance: () => Promise.resolve(10n ** 30n) });
    ctx.views = { ...ctx.views, ...views2 };
    await runBackstop(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["DealRewards.register", "DealVault.reclaim"]);
    expect(ctx.state.backstop["9"].done).toBe(false);
  });

  it("in the grace after the boundary it only reports: a deal funded now would count for the new epoch", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), signer, now: (boundary(4) + 600) * 1000, env: { BACKSTOP_ENABLED: "true", KEEPER_KEY: KEY },
      views: { emissionsState: () => Promise.resolve(emissions(4n)), epochRemaining: (_e, epoch) => { expect(epoch).toBe(3n); return Promise.resolve({ remaining7: 5n * SGAGE, remaining21: 0n }); } } });
    await runBackstop(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "backstop_grace")).toMatchObject({ epoch: "3" });
  });
});
