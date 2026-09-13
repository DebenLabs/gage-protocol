import { describe, expect, it } from "vitest";
import { decideBoundaryPass, runStreamerBoundary, type BoundaryPass } from "../src/jobs/streamer-boundary.js";
import type { KeeperState } from "../src/state.js";
import type { EmissionsState, PoolKey, TransferLog, Views } from "../src/views.js";
import { A, m6Deployment, mockCtx, msgs, streamerDeployment } from "./helpers.js";

const EPOCH = 604_800;
const LEAD = 600;
const passes = (): KeeperState["streamerBoundary"] => ({ lastPre: undefined, lastPost: undefined });

describe("decideBoundaryPass", () => {
  const next = 10_000_000;
  const last = next - EPOCH;

  it("is idle before the lead window and after the post window", () => {
    expect(decideBoundaryPass({ now: next - LEAD - 1, nextBoundary: next, lastBoundary: last, leadSeconds: LEAD, passes: passes() })).toBeUndefined();
    expect(decideBoundaryPass({ now: next + LEAD, nextBoundary: next + EPOCH, lastBoundary: next, leadSeconds: LEAD, passes: passes() })).toBeUndefined();
    expect(decideBoundaryPass({ now: last + LEAD + 5, nextBoundary: next, lastBoundary: last, leadSeconds: LEAD, passes: passes() })).toBeUndefined();
  });

  it("runs the pre pass once inside the lead window, up to the last second before the boundary", () => {
    const p = passes();
    expect(decideBoundaryPass({ now: next - LEAD, nextBoundary: next, lastBoundary: last, leadSeconds: LEAD, passes: p }))
      .toEqual({ kind: "pre", boundary: next, preMissed: false });
    expect(decideBoundaryPass({ now: next - 1, nextBoundary: next, lastBoundary: last, leadSeconds: LEAD, passes: p }))
      .toEqual({ kind: "pre", boundary: next, preMissed: false });
    p.lastPre = { boundary: String(next), at: 0 };
    expect(decideBoundaryPass({ now: next - 1, nextBoundary: next, lastBoundary: last, leadSeconds: LEAD, passes: p })).toBeUndefined();
  });

  it("runs the post pass once shortly after the boundary, and flags a missing pre pass", () => {
    const p = passes();
    p.lastPre = { boundary: String(next), at: 0 };
    expect(decideBoundaryPass({ now: next, nextBoundary: next + EPOCH, lastBoundary: next, leadSeconds: LEAD, passes: p }))
      .toEqual({ kind: "post", boundary: next, preMissed: false });
    p.lastPost = { boundary: String(next), at: 0 };
    expect(decideBoundaryPass({ now: next + 1, nextBoundary: next + EPOCH, lastBoundary: next, leadSeconds: LEAD, passes: p })).toBeUndefined();
    expect(decideBoundaryPass({ now: next + 1, nextBoundary: next + EPOCH, lastBoundary: next, leadSeconds: LEAD, passes: passes() }))
      .toEqual({ kind: "post", boundary: next, preMissed: true });
  });

  it("never runs only after a boundary: a keeper that is up sees a pre pass strictly before every post pass", () => {
    const p = passes();
    const seen: (BoundaryPass & { now: number })[] = [];
    // Two boundaries, the clock ticking every minute across both.
    for (let now = next - 2 * LEAD; now < next + EPOCH + 2 * LEAD; now += 60) {
      const epochsIn = Math.floor((now - last) / EPOCH);
      const lastBoundary = last + epochsIn * EPOCH;
      const pass = decideBoundaryPass({ now, nextBoundary: lastBoundary + EPOCH, lastBoundary, leadSeconds: LEAD, passes: p });
      if (pass === undefined) continue;
      seen.push({ ...pass, now });
      if (pass.kind === "pre") p.lastPre = { boundary: String(pass.boundary), at: now };
      else p.lastPost = { boundary: String(pass.boundary), at: now };
    }
    expect(seen.map((s) => `${s.kind}:${s.boundary}`)).toEqual([`pre:${next}`, `post:${next}`, `pre:${next + EPOCH}`, `post:${next + EPOCH}`]);
    for (const s of seen) {
      if (s.kind === "pre") expect(s.now).toBeLessThan(s.boundary);
      else {
        expect(s.now).toBeGreaterThanOrEqual(s.boundary);
        expect(s.preMissed).toBe(false);
        expect(seen.find((o) => o.kind === "pre" && o.boundary === s.boundary)!.now).toBeLessThan(s.now);
      }
    }
  });

  it("brackets the schedule's last boundary only from the front", () => {
    expect(decideBoundaryPass({ now: next - 1, nextBoundary: undefined, lastBoundary: last, leadSeconds: LEAD, passes: passes() })).toBeUndefined();
    expect(decideBoundaryPass({ now: last + 1, nextBoundary: undefined, lastBoundary: last, leadSeconds: LEAD, passes: passes() }))
      .toEqual({ kind: "post", boundary: last, preMissed: true });
  });
});

