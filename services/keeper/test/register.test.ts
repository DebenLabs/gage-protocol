import { describe, expect, it } from "vitest";
import { candidateDeals, runRegister } from "../src/jobs/register.js";
import { emptyState } from "../src/state.js";
import type { FundedLog } from "../src/views.js";
import { A, m6Deployment, mockCtx, msgs } from "./helpers.js";

const funded = (dealId: bigint, fee: bigint, fundedAt: number, term: number): FundedLog => ({
  dealId,
  bidId: dealId,
  lender: A.registry,
  price: 1_000_000_000n,
  fee,
  fundedAt: BigInt(fundedAt),
  expiry: BigInt(fundedAt + term),
  blockNumber: 150n,
});

describe("candidateDeals", () => {
  it("returns unregistered funded deals ascending, honouring backoff and the cap", () => {
    const s = emptyState();
    for (const id of ["3", "1", "2", "4"]) s.funded[id] = { dealId: id, fee: "1", price: "1", fundedAt: 0, expiry: 0 };
    s.registered = ["2"];
    s.registerRetryAfter["4"] = 10_000;
    expect(candidateDeals(s, 5_000, 10)).toEqual([1n, 3n]);
    expect(candidateDeals(s, 10_000, 10)).toEqual([1n, 3n, 4n]);
    expect(candidateDeals(s, 10_000, 1)).toEqual([1n]);
  });
});

describe("runRegister", () => {
  it("scans Funded logs from the start block and registers what DealRewards does not know", async () => {
    const ranges: [bigint, bigint][] = [];
    const ctx = mockCtx({
      deployment: m6Deployment(),
      env: { LOG_CHUNK_BLOCKS: "1000" },
      views: {
        blockNumber: () => Promise.resolve(2_500n),
        fundedLogs: (_v, from, to) => {
          ranges.push([from, to]);
          return Promise.resolve(from === 100n ? [funded(1n, 10n, 1_000, 604_800), funded(2n, 20n, 2_000, 1_814_400)] : []);
        },
        registered: (_a, ids) => Promise.resolve(ids.map((id) => id === 1n)),
      },
    });
    await runRegister(ctx);
    expect(ranges).toEqual([
      [100n, 1_099n],
      [1_100n, 2_099n],
      [2_100n, 2_500n],
    ]);
    expect(ctx.state.fundedCursor).toBe("2501");
    expect(Object.keys(ctx.state.funded)).toEqual(["1", "2"]);
    expect(ctx.state.registered).toEqual(["1"]);
    expect(ctx.sender.calls.map((c) => [c.label, c.args?.[0]])).toEqual([["DealRewards.register", 2n]]);
  });

  it("resumes from the cursor and backs off a reverting register", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      views: {
        blockNumber: () => Promise.resolve(3_000n),
        fundedLogs: (_v, from) => Promise.resolve(from === 2_501n ? [funded(3n, 5n, 3_000, 604_800)] : []),
        registered: () => Promise.resolve([false]),
      },
    });
    ctx.state.fundedCursor = "2501";
    ctx.sender.script["DealRewards.register"] = { status: "reverted", revert: { name: "DealNotFunded", args: [3n], message: "" } };
    await runRegister(ctx);
    expect(ctx.state.registerRetryAfter["3"]).toBe(ctx.now() + 3_600_000);
    await runRegister(ctx);
    expect(ctx.sender.calls).toHaveLength(1);
    expect(msgs(ctx)).toContain("register_nothing_to_do");
  });

  it("treats AlreadyRegistered as done and records sent registrations", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      views: {
        blockNumber: () => Promise.resolve(200n),
        fundedLogs: () => Promise.resolve([funded(1n, 1n, 1, 604_800), funded(2n, 1n, 1, 604_800)]),
        registered: (_a, ids) => Promise.resolve(ids.map(() => false)),
      },
    });
    ctx.sender.script["DealRewards.register"] = (call) =>
      call.args?.[0] === 1n
        ? { status: "reverted", revert: { name: "AlreadyRegistered", args: [1n], message: "" } }
        : { status: "sent", hash: "0x01", gasUsed: 1n, result: undefined };
    await runRegister(ctx);
    expect(ctx.state.registered.sort()).toEqual(["1", "2"]);
  });

  it("with M1 only: syncs Funded logs, then skips because DealRewards is absent", async () => {
    const ctx = mockCtx({
      views: { blockNumber: () => Promise.resolve(120n), fundedLogs: () => Promise.resolve([funded(1n, 1n, 1, 604_800)]) },
    });
    await runRegister(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.state.funded["1"]).toBeDefined();
    expect(ctx.lines.find((l) => l.msg === "job_skipped")?.missing).toEqual(["DealRewards"]);
  });
});
