import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { EarnApproval, EarnLoan, EarnStrategy } from "../../../shared/earn.js";
import { fetchEarnInput } from "../src/earn-indexer.js";
import { runEarn, earnHealth, earnHealthResponse, earnStrategyHealths, type EarnDependencies, type EarnInput } from "../src/jobs/earn.js";
import type { EarnStrategyRef } from "../src/deployment.js";
import { earnBucket, emptyState, type EarnStrategyState } from "../src/state.js";
import { A, m1Deployment, mockCtx } from "./helpers.js";

vi.mock("../src/earn-indexer.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/earn-indexer.js")>(), fetchEarnInput: vi.fn() }));

const strategy = "0x1000000000000000000000000000000000000011" as Address;
const reserve = "0x1000000000000000000000000000000000000012" as Address;
const coreRewards = "0x1000000000000000000000000000000000000013" as Address;
const bob = "0x1000000000000000000000000000000000000015" as Address;
const token = "0x1000000000000000000000000000000000000016" as Address;
const now = 1_800_000_000;
const snap = { chainId: 46630, strategy, blockNumber: "100", asOf: now };
const core = A.vault;
const E12 = 1_000_000_000_000n;
const baseStrategy: EarnStrategy = { ...snap, id: "earn", title: "Gage USDG Mix", address: strategy, core, coreRewards, registry: A.registry, reserveAsset: A.usdg, reserveSymbol: "TEST", rewardToken: { address: A.sgage, symbol: "sGAGE", decimals: 18 }, reserve, curator: bob, usdg: A.usdg,
  usdgDecimals: 6, reserveDecimals: 18, shareDecimals: 18, paused: false, feeBps: 1000, fees: bob, feeRecipient: bob, protocolShareBps: 2500, protocolRecipient: bob, feeAccrued: "0", curatorAccrued: "0", protocolAccrued: "0", highWaterPrice: "0", grace: 172800,
  mandate: { minDeposit: "1000000", maxTotalDeposits: "10000000000", maxLoanTerm: 604800, minReturnBps: 300, maxGageExposureBps: 10000 },
  lanes: [{ lane: "STOCK", weightBps: 10000, principal: "0", cap: "10000000000", headroom: "10000000000" }],
  tokens: [{ token, symbol: "TEST", decimals: 18, unit: "1000000000000000000", lane: "STOCK", ceiling: "100000000", allowed: true, uiMultiplier: "1000000000000000000", principal: "0" }],
  shares: { totalSupply: String(10_000_000_000n * E12), virtualShares: String(E12), price: "1000000", fullPrice: "1000000" },
  totals: { cash: "0", reserveShares: String(10_000_000_000n * E12), reserveAssets: "10000000000", performingPrincipal: "0", overduePrincipal: "0", fullAssets: "10000000000", totalAssets: "10000000000", lockedProfit: "0", unlockStart: 0, unlockEnd: 0, profitUnlockSeconds: 604800,
    freeLiquidity: "10000000000", pendingShares: "0", pendingRequestAssets: "0", openRequests: 0, claimableTotal: "0", harvestedCash: "0", assignedCash: "0", accRewardPerShare: "0", rewardRemainder: "0" },
  pockets: [] };