const pool: PoolKey = { currency0: A.gage, currency1: A.sgage, fee: 30_000, tickSpacing: 60, hooks: A.hook };
const xfer = (tokenId: bigint): TransferLog => ({ from: A.zero, to: A.registry, tokenId, blockNumber: 1n });
const LAUNCH = 1_000n;

function emissions(currentEpoch: bigint): EmissionsState {
  return { launchAt: LAUNCH, currentEpoch, weeks: 52n, epochSeconds: BigInt(EPOCH), scheduleOver: false };
}

/** One live position (tokenId 1) in the pool. */
function inventory(currentEpoch: bigint): Partial<Views> {
  return {
    emissionsState: () => Promise.resolve(emissions(currentEpoch)),
    blockNumber: () => Promise.resolve(100n),
    transferLogs: () => Promise.resolve([xfer(1n)]),
    positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => pool)),
    positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 10n)),
    lpWeightedPositionLogs: () => Promise.resolve([]),
    lpPositionWeights: (_a, ids) => Promise.resolve(ids.map(() => 0n)),
  };
}

describe("runStreamerBoundary", () => {
  it("skips cleanly without the LPStreamer key", async () => {
    const ctx = mockCtx({ deployment: m6Deployment() });
    await runStreamerBoundary(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "job_skipped")?.missing).toEqual(["LPStreamer"]);
  });

  it("stays idle outside the window without touching the inventory", async () => {
    const boundary = Number(LAUNCH) + 3 * EPOCH;
    const ctx = mockCtx({ deployment: streamerDeployment(), now: (boundary - 5_000) * 1000,
      views: { emissionsState: () => Promise.resolve(emissions(2n)) } });
    await runStreamerBoundary(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(msgs(ctx)).toContain("streamer_boundary_idle");
  });

  it("checkpoints the streamer over the scoring inventory inside the lead window and records the pre pass", async () => {
    const boundary = Number(LAUNCH) + 3 * EPOCH;
    const now = (boundary - 300) * 1000;
    const ctx = mockCtx({ deployment: streamerDeployment(), now, views: inventory(2n) });
    await runStreamerBoundary(ctx);
    expect(ctx.sender.calls.map((c) => [c.label, c.address, c.args?.[0]])).toEqual([["LPStreamer.checkpointMany", A.streamer, [1n]]]);
    expect(ctx.state.streamerBoundary.lastPre).toEqual({ boundary: String(boundary), at: now });
    expect(ctx.state.streamerBoundary.lastPost).toBeUndefined();
    expect(ctx.lines.find((l) => l.msg === "streamer_boundary_pass")).toMatchObject({ kind: "pre", positions: 1 });
    // Once per boundary: the next tick inside the window sends nothing.
    await runStreamerBoundary(ctx);
    expect(ctx.sender.calls).toHaveLength(1);
  });

  it("runs the post pass after the boundary and warns when the pre pass never happened", async () => {
    const boundary = Number(LAUNCH) + 3 * EPOCH;
    const now = (boundary + 30) * 1000;
    const ctx = mockCtx({ deployment: streamerDeployment(), now, views: inventory(3n) });
    await runStreamerBoundary(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["LPStreamer.checkpointMany"]);
    expect(ctx.state.streamerBoundary.lastPost).toEqual({ boundary: String(boundary), at: now });
    expect(msgs(ctx)).toContain("streamer_boundary_pre_missed");
  });

  it("does not record a pass whose sends were refused", async () => {
    const boundary = Number(LAUNCH) + 3 * EPOCH;
    const ctx = mockCtx({ deployment: streamerDeployment(), now: (boundary - 100) * 1000, views: inventory(2n) });
    ctx.sender.script["LPStreamer.checkpointMany"] = { status: "refused", reason: "gas_below_floor" };
    await runStreamerBoundary(ctx);
    expect(ctx.state.streamerBoundary.lastPre).toBeUndefined();
    expect(msgs(ctx)).toContain("streamer_boundary_incomplete");
  });

  it("does nothing once the schedule is over", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), views: { emissionsState: () => Promise.resolve(emissions(52n)) } });
    await runStreamerBoundary(ctx);
    expect(ctx.sender.calls).toEqual([]);
  });
});
