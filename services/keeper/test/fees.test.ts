import { describe, expect, it } from "vitest";
import { FeeRoute } from "../src/abi.js";
import { decideBuybackClip, decideFeeSink, decideSplit, runFees } from "../src/jobs/fees.js";
import { A, m1Deployment, m6Deployment, mockCtx, msgs } from "./helpers.js";

describe("decideFeeSink", () => {
  it("collects and sweeps when the vault has credited fees", () => {
    expect(decideFeeSink({ credited: 5n, held: 0n, route: FeeRoute.TREASURY, buyback: A.zero, minSweep: 0n })).toEqual({
      collect: true,
      sweep: true,
      reason: "ok",
    });
  });
  it("does nothing when nothing is owed or held", () => {
    expect(decideFeeSink({ credited: 0n, held: 0n, route: FeeRoute.TREASURY, buyback: A.zero, minSweep: 0n }).sweep).toBe(false);
  });
  it("sweeps what is already held without collecting", () => {
    const d = decideFeeSink({ credited: 0n, held: 7n, route: FeeRoute.TREASURY, buyback: A.zero, minSweep: 0n });
    expect(d).toEqual({ collect: false, sweep: true, reason: "ok" });
  });
  it("respects the minimum sweep and the unset buyback route", () => {
    expect(decideFeeSink({ credited: 1n, held: 1n, route: FeeRoute.TREASURY, buyback: A.zero, minSweep: 10n }).reason).toBe("below_min_sweep");
    expect(decideFeeSink({ credited: 1n, held: 1n, route: FeeRoute.BUYBACK, buyback: A.zero, minSweep: 0n }).reason).toBe("buyback_route_unset");
    expect(decideFeeSink({ credited: 1n, held: 1n, route: FeeRoute.BUYBACK, buyback: A.buyback, minSweep: 0n }).sweep).toBe(true);
  });
});

describe("decideBuybackClip / decideSplit", () => {
  it("clips at min(balance, maxClip) above the threshold", () => {
    expect(decideBuybackClip({ balance: 100n, threshold: 100n, maxClip: 50n })).toBeUndefined();
    expect(decideBuybackClip({ balance: 101n, threshold: 100n, maxClip: 50n })).toBe(50n);
    expect(decideBuybackClip({ balance: 101n, threshold: 100n, maxClip: 500n })).toBe(101n);
  });
  it("splits strictly above the threshold", () => {
    expect(decideSplit({ balance: 1n, threshold: 1n })).toBe(false);
    expect(decideSplit({ balance: 2n, threshold: 1n })).toBe(true);
  });
});

describe("runFees", () => {
  it("with M1 only: collects and sweeps a credited fee, skips the token-layer steps cleanly", async () => {
    const ctx = mockCtx({
      views: {
        feeSinkState: () => Promise.resolve({ vault: A.vault, route: FeeRoute.TREASURY, buyback: A.zero, treasury: A.registry }),
        vaultBalanceUSDG: () => Promise.resolve(40_000_000n),
        erc20Balance: () => Promise.resolve(0n),
      },
    });
    await runFees(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["FeeSink.collect"]);
    expect(msgs(ctx)).toContain("would_send_after_collect");
    const skipped = ctx.lines.filter((l) => l.msg === "job_skipped").map((l) => l.job);
    expect(skipped).toEqual(["fees.buyback", "fees.creatorFeeSplitter"]);
  });

  it("live mode sweeps right after collecting", async () => {
    const ctx = mockCtx({
      env: { KEEPER_KEY: `0x${"11".repeat(32)}`, DRY_RUN: "false" },
      views: {
        feeSinkState: () => Promise.resolve({ vault: A.vault, route: FeeRoute.TREASURY, buyback: A.zero, treasury: A.registry }),
        vaultBalanceUSDG: () => Promise.resolve(40_000_000n),
        erc20Balance: () => Promise.resolve(0n),
      },
    });
    ctx.sender.script["FeeSink.collect"] = { status: "sent", hash: "0x01", gasUsed: 1n, result: 40_000_000n };
    await runFees(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["FeeSink.collect", "FeeSink.sweep"]);
  });

  it("with M1 only and no fees: sends nothing", async () => {
    const ctx = mockCtx({
      views: {
        feeSinkState: () => Promise.resolve({ vault: A.vault, route: FeeRoute.TREASURY, buyback: A.zero, treasury: A.registry }),
        vaultBalanceUSDG: () => Promise.resolve(0n),
        erc20Balance: () => Promise.resolve(0n),
      },
    });
    await runFees(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(msgs(ctx)).toContain("feesink_state");
  });

  it("with the token layer: buys back a clip and retries at the contract's bound", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      env: { MAX_CLIP_USDG: "1000" },
      views: {
        feeSinkState: () => Promise.resolve({ vault: A.vault, route: FeeRoute.BUYBACK, buyback: A.buyback, treasury: A.registry }),
        vaultBalanceUSDG: () => Promise.resolve(0n),
        erc20Balance: (_t, owner) => Promise.resolve(owner === A.buyback ? 5_000_000_000n : 0n),
        threshold: (c) => Promise.resolve(c === A.buyback ? 100_000_000n : 10n ** 18n),
        balance: () => Promise.resolve(0n),
      },
    });
    let first = true;
    ctx.sender.script["Buyback.buyback"] = () => {
      if (first) {
        first = false;
        return { status: "reverted", revert: { name: "ClipTooLarge", args: [1_000_000_000n, 250_000_000n], message: "" } };
      }
      return { status: "dry", result: 1n };
    };
    ctx.sender.script["CreatorFeeSplitter.claim"] = { status: "skipped", result: 0n };
    await runFees(ctx);
    const buys = ctx.sender.calls.filter((c) => c.label === "Buyback.buyback").map((c) => c.args?.[0]);
    expect(buys).toEqual([1_000_000_000n, 250_000_000n]);
    expect(ctx.sender.calls.map((c) => c.label)).not.toContain("CreatorFeeSplitter.split");
  });

  it("splits creator fees above the threshold, counting a simulated claim", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      views: {
        feeSinkState: () => Promise.resolve({ vault: A.vault, route: FeeRoute.BUYBACK, buyback: A.buyback, treasury: A.registry }),
        vaultBalanceUSDG: () => Promise.resolve(0n),
        erc20Balance: () => Promise.resolve(0n),
        threshold: () => Promise.resolve(10n ** 18n),
        balance: () => Promise.resolve(6n * 10n ** 17n),
      },
    });
    ctx.sender.script["CreatorFeeSplitter.claim"] = { status: "dry", result: 5n * 10n ** 17n };
    await runFees(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["CreatorFeeSplitter.claim", "CreatorFeeSplitter.split"]);
  });

  it("skips everything when even the vault is missing", async () => {
    const ctx = mockCtx({ deployment: { ...m1Deployment(), addresses: {} } });
    await runFees(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.filter((l) => l.msg === "job_skipped")).toHaveLength(3);
  });
});