function loan(dealId: string, patch: Partial<EarnLoan> = {}): EarnLoan {
  return { ...snap, id: dealId, dealId, borrower: bob, kind: "ERC20", token, lane: "STOCK", principal: "1000000", cap: "1030000", collateralAmount: "1000000000000000000", positionPrincipal: "1000000", units: 4, slots: 15, withdrawn: false, overdue: false, carried: "1000000", state: "Active", coreState: "ACTIVE", fundingDeadline: now - 1500, fundedAt: now - 1000, expiry: now + 100, claimableAt: now + 1000, settled: false, outcome: null, payout: "0", profit: "0", fee: "0", feeBps: 1000, pocketId: null, pocketIds: [], rewards: "0", ...patch };
}
function approval(dealId: string, patch: Partial<EarnApproval> = {}): EarnApproval {
  return { ...snap, dealId, kind: "ERC20", token, lane: "STOCK", principal: "1000000", units: 4, validUntil: now + 3500, funded: false, revoked: false, ...patch };
}
function totals(patch: Partial<EarnStrategy["totals"]>): EarnStrategy {
  return { ...baseStrategy, totals: { ...baseStrategy.totals, ...patch } };
}
function fixture(patch: Partial<EarnInput> = {}, env: Record<string, string> = {}) {
  const deployment = m1Deployment();
  deployment.addresses = { ...deployment.addresses, HybridVault: strategy, HybridReserve: reserve, EarnCore: core };
  const ctx = mockCtx({ deployment, env: { EARN_ENABLED: "true", EARN_TOLERANCE_BPS: "100", EARN_REWARD_MIN_RAW: "10", EARN_RETRY_BASE_SECONDS: "10", EARN_ALERT_ATTEMPTS: "2", ...env } });
  const input: EarnInput = { strategy: baseStrategy, loans: [], approvals: [], ...patch };
  const read = vi.fn<EarnDependencies["read"]>((_address, name, args) => {
    if (name === "previewWithdraw" || name === "previewDeposit") return Promise.resolve((args?.[0] as bigint ?? 0n) * E12);
    if (name === "previewRedeem") return Promise.resolve((args?.[0] as bigint ?? 0n) / E12);
    if (name === "maxWithdraw") return Promise.resolve(BigInt(input.strategy.totals.reserveAssets));
    if (name === "cashCredit" || name === "claimable") return Promise.resolve(0n);
    throw Error(`Unexpected read ${name}`);
  });
  const deps: EarnDependencies = { snapshot: () => Promise.resolve(input), read };
  return { ctx, input, deps, read };
}

