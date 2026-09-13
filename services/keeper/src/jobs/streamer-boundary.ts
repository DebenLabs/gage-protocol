/**
 * Streamer boundary passes (D64). LPStreamer pays an interval that spans epochs at the smallest pot rate it touches,
 * so no position may carry a whole epoch's accrual into an emptier one. Every minute this job looks at the clock and,
 * inside the window `[epochStart(n) - STREAMER_BOUNDARY_LEAD_SECONDS, epochStart(n))`, runs `LPStreamer.checkpointMany`
 * once over the whole scoring inventory; then, inside `[epochStart(n), epochStart(n) + lead)`, once more, so the new
 * epoch starts from a fresh checkpoint. The pre pass is the one that matters: the post pass only trims the interval
 * that the hourly job would otherwise close. A post pass without its pre pass (the keeper was down across the boundary)
 * is still sent, because a later checkpoint is never better, but it is logged as `streamer_boundary_pre_missed`.
 */
import type { Address } from "viem";
import { need, nowSeconds, type JobContext } from "../context.js";
import type { KeeperState } from "../state.js";
import { checkpointStreamer, scoringPositions } from "./checkpoint.js";

export interface BoundaryPassInput {
  /** Unix seconds. */
  now: number;
  /** `epochStart(currentEpoch + 1)`, unix seconds; undefined once the schedule is over. */
  nextBoundary: number | undefined;
  /** `epochStart(currentEpoch)`, unix seconds. */
  lastBoundary: number;
  leadSeconds: number;
  passes: KeeperState["streamerBoundary"];
}

export interface BoundaryPass {
  kind: "pre" | "post";
  /** The boundary the pass covers, unix seconds. */
  boundary: number;
  /** Post pass only: the pre pass for this boundary was never recorded. */
  preMissed: boolean;
}

/**
 * Pure. The pass due at `now`, if any: "pre" once inside the lead window before the next boundary, "post" once inside
 * the same length of time after the last boundary. Each pass runs at most once per boundary.
 */
export function decideBoundaryPass(i: BoundaryPassInput): BoundaryPass | undefined {
  if (i.leadSeconds <= 0) return undefined;
  const preDone = (b: number): boolean => i.passes.lastPre?.boundary === String(b);
  const postDone = (b: number): boolean => i.passes.lastPost?.boundary === String(b);
  if (i.nextBoundary !== undefined && i.now >= i.nextBoundary - i.leadSeconds && i.now < i.nextBoundary && !preDone(i.nextBoundary)) {
    return { kind: "pre", boundary: i.nextBoundary, preMissed: false };
  }
  if (i.now >= i.lastBoundary && i.now < i.lastBoundary + i.leadSeconds && !postDone(i.lastBoundary)) {
    return { kind: "post", boundary: i.lastBoundary, preMissed: !preDone(i.lastBoundary) };
  }
  return undefined;
}

export async function runStreamerBoundary(ctx: JobContext): Promise<void> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "streamerBoundary", ["LPStreamer", "Emissions", "LPRewards", "PositionManager"]);
  if (addrs === undefined) return;
  const [streamer, emissions, lpRewards, positionManager] = addrs as [Address, Address, Address, Address];

  const s = await ctx.views.emissionsState(emissions);
  if (s.launchAt === 0n) {
    ctx.log.info("streamer_boundary_not_launched", { emissions });
    return;
  }
  // epochStart(WEEKS) is the schedule's end and still a boundary; past it there is nothing to bracket.
  if (s.currentEpoch >= s.weeks) return;
  const now = nowSeconds(ctx);
  const lastBoundary = Number(s.launchAt + s.currentEpoch * s.epochSeconds);
  const nextBoundary = Number(s.launchAt + (s.currentEpoch + 1n) * s.epochSeconds);
  const pass = decideBoundaryPass({
    now,
    nextBoundary,
    lastBoundary: lastBoundary,
    leadSeconds: ctx.config.streamerBoundaryLeadSeconds,
    passes: ctx.state.streamerBoundary,
  });
  if (pass === undefined) {
    ctx.log.debug("streamer_boundary_idle", { currentEpoch: s.currentEpoch, secondsToBoundary: nextBoundary - now });
    return;
  }
  if (pass.preMissed) ctx.log.warn("streamer_boundary_pre_missed", { boundary: pass.boundary, epoch: s.currentEpoch });

  const live = await scoringPositions(ctx, d, lpRewards, positionManager);
  ctx.log.info("streamer_boundary_pass", { kind: pass.kind, boundary: pass.boundary, epoch: s.currentEpoch, positions: live.length,
    secondsToBoundary: pass.kind === "pre" ? pass.boundary - now : now - pass.boundary });
  const complete = await checkpointStreamer(ctx, streamer, live);
  if (!complete) {
    ctx.log.warn("streamer_boundary_incomplete", { kind: pass.kind, boundary: pass.boundary });
    return;
  }
  const record = { boundary: String(pass.boundary), at: ctx.now() };
  if (pass.kind === "pre") ctx.state.streamerBoundary.lastPre = record;
  else ctx.state.streamerBoundary.lastPost = record;
}
