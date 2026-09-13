/**
 * Every 30 minutes: FeeSink.collect() then FeeSink.sweep() when the vault has credited fees (M1, live today);
 * Buyback.buyback(clip) above its threshold; CreatorFeeSplitter.claim()/split() above its threshold (M6).
 */
import type { Chain, PublicClient, Transport } from "viem";
import { forwardLPFees } from "./lp-fees.js";
import { runFloorFees } from "./floor-fees.js";
import { buybackAbi, creatorFeeSplitterAbi, feeSinkAbi, FeeRoute } from "../abi.js";
import { parseDecimal } from "../config.js";
import { need, type JobContext } from "../context.js";
import type { Deployment } from "../deployment.js";

export interface FeeSinkDecision {
  collect: boolean;
  sweep: boolean;
  reason: string;
}

/** Pure. `credited` is the vault's internal balance for FeeSink; `held` is FeeSink's own USDG balance. */
export function decideFeeSink(i: {
  credited: bigint;
  held: bigint;
  route: number;
  buyback: string;
  minSweep: bigint;
}): FeeSinkDecision {
  const collect = i.credited > 0n;
  const afterCollect = i.held + i.credited;
  if (afterCollect === 0n) return { collect, sweep: false, reason: "nothing_to_sweep" };
  if (afterCollect < i.minSweep) return { collect, sweep: false, reason: "below_min_sweep" };
  if (i.route === FeeRoute.BUYBACK && BigInt(i.buyback) === 0n) {
    return { collect, sweep: false, reason: "buyback_route_unset" };
  }
  return { collect, sweep: true, reason: "ok" };
}

/** Pure. The clip to buy back, or undefined when the balance does not exceed the threshold. */
export function decideBuybackClip(i: { balance: bigint; threshold: bigint; maxClip: bigint }): bigint | undefined {
  if (i.balance <= i.threshold || i.balance === 0n) return undefined;
  return i.balance < i.maxClip ? i.balance : i.maxClip;
}

export function decideSplit(i: { balance: bigint; threshold: bigint }): boolean {
  return i.balance > i.threshold && i.balance > 0n;
}

async function feeSinkStep(ctx: JobContext, d: Deployment): Promise<void> {
  const addrs = need(ctx, d, "fees.feeSink", ["FeeSink", "DealVault", "USDG"]);
  if (addrs === undefined) return;
  const [feeSink, vault, usdg] = addrs as [`0x${string}`, `0x${string}`, `0x${string}`];
  const [sink, credited, held, decimals] = await Promise.all([
    ctx.views.feeSinkState(feeSink),
    ctx.views.vaultBalanceUSDG(vault, feeSink),
    ctx.views.erc20Balance(usdg, feeSink),
    ctx.usdgDecimals(),
  ]);
  if (BigInt(sink.vault) === 0n) {
    ctx.log.warn("feesink_vault_unset", { feeSink });
    return;
  }
  const decision = decideFeeSink({
    credited,
    held,
    route: sink.route,
    buyback: sink.buyback,
    minSweep: parseDecimal(ctx.config.feeSweepMinUsdg, decimals),
  });
  ctx.log.info("feesink_state", { credited, held, route: sink.route === FeeRoute.BUYBACK ? "BUYBACK" : "TREASURY", ...decision });
  if (decision.collect) {
    const out = await ctx.sender.execute({ label: "FeeSink.collect", address: feeSink, abi: feeSinkAbi, functionName: "collect" });
    if (out.status === "reverted" || out.status === "failed") return;
  }
  if (decision.sweep) {
    // In dry-run the collect above did not happen, so a sweep of a still-empty sink cannot be simulated.
    if (ctx.config.dryRun && held === 0n && decision.collect) {
      ctx.log.info("would_send_after_collect", { call: "FeeSink.sweep", to: feeSink, amount: credited });
      return;
    }
    await ctx.sender.execute({ label: "FeeSink.sweep", address: feeSink, abi: feeSinkAbi, functionName: "sweep" });
  }
}

