/**
 * Every 10 minutes: the `register` backstop. Every deal with a `Funded` event (so FUNDED, RECLAIMED or CLAIMED)
 * that DealRewards does not report as registered gets `register(dealId)`. The app registers right after
 * `accept`; this catches the ones it missed. Reservation order is registration order, so the scan is ascending.
 */
import { dealRewardsAbi } from "../abi.js";
import { need, type JobContext } from "../context.js";
import { KNOWN_START_BLOCKS } from "../deployment.js";
import { scanLogs } from "../scan.js";
import type { KeeperState } from "../state.js";

const RETRY_AFTER_REVERT_MS = 60 * 60 * 1000;

/** Where a fresh scan starts: env override, then the json's `startBlock`, then the known deploy block. */
export function scanStart(ctx: JobContext): bigint {
  const d = ctx.deployment();
  return ctx.config.scanFromBlock ?? d.startBlock ?? KNOWN_START_BLOCKS[ctx.config.chainId] ?? 0n;
}

/** Brings `state.funded` up to the chain head. Shared with the weekly proposal. */
export async function syncFunded(ctx: JobContext, vault: `0x${string}`): Promise<void> {
  const head = await ctx.views.blockNumber();
  const from = ctx.state.fundedCursor === undefined ? scanStart(ctx) : BigInt(ctx.state.fundedCursor);
  if (head < from) return;
  const { items, nextCursor } = await scanLogs(from, head, ctx.config.logChunkBlocks, (r) =>
    ctx.views.fundedLogs(vault, r.fromBlock, r.toBlock),
  );
  for (const l of items) {
    ctx.state.funded[l.dealId.toString()] = {
      dealId: l.dealId.toString(),
      fee: l.fee.toString(),
      price: l.price.toString(),
      fundedAt: Number(l.fundedAt),
      expiry: Number(l.expiry),
    };
  }
  ctx.state.fundedCursor = nextCursor.toString();
  ctx.log.info("funded_synced", { from, to: head, newLogs: items.length, total: Object.keys(ctx.state.funded).length });
}

/** Pure. Ascending deal ids worth asking DealRewards about, capped at `max`. */
export function candidateDeals(state: KeeperState, now: number, max: number): bigint[] {
  const registered = new Set(state.registered);
  return Object.keys(state.funded)
    .map((id) => BigInt(id))
    .filter((id) => !registered.has(id.toString()))
    .filter((id) => (state.registerRetryAfter[id.toString()] ?? 0) <= now)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, max);
}

export async function runRegister(ctx: JobContext): Promise<void> {
  const d = ctx.deployment();
  const vaultOnly = need(ctx, d, "register", ["DealVault"]);
  if (vaultOnly === undefined) return;
  const [vault] = vaultOnly as [`0x${string}`];
  await syncFunded(ctx, vault);

  const addrs = need(ctx, d, "register", ["DealRewards"]);
  if (addrs === undefined) return;
  const [dealRewards] = addrs as [`0x${string}`];

  const candidates = candidateDeals(ctx.state, ctx.now(), ctx.config.registerMaxPerRun);
  if (candidates.length === 0) {
    ctx.log.info("register_nothing_to_do", { funded: Object.keys(ctx.state.funded).length });
    return;
  }
  const flags = await ctx.views.registered(dealRewards, candidates);
  const todo: bigint[] = [];
  candidates.forEach((id, i) => {
    if (flags[i] === true) ctx.state.registered.push(id.toString());
    else todo.push(id);
  });
  ctx.log.info("register_candidates", { checked: candidates.length, alreadyRegistered: candidates.length - todo.length, toRegister: todo });

  for (const id of todo) {
    const out = await ctx.sender.execute({
      label: "DealRewards.register",
      address: dealRewards,
      abi: dealRewardsAbi,
      functionName: "register",
      args: [id],
    });
    if (out.status === "sent") ctx.state.registered.push(id.toString());
    else if (out.status === "reverted") {
      if (out.revert.name === "AlreadyRegistered") ctx.state.registered.push(id.toString());
      else ctx.state.registerRetryAfter[id.toString()] = ctx.now() + RETRY_AFTER_REVERT_MS;
    } else if (out.status === "refused") break;
  }
}
