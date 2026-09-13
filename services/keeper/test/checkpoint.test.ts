import { describe, expect, it } from "vitest";
import type { PublicClient, Transport, Chain } from "viem";
import { applyTransfers, batches, parsePositionsPage, poolPositions, runCheckpoint, samePool } from "../src/jobs/checkpoint.js";
import { emptyState } from "../src/state.js";
import type { PoolKey, TransferLog } from "../src/views.js";
import { A, m6Deployment, mockCtx, msgs, streamerDeployment } from "./helpers.js";

const pool: PoolKey = { currency0: A.gage, currency1: A.sgage, fee: 30_000, tickSpacing: 60, hooks: A.hook };
const lpReads = {
  lpWeightedPositionLogs: () => Promise.resolve([] as bigint[]),
  lpPositionWeights: (_a: unknown, ids: readonly bigint[]) => Promise.resolve(ids.map(() => 0n)),
};
const other: PoolKey = { ...pool, hooks: A.zero };
const xfer = (tokenId: bigint, to = A.registry, from = A.zero): TransferLog => ({ from, to, tokenId, blockNumber: 1n });

describe("pure helpers", () => {
  it("samePool compares every PoolKey field case-insensitively", () => {
    expect(samePool(pool, { ...pool, currency0: pool.currency0.toLowerCase() as `0x${string}` })).toBe(true);
    expect(samePool(pool, other)).toBe(false);
    expect(samePool(pool, { ...pool, fee: 3_000 })).toBe(false);
  });
  it("applyTransfers tracks mints, burns and re-mints", () => {
    const s = emptyState();
    s.positionPool["1"] = true;
    expect(applyTransfers(s, [xfer(1n), xfer(2n), xfer(3n), xfer(3n, A.zero, A.registry)])).toEqual([2n]);
    expect(s.burned).toEqual(["3"]);
    s.positionPool["2"] = true;
    s.positionPool["3"] = true;
    expect(poolPositions(s)).toEqual([1n, 2n]);
  });
  it("batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });
  it("parsePositionsPage accepts the three shapes", () => {
    expect(parsePositionsPage({ positions: [{ tokenId: "7" }] })).toEqual({ tokenIds: [7n], nextCursor: undefined });
    expect(parsePositionsPage({ items: [{ tokenId: 8 }], nextCursor: "c" })).toEqual({ tokenIds: [8n], nextCursor: "c" });
    expect(parsePositionsPage({ tokenIds: ["9"], nextCursor: null })).toEqual({ tokenIds: [9n], nextCursor: undefined });
  });
});

describe("runCheckpoint", () => {
  it("repairs an empty position with positive weight instead of skipping it", async () => {
    const ctx = mockCtx({ deployment: m6Deployment(), views: {
      ...lpReads,
      blockNumber: () => Promise.resolve(200n),
      transferLogs: () => Promise.resolve([xfer(7n), xfer(8n)]),
      positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => pool)),
      positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 0n)),
      lpPositionWeights: (_a, ids) => Promise.resolve(ids.map(id => id === 7n ? 100n : 0n)),
    }});
    await runCheckpoint(ctx);
    expect(ctx.sender.calls.map(c => c.args?.[0])).toEqual([[7n]]);
    expect(ctx.lines.find(l => l.msg === "checkpoint_stale_position_weight")?.tokenIds).toEqual(["7"]);
  });

  it("recovers a burned position discovered only through reward events and retains it across cycles", async () => {
    let weight = 100n;
    let scans = 0;
    const ctx = mockCtx({ deployment: m6Deployment(), views: {
      blockNumber: () => Promise.resolve(200n),
      transferLogs: () => Promise.resolve([xfer(9n), xfer(9n, A.zero, A.registry)]),
      positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => undefined)),
      positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 0n)),
      lpWeightedPositionLogs: () => { scans++; return Promise.resolve([9n]); },
      lpPositionWeights: (_a, ids) => Promise.resolve(ids.map(() => weight)),
    }});
    ctx.publicClient = { readContract: () => Promise.reject(new Error("burned NFT")) } as unknown as PublicClient<Transport, Chain>;
    await runCheckpoint(ctx);
    expect(ctx.sender.calls.map(c => c.args?.[0])).toEqual([[9n]]);
    expect(ctx.state.lpRewardPositions).toEqual(["9"]);
    weight = 0n;
    await runCheckpoint(ctx);
    expect(ctx.sender.calls).toHaveLength(1);
    expect(scans).toBe(1);
  });

  it("does not interpret a failed reward-state read as zero weight", async () => {
    const ctx = mockCtx({ deployment: m6Deployment(), views: {
      ...lpReads,
      blockNumber: () => Promise.resolve(200n),
      transferLogs: () => Promise.resolve([]),
      lpWeightedPositionLogs: () => Promise.resolve([9n]),
      lpPositionWeights: () => Promise.reject(new Error("RPC unavailable")),
    }});
    await expect(runCheckpoint(ctx)).rejects.toThrow("RPC unavailable");
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.state.lpRewardPositions).toEqual(["9"]);
  });

  it("clears stale weight on a position transferred to the excluded floor", async () => {
    const ctx = mockCtx({ deployment: m6Deployment(), views: {
      ...lpReads,
      blockNumber: () => Promise.resolve(200n),
      transferLogs: () => Promise.resolve([]),
      lpWeightedPositionLogs: () => Promise.resolve([9n]),
      lpPositionWeights: () => Promise.resolve([100n]),
      positionLiquidity: () => Promise.resolve([10n]),
    }});
    ctx.publicClient = { readContract: () => Promise.resolve(A.splitter) } as unknown as PublicClient<Transport, Chain>;
    await runCheckpoint(ctx);
    expect(ctx.sender.calls.map(c => c.args?.[0])).toEqual([[9n]]);
  });

  it("does not spend gas checkpointing the excluded seed or protocol floor bands", async () => {
    const deployment=m6Deployment();
    deployment.seed={tokenId:1n,releaseAt:0,codeHash:`0x${"11".repeat(32)}`,owner:A.registry};
    const ctx=mockCtx({deployment,views:{
      ...lpReads,
      blockNumber:()=>Promise.resolve(100n),
      transferLogs:()=>Promise.resolve([xfer(1n),xfer(2n),xfer(3n)]),
      positionPoolKeys:(_a,ids)=>Promise.resolve(ids.map(()=>pool)),
      positionLiquidity:(_a,ids)=>Promise.resolve(ids.map(()=>10n)),
    }});
    ctx.publicClient={readContract:(r:{args:bigint[]})=>Promise.resolve(r.args[0]===2n?A.splitter:A.registry)} as unknown as PublicClient<Transport,Chain>;
    await runCheckpoint(ctx);
    expect(ctx.sender.calls.map(c=>c.args?.[0])).toEqual([[3n]]);
  });
  it("skips cleanly without LPRewards", async () => {
    const ctx = mockCtx();
    await runCheckpoint(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "job_skipped")?.missing).toEqual(["LPRewards", "PositionManager"]);
  });

  it("scans transfers, classifies by pool, and checkpoints live positions in batches", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      env: { CHECKPOINT_BATCH: "2" },
      views: {
        ...lpReads,
        blockNumber: () => Promise.resolve(500n),
        transferLogs: (_a, from) => Promise.resolve(from === 100n ? [xfer(1n), xfer(2n), xfer(3n), xfer(4n), xfer(4n, A.zero, A.registry)] : []),
        positionPoolKeys: (_a, ids) => Promise.resolve(ids.map((id) => (id === 2n ? other : pool))),
        positionLiquidity: (_a, ids) => Promise.resolve(ids.map((id) => (id === 3n ? 0n : 10n))),
      },
    });
    await runCheckpoint(ctx);
    expect(ctx.state.positionPool).toEqual({ "1": true, "2": false, "3": true });
    expect(ctx.state.burned).toEqual(["4"]);
    expect(ctx.state.positionCursor).toBe("501");
    expect(ctx.sender.calls.map((c) => [c.label, c.args?.[0]])).toEqual([["LPRewards.checkpointMany", [1n]]]);
    expect(msgs(ctx)).toContain("checkpoint_positions");
  });

  it("checkpoints the streamer over the same batches right after LPRewards when it is deployed", async () => {
    const ctx = mockCtx({
      deployment: streamerDeployment(),
      env: { CHECKPOINT_BATCH: "2" },
      views: {
        ...lpReads,
        blockNumber: () => Promise.resolve(100n),
        transferLogs: () => Promise.resolve([xfer(1n), xfer(2n), xfer(3n)]),
        positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => pool)),
        positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 10n)),
      },
    });
    await runCheckpoint(ctx);
    expect(ctx.sender.calls.map((c) => [c.label, c.address, c.args?.[0]])).toEqual([
      ["LPRewards.checkpointMany", A.lpRewards, [1n, 2n]],
      ["LPRewards.checkpointMany", A.lpRewards, [3n]],
      ["LPStreamer.checkpointMany", A.streamer, [1n, 2n]],
      ["LPStreamer.checkpointMany", A.streamer, [3n]],
    ]);
  });

  it("leaves the streamer out when asked to, as the swap watcher does", async () => {
    const ctx = mockCtx({
      deployment: streamerDeployment(),
      views: {
        ...lpReads,
        blockNumber: () => Promise.resolve(100n),
        transferLogs: () => Promise.resolve([xfer(1n)]),
        positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => pool)),
        positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 10n)),
      },
    });
    await runCheckpoint(ctx, { streamer: false });
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["LPRewards.checkpointMany"]);
  });

  it("sends nothing to the streamer when the LPStreamer key is absent", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      views: {
        ...lpReads,
        blockNumber: () => Promise.resolve(100n),
        transferLogs: () => Promise.resolve([xfer(1n)]),
        positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => pool)),
        positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 10n)),
      },
    });
    await runCheckpoint(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["LPRewards.checkpointMany"]);
  });

  it("uses LPRewards.poolKey when the deployment json has no pools entry", async () => {
    const d = m6Deployment();
    d.pools = {};
    const ctx = mockCtx({
      deployment: d,
      views: {
        ...lpReads,
        lpPoolKey: () => Promise.resolve(pool),
        blockNumber: () => Promise.resolve(100n),
        transferLogs: () => Promise.resolve([xfer(5n), xfer(6n)]),
        positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => pool)),
        positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 1n)),
      },
    });
    await runCheckpoint(ctx);
    expect(ctx.sender.calls[0]?.args?.[0]).toEqual([5n, 6n]);
  });
});
