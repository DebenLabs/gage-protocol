/**
 * Hourly: checkpoint every position in the GAGE/sGAGE pool through `LPRewards.checkpointMany` in batches, then
 * through `LPStreamer.checkpointMany` over the same inventory when the streamer is deployed (D64).
 *
 * Position discovery, two sources (env POSITIONS_SOURCE):
 *  - "chain" (default): scan PositionManager `Transfer` events from the deploy block, classify each new tokenId
 *    once with `getPoolAndPositionInfo` against `LPRewards.poolKey()` (or `pools.gageSgage` from the deployment
 *    json), remember the answer, drop tokenIds burned (transferred to the zero address). Resumes from a cursor.
 *  - a URL: an HTTP endpoint returning `{ positions: [{ tokenId }] }`, `{ items: [{ tokenId }], nextCursor }` or
 *    `{ tokenIds: [] }`, followed through `?cursor=` pages. docs/api.md only lists `/positions/:wallet`, so this
 *    is for an indexer that adds a pool-wide listing; the chain scan needs nothing from anyone.
 * Also inventory positive Checkpointed events from LPRewards: a failed removal callback can leave weight on
 * an empty or burned position. Those positions must be repaired even when absent from the ownership source.
 * This backstop stops future accrual; the immutable contract still credits the interval before repair.
 */
import { lpRewardsAbi, lpStreamerAbi } from "../abi.js";
import { erc721Abi, type Address } from "viem";
import { need, type JobContext } from "../context.js";
import { KNOWN_START_BLOCKS, type Deployment } from "../deployment.js";
import { scanLogs } from "../scan.js";
import type { KeeperState } from "../state.js";
import type { PoolKey, TransferLog } from "../views.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export function samePool(a: PoolKey, b: PoolKey): boolean {
  return (
    a.currency0.toLowerCase() === b.currency0.toLowerCase() &&
    a.currency1.toLowerCase() === b.currency1.toLowerCase() &&
    Number(a.fee) === Number(b.fee) &&
    Number(a.tickSpacing) === Number(b.tickSpacing) &&
    a.hooks.toLowerCase() === b.hooks.toLowerCase()
  );
}

/** Pure. Applies transfers to the state; returns tokenIds that still need classifying. */
export function applyTransfers(state: KeeperState, logs: readonly TransferLog[]): bigint[] {
  const burned = new Set(state.burned);
  const unknown = new Set<string>();
  for (const l of logs) {
    const id = l.tokenId.toString();
    if (l.to.toLowerCase() === ZERO) {
      burned.add(id);
      unknown.delete(id);
      continue;
    }
    burned.delete(id);
    if (!(id in state.positionPool)) unknown.add(id);
  }
  state.burned = [...burned];
  return [...unknown].map((id) => BigInt(id));
}