describe("Earn keeper tick", () => {
  it("settles resolved and finalizable loans, writes overdue loans down, then funds every valid approval", async () => {
    const f = fixture({ loans: [loan("1", { state: "Settling", coreState: "REPAID" }), loan("2", { state: "Claimable", expiry: now - 1000, claimableAt: now }), loan("3", { state: "Overdue", expiry: now }), loan("9", { state: "Settling", coreState: "FUNDING", withdrawn: true, fundedAt: 0, expiry: 0, claimableAt: 0 }), loan("10", { state: "Settling", coreState: "CANCELLED", fundedAt: 0, expiry: 0, claimableAt: 0 })], approvals: [approval("4"), approval("5"), approval("6", { validUntil: now }), approval("7", { revoked: true }), approval("8", { funded: true })] });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["settle", "markOverdue", "fund", "fund"]);
    expect(f.ctx.sender.calls[0]?.args).toEqual([[1n, 2n, 9n, 10n]]);
    expect(f.ctx.sender.calls[1]?.args).toEqual([[3n]]);
    expect(f.ctx.sender.calls[2]?.args).toEqual([4n, 1_010_000_000_000_000_000n]);
    expect(f.ctx.sender.calls.every(c => c.address === strategy)).toBe(true);
  });

  it("never writes down a loan already written down or one it settles in the same tick", async () => {
    const f = fixture({ loans: [loan("1", { state: "Overdue", expiry: now - 1, overdue: true, carried: "0" }), loan("2", { state: "Claimable", expiry: now - 1000, claimableAt: now }), loan("3", { expiry: now + 1 })] });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["settle"]);
    expect(f.ctx.sender.calls[0]?.args).toEqual([[2n]]);
  });

  it("settles LP defaults once per loan and funds both supported LP kinds", async () => {
    const f = fixture({
      loans: [
        loan("1", { kind: "UNIV3_POSITION", lane: "LP", collateralAmount: "112", state: "Claimable", expiry: now - 1000, claimableAt: now }),
        loan("2", { kind: "UNIV4_POSITION", lane: "LP", collateralAmount: "113", state: "Settling", coreState: "DEFAULTED" }),
        loan("3", { kind: "UNIV4_POSITION", lane: "LP", collateralAmount: "114", state: "Collateral", coreState: "DEFAULTED", settled: true, pocketId: "1", pocketIds: ["1", "2"] }),
      ],
      approvals: [approval("4", { kind: "UNIV3_POSITION", lane: "LP" }), approval("5", { kind: "UNIV4_POSITION", lane: "LP" })],
    });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => [c.functionName, c.args])).toEqual([
      ["settle", [[1n, 2n]]],
      ["fund", [4n, 1_010_000_000_000_000_000n]],
      ["fund", [5n, 1_010_000_000_000_000_000n]],
    ]);
  });

  it("serves the queue from cash plus what the reserve can release, invests idle cash net of planned fundings, then funds", async () => {
    const f = fixture({ strategy: totals({ cash: "5000000", reserveAssets: "2000000", freeLiquidity: "7000000", pendingShares: "1", pendingRequestAssets: "1000000", openRequests: 2 }), approvals: [approval("1")] });
    f.read.mockImplementation((_address, name, args) => name === "maxWithdraw" ? Promise.resolve(1_500_000n) : name === "previewDeposit" || name === "previewWithdraw" ? Promise.resolve((args?.[0] as bigint) * E12) : Promise.resolve(0n));
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["serveRequests", "investReserve", "fund"]);
    expect(f.ctx.sender.calls[0]?.args).toEqual([32n, 5_000_000n + 1_485_000n]);
    expect(f.ctx.sender.calls[1]?.args).toEqual([4_000_000n, 3_960_000_000_000_000_000n]);
    expect(f.ctx.sender.calls[2]?.args).toEqual([1n, 1_010_000_000_000_000_000n]);
    expect(f.read.mock.calls.map(c => c[1])).not.toContain("maxRedeem");
  });

  it.each([33, 65])("bounds queue traversal to 32 rows with %i open requests", async (count) => {
    const f = fixture({ strategy: totals({ pendingShares: String(BigInt(count) * E12), pendingRequestAssets: String(count), openRequests: count }) });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => [c.functionName, c.args])).toEqual([["serveRequests", [32n, 9_900_000_000n]]]);
    expect(f.ctx.lines.find(line => line.msg === "earn_tick")?.requests).toBe(count);
  });

  it("keeps the full row budget for a possible cancelled prefix with one open request and no request history", async () => {
    const f = fixture({ strategy: totals({ pendingShares: String(E12), pendingRequestAssets: "1", openRequests: 1 }) });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => [c.functionName, c.args])).toEqual([["serveRequests", [32n, 9_900_000_000n]]]);
  });

  it("falls back to the reserve's converted value when it reports no withdrawal bound", async () => {
    const f = fixture({ strategy: totals({ cash: "100", reserveAssets: "2000000", freeLiquidity: "2000100", pendingShares: "1", pendingRequestAssets: "500", openRequests: 1 }) });
    f.read.mockImplementation((_address, name) => name === "maxWithdraw" ? Promise.reject(new Error("no such function")) : Promise.resolve(0n));
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["serveRequests"]);
    expect(f.ctx.sender.calls[0]?.args).toEqual([32n, 100n + 1_980_000n]);
  });

  it("serves reserve-backed requests when Morpho reports a zero maxWithdraw", async () => {
    const f = fixture({ strategy: totals({ cash: "0", reserveAssets: "1000000000", freeLiquidity: "1000000000", pendingShares: "1000000000000000000", pendingRequestAssets: "1000000", openRequests: 1 }) });
    f.read.mockImplementation((_address, name) => {
      if (name === "maxWithdraw" || name === "cashCredit") return Promise.resolve(0n);
      throw Error(name);
    });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => [c.functionName, c.args])).toEqual([["serveRequests", [32n, 990_000_000n]]]);
    expect(earnHealth(f.ctx).ok).toBe(true);
  });

  it("funds only from liquidity the queue does not already claim, shrinking what is left per approval", async () => {
    const f = fixture({ strategy: totals({ cash: "0", reserveAssets: "2500000", freeLiquidity: "2500000", pendingShares: "1", pendingRequestAssets: "1000000" }), approvals: [approval("1"), approval("2"), approval("3")] });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => [c.functionName, c.args?.[0]])).toEqual([["serveRequests", 32n], ["fund", 1n]]);
  });

  it("skips closed strategy funding and investment while settlement and serving continue", async () => {
    const f = fixture({ strategy: { ...totals({ cash: "3000000", freeLiquidity: "13000000000", pendingShares: "1", pendingRequestAssets: "10" }), paused: true }, loans: [loan("1", { coreState: "REPAID", state: "Settling" })], approvals: [approval("2")] });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["settle", "serveRequests"]);
  });

  it("refuses wrong-chain, stale and mismatched indexer snapshots before constructing transactions", async () => {
    for (const strategyPatch of [{ chainId: 4663 }, { asOf: now - 121 }, { address: bob }, { core: bob }, { reserve: bob }]) {
      const f = fixture({ strategy: { ...baseStrategy, ...strategyPatch }, approvals: [approval("1")] });
      await expect(runEarn(f.ctx, f.deps)).rejects.toThrow();
      expect(f.ctx.sender.calls).toEqual([]);
    }
  });

  it("uses an explicit replay chain clock for deadlines while health remains on wall time", async () => {
    const f = fixture({ approvals: [approval("1", { validUntil: now + 60 })] });
    f.ctx.now = () => (now - 1_000_000) * 1000;
    await expect(runEarn(f.ctx, f.deps)).rejects.toThrow("Earn indexer snapshot stale");
    await runEarn(f.ctx, { ...f.deps, chainNow: () => now });
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["fund"]);
    expect(earnHealth(f.ctx).lastTickAt).toBe(now - 1_000_000);
    expect(earnHealth(f.ctx).ok).toBe(true);
  });

  it.each([-1, 0, 1])("requires submission time remaining when planning %i seconds from approval expiry", async (offset) => {
    const validUntil = now + 1;
    const f = fixture({ approvals: [approval("1", { validUntil })] });
    await runEarn(f.ctx, { ...f.deps, chainNow: () => validUntil + offset });
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(offset < 0 ? ["fund"] : []);
    expect(f.read.mock.calls.some(c => c[1] === "previewWithdraw")).toBe(offset < 0);
  });

  it.each([-1, 0, 1])("rechecks submission time after previewing %i seconds from approval expiry", async (offset) => {
    const validUntil = now + 1;
    let chainTime = now;
    const f = fixture({ approvals: [approval("1", { validUntil })] });
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation((address, name, args) => {
      if (name === "previewWithdraw") chainTime = validUntil + offset;
      return original(address, name, args);
    });
    await runEarn(f.ctx, { ...f.deps, chainNow: () => chainTime });
    expect(f.read.mock.calls.some(c => c[1] === "previewWithdraw")).toBe(true);
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(offset < 0 ? ["fund"] : []);
  });

  it("backs off repeated reverts and exposes one persistent alert per action failure episode", async () => {
    const f = fixture({ approvals: [approval("1")] });
    f.ctx.sender.script["Earn.fund"] = { status: "reverted", revert: { name: "InsufficientLiquidity", args: [], message: "InsufficientLiquidity" } };
    await runEarn(f.ctx, f.deps);
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls).toHaveLength(1);
    f.ctx.now = () => (now + 11) * 1000;
    await runEarn(f.ctx, f.deps);
    const health = earnHealth(f.ctx);
    expect(health.alerts).toHaveLength(1);
    expect(health.alerts[0]?.code).toBe("keeper_revert");
    expect(health.failures[0]?.attempts).toBe(2);
  });

  it("recovers health when a failed approval is revoked without erasing its delivered incident", async () => {
    const f = fixture({ approvals: [approval("1")] });
    f.ctx.sender.script["Earn.fund"] = { status: "reverted", revert: { name: "IneligibleDeal", args: [], message: "IneligibleDeal" } };
    await runEarn(f.ctx, f.deps);
    f.ctx.now = () => (now + 11) * 1000;
    await runEarn(f.ctx, f.deps);
    expect(earnHealth(f.ctx).ok).toBe(false);
    expect(earnHealth(f.ctx).alerts).toHaveLength(1);
    f.input.approvals[0]!.revoked = true;
    await runEarn(f.ctx, f.deps);
    expect(earnHealth(f.ctx).failures).toEqual([]);
    expect(earnHealth(f.ctx).ok).toBe(true);
    expect(earnHealth(f.ctx).alerts).toHaveLength(1);
    expect(f.ctx.sender.calls).toHaveLength(2);
  });

  it("retains failures when an incomplete planning tick or paused phase cannot prove recovery", async () => {
    const f = fixture({ approvals: [approval("1")] });
    f.ctx.sender.script["Earn.fund"] = { status: "reverted", revert: { name: "IneligibleDeal", args: [], message: "IneligibleDeal" } };
    await runEarn(f.ctx, f.deps);
    f.ctx.now = () => (now + 11) * 1000;
    await runEarn(f.ctx, f.deps);
    const original = f.read.getMockImplementation()!;
    f.input.approvals[0]!.revoked = true;
    f.read.mockRejectedValueOnce(new Error("RPC unavailable mid-tick"));
    await expect(runEarn(f.ctx, f.deps)).rejects.toThrow("RPC unavailable mid-tick");
    expect(earnHealth(f.ctx).failures[0]?.attempts).toBe(2);
    f.read.mockImplementation(original);
    f.input.strategy = { ...baseStrategy, paused: true };
    await runEarn(f.ctx, f.deps);
    expect(earnHealth(f.ctx).failures[0]?.attempts).toBe(2);
    expect(earnHealth(f.ctx).ok).toBe(false);
    expect(earnHealth(f.ctx).alerts).toHaveLength(1);
  });

  it("stops the tick when an unresolved transaction prevents signing", async () => {
    const f = fixture({ approvals: [approval("1"), approval("2")] });
    f.ctx.sender.script["Earn.fund"] = { status: "failed", error: "pending-transaction-unresolved" };
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls).toHaveLength(1);
  });

  it("reconciles a journal before reading an idle snapshot so a confirmed action can restore health", async () => {
    const f = fixture();
    let pending: `0x${string}` | null = "0x1234";
    f.ctx.sender.pendingTransaction = () => pending;
    const recoverPending = vi.fn(() => { pending = null; return Promise.resolve(true); });
    f.ctx.sender.recoverPending = recoverPending;
    const snapshot = vi.fn(() => { expect(pending).toBeNull(); return Promise.resolve(f.input); });
    await runEarn(f.ctx, { ...f.deps, snapshot });
    expect(recoverPending).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(f.ctx.sender.calls).toHaveLength(0);
    expect(earnHealth(f.ctx)).toMatchObject({ ok: true, pendingTransaction: null, lastTickAt: now });
  });

  it("does not fetch or plan new work while independent journal recovery is blocked", async () => {
    const f = fixture({ approvals: [approval("1")] });
    f.ctx.sender.pendingTransaction = () => "0x1234";
    f.ctx.sender.recoverPending = () => Promise.resolve(false);
    const snapshot = vi.fn(() => Promise.resolve(f.input));
    await runEarn(f.ctx, { ...f.deps, snapshot });
    expect(snapshot).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.ctx.sender.calls).toHaveLength(0);
    expect(earnHealth(f.ctx)).toMatchObject({ ok: false, pendingTransaction: "0x1234", lastTickAt: null });
  });

  it("keeps a fresh worker healthy during normal confirmation but blocks unresolved journals and stale work", async () => {
    const f = fixture();
    await runEarn(f.ctx, f.deps);
    f.ctx.sender.pendingTransaction = () => "0x1234";
    expect(earnHealth(f.ctx).ok).toBe(false); // inherited journals have no active confirmation
    f.ctx.sender.isConfirmingTransaction = () => true;
    expect(earnHealth(f.ctx)).toMatchObject({ ok: true, pendingTransaction: "0x1234" });
    f.ctx.now = () => (now + 121) * 1000;
    expect(earnHealth(f.ctx).ok).toBe(false);
    f.ctx.now = () => now * 1000;
    f.ctx.sender.isConfirmingTransaction = () => false;
    expect(earnHealth(f.ctx).ok).toBe(false);
  });

  it("uses a complete paginated indexer inventory and batches at the contract bound", async () => {
    const f = fixture({ loans: Array.from({ length: 65 }, (_, i) => loan(String(i + 1), { coreState: "REPAID", state: "Settling" })) });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => (c.args?.[0] as unknown[]).length)).toEqual([32, 32, 1]);
  });

  it("dry-run and execute build the same ordered action list", async () => {
    const input = { loans: [loan("1", { coreState: "REPAID", state: "Settling" })], approvals: [approval("2")] };
    const dry = fixture(input), execute = fixture(input);
    for (const label of ["Earn.settle", "Earn.fund"]) execute.ctx.sender.script[label] = { status: "sent", hash: `0x${"01".repeat(32)}`, gasUsed: 100n, result: undefined };
    await runEarn(dry.ctx, dry.deps);
    await runEarn(execute.ctx, execute.deps);
    expect(dry.ctx.sender.calls).toEqual(execute.ctx.sender.calls);
  });

  it("harvests core cash credit and rewards above the threshold in order, never for released or unactivated units", async () => {
    const f = fixture({ loans: [loan("1"), loan("2"), loan("3", { coreState: "FUNDING", fundedAt: 0, expiry: 0, claimableAt: 0, fundingDeadline: now + 100, state: "Funding" }), loan("4", { withdrawn: true })] });
    f.read.mockImplementation((_address, name, args) => {
      if (name === "cashCredit") return Promise.resolve(100n);
      if (name === "claimable") return Promise.resolve(args?.[0] === 2n ? 9n : 10n);
      throw Error(`Unexpected read ${name}`);
    });
    await runEarn(f.ctx, f.deps);
    // The released commitment settles first; its units and the unactivated listing earn nothing to harvest.
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["settle", "harvestCash", "harvestRewards"]);
    expect(f.ctx.sender.calls[0]?.args).toEqual([[4n]]);
    expect(f.ctx.sender.calls.every(c => c.address === strategy)).toBe(true);
    expect(f.ctx.sender.calls[2]?.args).toEqual([[1n]]);
    expect(f.read.mock.calls.filter(c => c[1] === "claimable").map(c => [c[0], c[2]?.[1]])).toEqual([[coreRewards, strategy], [coreRewards, strategy]]);
  });

  it("makes failed harvest and reserve redemption alerts distinguishable", async () => {
    const f = fixture({ strategy: totals({ cash: "0", pendingShares: "1", pendingRequestAssets: "10" }) });
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation((address, name, args) => name === "cashCredit" ? Promise.resolve(1n) : original(address, name, args));
    const revert = { status: "reverted" as const, revert: { name: "TransferAmountMismatch", args: [], message: "TransferAmountMismatch" } };
    f.ctx.sender.script["Earn.harvestCash"] = revert;
    f.ctx.sender.script["Earn.serveRequests"] = revert;
    await runEarn(f.ctx, f.deps);
    f.ctx.now = () => (now + 11) * 1000;
    await runEarn(f.ctx, f.deps);
    expect(earnHealth(f.ctx).alerts.map(a => a.code).sort()).toEqual(["harvest_failed", "reserve_redemption_failed"]);
  });

  it("leaves idle cash below the configured threshold alone and never serves an empty queue", async () => {
    const f = fixture({ strategy: totals({ cash: "999999", freeLiquidity: "10000999999" }) });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls).toEqual([]);
    const g = fixture({ strategy: totals({ cash: "999999", freeLiquidity: "10000999999" }) }, { EARN_INVEST_MIN_RAW: "500000" });
    await runEarn(g.ctx, g.deps);
    expect(g.ctx.sender.calls.map(c => [c.functionName, c.args?.[0]])).toEqual([["investReserve", 999_999n]]);
  });

  it("releases an expired funding window on the core before settling, and leaves open windows alone", async () => {
    const f = fixture({ loans: [loan("1", { coreState: "FUNDING", fundedAt: 0, expiry: 0, claimableAt: 0, fundingDeadline: now, state: "Settling" }), loan("2", { coreState: "FUNDING", fundedAt: 0, expiry: 0, claimableAt: 0, fundingDeadline: now + 1, state: "Funding" }), loan("3", { coreState: "FUNDING", fundedAt: 0, expiry: 0, claimableAt: 0, fundingDeadline: now, withdrawn: true, state: "Settling" })] });
    await runEarn(f.ctx, f.deps);
    expect(f.ctx.sender.calls.map(c => c.functionName)).toEqual(["cancelFunding", "settle"]);
    expect(f.ctx.sender.calls[0]?.address).toBe(core.toLowerCase());
    expect(f.ctx.sender.calls[0]?.args).toEqual([1n]);
    expect(f.ctx.sender.calls[1]?.args).toEqual([[3n]]);
  });

  it("alerts when the contract catches a paused USDG harvest without transferring cash", async () => {
    const f = fixture();
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation((address, name, args) => name === "cashCredit" ? Promise.resolve(100n) : original(address, name, args));
    f.ctx.sender.script["Earn.harvestCash"] = { status: "sent", hash: `0x${"01".repeat(32)}`, gasUsed: 100n, result: undefined };
    await runEarn(f.ctx, f.deps);
    f.ctx.now = () => (now + 11) * 1000;
    await runEarn(f.ctx, f.deps);
    expect(earnHealth(f.ctx).alerts[0]?.code).toBe("harvest_failed");
    expect(earnHealth(f.ctx).failures[0]?.attempts).toBe(2);
  });

  it("reports disabled health without the reserve or core identity and runs nothing", async () => {
    const deployment = m1Deployment();
    deployment.addresses = { ...deployment.addresses, HybridVault: strategy };
    const ctx = mockCtx({ deployment, env: { EARN_ENABLED: "true" } });
    await runEarn(ctx, { snapshot: () => Promise.reject(new Error("must not fetch")), read: () => Promise.reject(new Error("must not read")) });
    expect(earnHealth(ctx).mode).toBe("disabled");
    expect(ctx.sender.calls).toEqual([]);
  });
});

