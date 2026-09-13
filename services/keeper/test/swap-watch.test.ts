import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { poolIdOf, runSwapWatch } from "../src/jobs/swap-watch.js";
import type { PoolKey, SwapLog, Views } from "../src/views.js";
import { A, m6Deployment, mockCtx, msgs } from "./helpers.js";

const poolManager = "0x1000000000000000000000000000000000000B00" as Address;
const pool: PoolKey = { currency0: A.gage, currency1: A.sgage, fee: 30_000, tickSpacing: 60, hooks: A.hook };
const swap = (blockNumber: bigint, tick: number): SwapLog => ({ blockNumber, sender: A.registry, tick, sqrtPriceX96: 1n });

function deployment() {
  const d = m6Deployment();
  d.addresses.PoolManager = poolManager;
  return d;
}

/** A pool with one live position (tokenId 1) and the given swaps. */
function views(head: bigint, swaps: SwapLog[], extra: Partial<Views> = {}): Partial<Views> {
  return {
    blockNumber: () => Promise.resolve(head),
    swapLogs: (pm, id, from, to) => {
      expect(pm).toBe(poolManager);
      expect(id).toBe(deployment().pools.gageSgage!.poolId);
      return Promise.resolve(swaps.filter((s) => s.blockNumber >= from && s.blockNumber <= to));
    },
    transferLogs: () => Promise.resolve([{ from: A.zero, to: A.registry, tokenId: 1n, blockNumber: 1n }]),
    positionPoolKeys: (_a, ids) => Promise.resolve(ids.map(() => pool)),
    positionLiquidity: (_a, ids) => Promise.resolve(ids.map(() => 10n)),
    lpWeightedPositionLogs: () => Promise.resolve([]),
    lpPositionWeights: (_a, ids) => Promise.resolve(ids.map(() => 0n)),
    ...extra,
  };
}

describe("poolIdOf", () => {
  it("matches the live Robinhood Chain GAGE/sGAGE pool id", () => {
    const live: PoolKey = {
      currency0: "0x7163aE1B5AeA2f09EBc609C52b4dcAc0a7a4bC2d",
      currency1: "0x78c88CF8F6E612955526cEB501be82BF3279Bd5d",
      fee: 30_000,
      tickSpacing: 60,
      hooks: "0xB6D2C8A9bbd0468E2904a7E9B3Ab3De36e07C500",
    };
    expect(poolIdOf(live)).toBe("0xf81fda45e69648fa1fe7202a7a296cf532223d478d5a61872acba2e07cb1bfe8");
  });
});

describe("runSwapWatch", () => {
  it("skips cleanly without the PoolManager", async () => {
    const ctx = mockCtx({ deployment: m6Deployment() });
    await runSwapWatch(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "job_skipped")?.missing).toEqual(["PoolManager"]);
  });

  it("starts at the head on its first run and sends nothing", async () => {
    const ctx = mockCtx({ deployment: deployment(), views: views(500n, [swap(450n, 28_900)]) });
    await runSwapWatch(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.state.swapCursor).toBe("501");
    expect(ctx.state.lastSwapBlock).toBeUndefined();
  });

  it("does nothing while no swap lands, and keeps the cursor moving", async () => {
    const ctx = mockCtx({ deployment: deployment(), views: views(500n, []) });
    ctx.state.swapCursor = "400";
    await runSwapWatch(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.state.swapCursor).toBe("501");
  });

  it("checkpoints every live position after a swap, even when the tick ends where it started", async () => {
    // The attack shape: price out, checkpoint, price back, all in one block. The tick is unchanged afterwards.
    const ctx = mockCtx({ deployment: deployment(), views: views(500n, [swap(450n, 28_799), swap(450n, 28_860)]) });
    ctx.state.swapCursor = "400";
    await runSwapWatch(ctx);
    expect(ctx.sender.calls.map((c) => [c.label, c.args?.[0]])).toEqual([["LPRewards.checkpointMany", [1n]]]);
    expect(ctx.state.lastSwapBlock).toBe("450");
    expect(ctx.state.lastSwapCheckpoint).toEqual({ block: "500", at: ctx.now() });
    expect(ctx.state.swapCursor).toBe("501");
    expect(msgs(ctx)).toContain("swap_seen");
    expect(msgs(ctx)).toContain("checkpoint_positions");
  });

  it("keeps the cursor when the checkpoint fails so the next tick retries the same swaps", async () => {
    const ctx = mockCtx({
      deployment: deployment(),
      views: views(500n, [swap(450n, 28_799)], { transferLogs: () => Promise.reject(new Error("rpc down")) }),
    });
    ctx.state.swapCursor = "400";
    await expect(runSwapWatch(ctx)).rejects.toThrow("rpc down");
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.state.swapCursor).toBe("400");
    expect(ctx.state.lastSwapCheckpoint).toBeUndefined();
  });

  it("derives the pool id from LPRewards.poolKey when the deployment has no pools entry", async () => {
    const d = deployment();
    const expected = d.pools.gageSgage!.poolId;
    d.pools = {};
    const seen: string[] = [];
    const ctx = mockCtx({
      deployment: d,
      views: {
        ...views(500n, []),
        lpPoolKey: () => Promise.resolve(pool),
        swapLogs: (_pm, id) => {
          seen.push(id);
          return Promise.resolve([]);
        },
      },
    });
    ctx.state.swapCursor = "400";
    await runSwapWatch(ctx);
    expect(seen).toEqual([poolIdOf(pool)]);
    expect(poolIdOf(pool)).not.toBe(expected); // the fixture's placeholder id is not the real hash
  });
});