/** Pure. Live tokenIds of the pool, ascending. */
export function poolPositions(state: KeeperState): bigint[] {
  const burned = new Set(state.burned);
  return Object.entries(state.positionPool)
    .filter(([id, inPool]) => inPool && !burned.has(id))
    .map(([id]) => BigInt(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function batches<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("batch size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface PositionsPage {
  positions?: { tokenId: string | number }[];
  items?: { tokenId: string | number }[];
  tokenIds?: (string | number)[];
  nextCursor?: string | null;
}

/** Pure over the page shape: tokenIds in a page and the cursor to follow. */
export function parsePositionsPage(body: unknown): { tokenIds: bigint[]; nextCursor: string | undefined } {
  const page = (typeof body === "object" && body !== null ? body : {}) as PositionsPage;
  const list = page.positions ?? page.items ?? [];
  const ids = [...list.map((p) => p.tokenId), ...(page.tokenIds ?? [])].map((v) => BigInt(v));
  return { tokenIds: ids, nextCursor: page.nextCursor ?? undefined };
}

async function positionsFromUrl(ctx: JobContext, url: string): Promise<bigint[]> {
  const ids = new Set<bigint>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const u = new URL(url);
    if (cursor !== undefined) u.searchParams.set("cursor", cursor);
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`positions source ${u.toString()} returned ${res.status}`);
    const parsed = parsePositionsPage(await res.json());
    parsed.tokenIds.forEach((id) => ids.add(id));
    if (parsed.nextCursor === undefined || parsed.nextCursor === cursor) break;
    cursor = parsed.nextCursor;
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function positionsFromChain(ctx: JobContext, positionManager: `0x${string}`, pool: PoolKey): Promise<bigint[]> {
  const head = await ctx.views.blockNumber();
  const start =
    ctx.config.scanFromBlock ?? ctx.deployment().startBlock ?? KNOWN_START_BLOCKS[ctx.config.chainId] ?? 0n;
  const from = ctx.state.positionCursor === undefined ? start : BigInt(ctx.state.positionCursor);
  if (head >= from) {
    const { items, nextCursor } = await scanLogs(from, head, ctx.config.logChunkBlocks, (r) =>
      ctx.views.transferLogs(positionManager, r.fromBlock, r.toBlock),
    );
    const unknown = applyTransfers(ctx.state, items);
    for (const chunk of batches(unknown, 200)) {
      const keys = await ctx.views.positionPoolKeys(positionManager, chunk);
      chunk.forEach((id, i) => {
        const k = keys[i];
        ctx.state.positionPool[id.toString()] = k !== undefined && samePool(k, pool);
      });
    }
    ctx.state.positionCursor = nextCursor.toString();
    ctx.log.info("positions_synced", { from, to: head, transfers: items.length, classified: unknown.length });
  }
  return poolPositions(ctx.state);
}

async function rewardPositions(ctx: JobContext, lpRewards: `0x${string}`): Promise<bigint[]> {
  if (ctx.state.lpRewardContract !== lpRewards.toLowerCase()) {
    ctx.state.lpRewardContract = lpRewards.toLowerCase();
    ctx.state.lpRewardCursor = undefined;
    ctx.state.lpRewardPositions = [];
  }
  const head = await ctx.views.blockNumber();
  const from = ctx.state.lpRewardCursor === undefined
    ? ctx.config.scanFromBlock ?? ctx.deployment().startBlock ?? KNOWN_START_BLOCKS[ctx.config.chainId] ?? 0n
    : BigInt(ctx.state.lpRewardCursor);
  if (head >= from) {
    const { items, nextCursor } = await scanLogs(from, head, ctx.config.logChunkBlocks,
      range => ctx.views.lpWeightedPositionLogs(lpRewards, range.fromBlock, range.toBlock));
    ctx.state.lpRewardPositions = [...new Set([...ctx.state.lpRewardPositions, ...items.map(String)])];
    ctx.state.lpRewardCursor = nextCursor.toString();
  }
  return ctx.state.lpRewardPositions.map(BigInt);
}

/**
 * The scoring inventory: every position of the GAGE/sGAGE pool that carries reward weight or live liquidity (the
 * seed and the protocol floor's bands excluded unless they hold stale weight). Syncs the discovery cursors and logs
 * one `checkpoint_positions` line. Shared by the hourly job, the swap watcher and the streamer boundary job.
 */
export async function scoringPositions(ctx: JobContext, d: Deployment, lpRewards: Address, positionManager: Address): Promise<bigint[]> {
  const pool = d.pools.gageSgage ?? (await ctx.views.lpPoolKey(lpRewards));

  const source = ctx.config.positionsSource;
  const discovered = source === "chain" ? await positionsFromChain(ctx, positionManager, pool) : await positionsFromUrl(ctx, source);
  const all = [...new Set([...discovered, ...await rewardPositions(ctx, lpRewards)].map(String))].map(BigInt);
  const eligible = all.filter(id => id !== d.seed?.tokenId);
  const weights: bigint[] = [];
  for (const chunk of batches(eligible, 200)) weights.push(...await ctx.views.lpPositionWeights(lpRewards, chunk));
  const floor = d.addresses.CreatorFeeSplitter;
  const pub = ctx.publicClient;
  let excluded = eligible.map(() => false);
  if (floor && pub) {
    const owners = await Promise.all(eligible.map(async id => {
      try { return await pub.readContract({address: positionManager, abi: erc721Abi, functionName: "ownerOf", args: [id]}); }
      catch { return undefined; }
    }));
    excluded = owners.map(owner => owner === undefined || owner.toLowerCase() === floor.toLowerCase());
  }
  const liquidity = await ctx.views.positionLiquidity(positionManager, eligible);
  const stale = eligible.filter((_, i) => weights[i]! > 0n && ((liquidity[i] ?? 0n) === 0n || excluded[i]));
  const live = eligible.filter((_, i) => weights[i]! > 0n || ((liquidity[i] ?? 0n) > 0n && !excluded[i]));
  if (stale.length) ctx.log.warn("checkpoint_stale_position_weight", { tokenIds: stale.map(String) });
  ctx.log.info("checkpoint_positions", { source, known: all.length,
    withLiquidity: liquidity.filter(l => l > 0n).length, staleWeight: stale.length, scheduled: live.length });
  return live;
}

/** `LPStreamer.checkpointMany` over `tokenIds` in the configured batches. Returns false when a send was refused. */
export async function checkpointStreamer(ctx: JobContext, streamer: Address, tokenIds: readonly bigint[]): Promise<boolean> {
  for (const batch of batches(tokenIds, ctx.config.checkpointBatch)) {
    const out = await ctx.sender.execute({
      label: "LPStreamer.checkpointMany",
      address: streamer,
      abi: lpStreamerAbi,
      functionName: "checkpointMany",
      args: [batch],
    });
    if (out.status === "refused") return false;
  }
  return true;
}

/**
 * @param opts.streamer Also run the streamer pass (default). The swap watcher passes false: a swap changes LPRewards
 *        weights, not what the streamer credits, so a streamer checkpoint per swap would only spend gas.
 */
export async function runCheckpoint(ctx: JobContext, opts: { streamer?: boolean } = {}): Promise<void> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "checkpoint", ["LPRewards", "PositionManager"]);
  if (addrs === undefined) return;
  const [lpRewards, positionManager] = addrs as [Address, Address];
  const live = await scoringPositions(ctx, d, lpRewards, positionManager);

  for (const batch of batches(live, ctx.config.checkpointBatch)) {
    const out = await ctx.sender.execute({
      label: "LPRewards.checkpointMany",
      address: lpRewards,
      abi: lpRewardsAbi,
      functionName: "checkpointMany",
      args: [batch],
    });
    if (out.status === "refused") return;
  }
  // The streamer credits the LPRewards accrual since its last look; same inventory, right after (D64).
  const streamer = d.addresses.LPStreamer;
  if (streamer !== undefined && (opts.streamer ?? true)) await checkpointStreamer(ctx, streamer, live);
}