async function buybackStep(ctx: JobContext, d: Deployment): Promise<void> {
  const addrs = need(ctx, d, "fees.buyback", ["Buyback", "USDG"]);
  if (addrs === undefined) return;
  const [buyback, usdg] = addrs as [`0x${string}`, `0x${string}`];
  const [balance, threshold, decimals] = await Promise.all([
    ctx.views.erc20Balance(usdg, buyback),
    ctx.views.threshold(buyback),
    ctx.usdgDecimals(),
  ]);
  const maxClip = parseDecimal(ctx.config.maxClipUsdg, decimals);
  const clip = decideBuybackClip({ balance, threshold, maxClip });
  ctx.log.info("buyback_state", { balance, threshold, maxClip, clip: clip ?? null });
  if (clip === undefined) return;
  const out = await ctx.sender.execute({ label: "Buyback.buyback", address: buyback, abi: buybackAbi, functionName: "buyback", args: [clip] });
  // The contract bounds the clip by pool depth; when it tells us the bound, retry once at that size.
  if (out.status === "reverted" && out.revert.name === "ClipTooLarge") {
    const bound = out.revert.args[1];
    if (typeof bound === "bigint" && bound > 0n && bound < clip) {
      ctx.log.info("buyback_retry_at_bound", { clip, bound });
      await ctx.sender.execute({ label: "Buyback.buyback", address: buyback, abi: buybackAbi, functionName: "buyback", args: [bound] });
    }
  }
  // The 1% impact bound rejects a clip the pools cannot absorb: halve it until it fits or drops under one USDG.
  if (out.status === "reverted" && out.revert.name === "TooLittleOut") {
    const floor = 10n ** BigInt(decimals);
    let next = clip / 2n;
    for (let i = 0; i < 8 && next >= floor; i++) {
      ctx.log.info("buyback_retry_halved", { clip: next });
      const retry = await ctx.sender.execute({ label: "Buyback.buyback", address: buyback, abi: buybackAbi, functionName: "buyback", args: [next] });
      if (retry.status !== "reverted" || retry.revert.name !== "TooLittleOut") break;
      next /= 2n;
    }
  }
}

async function splitterStep(ctx: JobContext, d: Deployment): Promise<void> {
  const addrs = need(ctx, d, "fees.creatorFeeSplitter", ["CreatorFeeSplitter"]);
  if (addrs === undefined) return;
  const [splitter] = addrs as [`0x${string}`];
  // claim() pulls the creator share when Pons is pull-based and is a no-op otherwise: only worth a send when
  // the simulation says it moves something.
  const claim = await ctx.sender.execute({
    label: "CreatorFeeSplitter.claim",
    address: splitter,
    abi: creatorFeeSplitterAbi,
    functionName: "claim",
    sendIf: (r) => typeof r === "bigint" && r > 0n,
  });
  const claimed = claim.status === "dry" || claim.status === "sent" ? (typeof claim.result === "bigint" ? claim.result : 0n) : 0n;
  const [held, threshold] = await Promise.all([ctx.views.balance(splitter), ctx.views.threshold(splitter)]);
  const balance = held + (claim.status === "dry" ? claimed : 0n);
  const split = decideSplit({ balance, threshold });
  ctx.log.info("splitter_state", { held, claimed, threshold, split });
  if (split) {
    await ctx.sender.execute({ label: "CreatorFeeSplitter.split", address: splitter, abi: creatorFeeSplitterAbi, functionName: "split" });
  }
}

export async function runFees(ctx: JobContext, pub?: PublicClient<Transport, Chain>): Promise<void> {
  const d = ctx.deployment();
  if (d.addresses.DealFeeRouter) {
    if (!pub) throw new Error("floor-fee-client-required");
    try { await forwardLPFees(ctx, pub); }
    catch { ctx.log.warn("lp_fee_forwarding_failed", { reason: "Extension forwarding failed; primary fee processing continues" }); }
    return runFloorFees(ctx, pub);
  }
  await feeSinkStep(ctx, d);
  await buybackStep(ctx, d);
  await splitterStep(ctx, d);
}
