/**
 * Swap watcher. Every `SWAP_WATCH_INTERVAL` (5s) it scans the PoolManager's `Swap` events for the GAGE/sGAGE pool
 * since its cursor and, when any swap happened, checkpoints every live position right away through the checkpoint
 * job.
 *
 * Why: LPRewards freezes a position's weight at its last checkpoint and `checkpointMany` is public. A swap that
 * moves the price, a checkpoint and a swap back inside one transaction leave stale weights until the next poke,
 * and rewards accrued meanwhile are never clawed back (contracts/test/fork/LPRewardsManipulation.fork.t.sol).
 * At the 2026-09-09 mainnet state that breaks even near 36 minutes of staleness and loses money at one block.
 * The hourly checkpoint job is the floor; this job closes the window to one scheduler tick.
 *
 * It deliberately never compares ticks or prices: the attack restores the price in the same transaction, so
 * "the tick is where it was" is exactly what an attack looks like. Any swap means a checkpoint.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { need, type JobContext } from "../context.js";
import { scanLogs } from "../scan.js";
import type { PoolKey } from "../views.js";
import { runCheckpoint } from "./checkpoint.js";

/** Uniswap v4 PoolId: keccak256(abi.encode(PoolKey)). Pure. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export async function runSwapWatch(ctx: JobContext): Promise<void> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "swapWatch", ["LPRewards", "PositionManager", "PoolManager"]);
  if (addrs === undefined) return;
  const [lpRewards, , poolManager] = addrs as [Address, Address, Address];
  const poolId = d.pools.gageSgage?.poolId ?? poolIdOf(await ctx.views.lpPoolKey(lpRewards));

  const head = await ctx.views.blockNumber();
  // First run starts at the head: history is the hourly job's business, this one reacts.
  const from = ctx.state.swapCursor === undefined ? head : BigInt(ctx.state.swapCursor);
  if (head < from) return;
  const { items, nextCursor } = await scanLogs(from, head, ctx.config.logChunkBlocks, (r) =>
    ctx.views.swapLogs(poolManager, poolId, r.fromBlock, r.toBlock),
  );
  if (items.length > 0) {
    const last = items[items.length - 1]!;
    ctx.state.lastSwapBlock = last.blockNumber.toString();
    ctx.log.info("swap_seen", { swaps: items.length, fromBlock: from, toBlock: head, lastBlock: last.blockNumber, tick: last.tick });
    // Throws on RPC trouble: the cursor then stays put and the next tick retries the same range.
    await runCheckpoint(ctx, { streamer: false });
    ctx.state.lastSwapCheckpoint = { block: head.toString(), at: ctx.now() };
  }
  ctx.state.swapCursor = nextCursor.toString();
}