describe("Earn keeper over several strategies", () => {
  const second = { vault: "0x2000000000000000000000000000000000000021" as Address, reserve: "0x2000000000000000000000000000000000000022" as Address };
  const lowerCore = core.toLowerCase() as Address;
  const refs: EarnStrategyRef[] = [
    { id: "gage-mix", title: "Gage USDG Mix", vault: strategy, fees: undefined, reserve, core: lowerCore, startBlock: 10n },
    { id: "stocks", title: "Gage USDG Stocks", vault: second.vault, fees: undefined, reserve: second.reserve, core: lowerCore, startBlock: 20n },
  ];
  const secondStrategy: EarnStrategy = { ...baseStrategy, id: "stocks", title: "Gage USDG Stocks", strategy: second.vault, address: second.vault, reserve: second.reserve };
  /** Two strategies, no `provided` hook: snapshots come from the mocked indexer client and reads from a fake RPC. */
  function multi(inputs: Record<string, EarnInput | Error>) {
    const deployment = m1Deployment();
    deployment.addresses = { ...deployment.addresses, HybridVault: strategy, HybridReserve: reserve, EarnCore: core };
    deployment.earnStrategies = refs;
    const ctx = mockCtx({ deployment, env: { EARN_ENABLED: "true", EARN_RETRY_BASE_SECONDS: "10", EARN_ALERT_ATTEMPTS: "2" } });
    ctx.publicClient = { readContract: ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "previewWithdraw" || functionName === "previewDeposit") return Promise.resolve((args?.[0] as bigint) * E12);
      return Promise.resolve(0n);
    } } as unknown as NonNullable<typeof ctx.publicClient>;
    vi.mocked(fetchEarnInput).mockClear().mockImplementation((_url, address) => {
      const input = inputs[address.toLowerCase()];
      return input instanceof Error ? Promise.reject(input) : input ? Promise.resolve(input) : Promise.reject(new Error(`no fixture for ${address}`));
    });
    return ctx;
  }

  it("ticks every listed strategy in order with its own snapshot, writes and state bucket", async () => {
    const ctx = multi({ [strategy]: { strategy: baseStrategy, loans: [], approvals: [approval("1")] }, [second.vault]: { strategy: secondStrategy, loans: [loan("7", { coreState: "REPAID", state: "Settling" })], approvals: [] } });
    await runEarn(ctx);
    expect(vi.mocked(fetchEarnInput).mock.calls.map(c => c[1])).toEqual([strategy, second.vault]);
    expect(ctx.sender.calls.map(c => [c.functionName, c.address])).toEqual([["fund", strategy], ["settle", second.vault]]);
    expect(ctx.lines.filter(l => l.msg === "earn_tick").map(l => l.id)).toEqual(["gage-mix", "stocks"]);
    expect(Object.keys(ctx.state.earn ?? {})).toEqual([strategy, second.vault]);
    expect(earnStrategyHealths(ctx).map(h => [h.strategy, h.ok, h.lastTickAt])).toEqual([[strategy, true, now], [second.vault, true, now]]);
  });

  it("keeps running the other strategies when one tick throws, records that failure in its bucket and rethrows at the end", async () => {
    const ctx = multi({ [strategy]: new Error("Earn indexer unavailable"), [second.vault]: { strategy: secondStrategy, loans: [], approvals: [approval("2")] } });
    await expect(runEarn(ctx)).rejects.toThrow("Earn indexer unavailable");
    expect(ctx.sender.calls.map(c => [c.functionName, c.address])).toEqual([["fund", second.vault]]);
    expect(earnHealth(ctx).ok).toBe(false);
    expect(earnHealth(ctx).failures).toEqual([{ action: "tick", attempts: 1, retryAt: now + 10 }]);
    expect(earnHealth(ctx, second.vault)).toMatchObject({ ok: true, failures: [], lastTickAt: now });
    ctx.now = () => (now + 11) * 1000;
    await expect(runEarn(ctx)).rejects.toThrow();
    expect(earnHealth(ctx).alerts.map(a => [a.action, a.strategy])).toEqual([["tick", strategy]]);
    expect(earnHealth(ctx, second.vault).alerts).toEqual([]);
    expect(ctx.lines.filter(l => l.msg === "earn_strategy_failed").map(l => l.id)).toEqual(["gage-mix", "gage-mix"]);
  });

  it("clears a strategy's tick failure on its next complete tick without touching the other bucket", async () => {
    const inputs: Record<string, EarnInput | Error> = { [strategy]: new Error("down"), [second.vault]: { strategy: secondStrategy, loans: [], approvals: [] } };
    const ctx = multi(inputs);
    await expect(runEarn(ctx)).rejects.toThrow("down");
    inputs[strategy] = { strategy: baseStrategy, loans: [], approvals: [] };
    inputs[second.vault] = new Error("down");
    await expect(runEarn(ctx)).rejects.toThrow("down");
    expect(earnHealth(ctx).failures).toEqual([]);
    expect(earnHealth(ctx, second.vault).failures.map(f => f.action)).toEqual(["tick"]);
  });

  it("ends the whole run when the wallet cannot sign, so the second strategy is not attempted", async () => {
    const ctx = multi({ [strategy]: { strategy: baseStrategy, loans: [], approvals: [approval("1")] }, [second.vault]: { strategy: secondStrategy, loans: [], approvals: [approval("2")] } });
    ctx.sender.script["Earn.fund"] = { status: "failed", error: "pending-transaction-unresolved" };
    await runEarn(ctx);
    expect(ctx.sender.calls.map(c => c.address)).toEqual([strategy]);
    expect(earnHealth(ctx, second.vault).lastTickAt).toBeNull();
  });

  it("runs the provided snapshot's strategy only, falling back to the flagship for an unlisted address", async () => {
    const ctx = multi({});
    const read: EarnDependencies["read"] = (_a, name, args) => Promise.resolve(name === "previewWithdraw" ? (args?.[0] as bigint) * E12 : 0n);
    await runEarn(ctx, { snapshot: () => Promise.resolve({ strategy: secondStrategy, loans: [], approvals: [approval("3")] }), read });
    expect(ctx.sender.calls.map(c => [c.functionName, c.address])).toEqual([["fund", second.vault]]);
    expect(Object.keys(ctx.state.earn ?? {})).toEqual([second.vault]);
    expect(vi.mocked(fetchEarnInput)).not.toHaveBeenCalled();
    await expect(runEarn(ctx, { snapshot: () => Promise.resolve({ strategy: { ...baseStrategy, address: bob, strategy: bob }, loans: [], approvals: [] }), read })).rejects.toThrow("Earn snapshot identity mismatch");
    expect(earnHealth(ctx).failures.map(f => f.action)).toEqual(["tick"]);
  });

  it("routes /health/earn to the flagship, ?strategy= to a listed strategy in any case, and 404 otherwise", () => {
    const ctx = multi({});
    expect(earnHealthResponse(ctx, "/health/earn")).toMatchObject({ status: 503, body: { strategy, mode: "dry-run" } });
    expect(earnHealthResponse(ctx, `/health/earn?strategy=${second.vault.toUpperCase().replace("0X", "0x")}`)).toMatchObject({ status: 503, body: { strategy: second.vault } });
    earnBucket(ctx.state, second.vault, strategy).lastTickAt = now;
    expect(earnHealthResponse(ctx, `http://keeper/health/earn?strategy=${second.vault}`).status).toBe(200);
    expect(earnHealthResponse(ctx, `/health/earn?strategy=${bob}`)).toEqual({ status: 404, body: { ok: false, error: "unknown_strategy", strategy: bob } });
    expect(() => earnHealth(ctx, bob)).toThrow("Unknown Earn strategy");
  });

  it("moves a legacy single Earn bucket under the flagship address on first access", () => {
    const legacy: EarnStrategyState = { lastTickAt: now - 5, failures: { "fund:1": { attempts: 2, retryAt: now + 20, firstAt: now - 30 } }, alerts: [] };
    const state = { ...emptyState(), earn: legacy as unknown as Record<string, EarnStrategyState> };
    const ctx = multi({});
    ctx.state = state;
    expect(earnHealth(ctx, second.vault).lastTickAt).toBeNull();
    expect(earnHealth(ctx)).toMatchObject({ lastTickAt: now - 5, failures: [{ action: "fund:1", attempts: 2 }] });
    expect(state.earn).toEqual({ [strategy]: legacy, [second.vault]: { lastTickAt: null, failures: {}, alerts: [] } });
    expect(earnBucket(state, strategy, strategy)).toBe(legacy);
  });
});
