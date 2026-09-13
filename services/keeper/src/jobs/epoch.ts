/**
 * Every minute: epoch boundaries. `release(epoch)` for every started epoch not yet released, `rollover(epoch)`
 * for every ended epoch not yet rolled over, and `finalize()` once the schedule is over. Cheap reads every
 * minute; sends only when something is due.
 *
 * Emissions only accepts `rollover(e)` from `epochStart(e + 1) + REGISTRATION_GRACE` (6 hours: deals funded in
 * the last minutes of an epoch may still register) and `finalize()` from `epochStart(WEEKS) + REGISTRATION_GRACE`.
 * The constant is not part of IEmissions, so the keeper carries it as `REGISTRATION_GRACE` (default 6h) and does
 * not attempt either call before then; a revert anyway (a different grace on some deployment) backs off.
 */
import { emissionsAbi } from "../abi.js";
import { need, type JobContext } from "../context.js";

export interface EpochAction {
  kind: "release" | "rollover" | "finalize";
  epoch: bigint;
}

export interface EpochDecisionInput {
  launchAt: bigint;
  currentEpoch: bigint;
  weeks: bigint;
  scheduleOver: boolean;
  /** Seconds per epoch (`Emissions.EPOCH`). */
  epochSeconds: bigint;
  /** Seconds after an epoch ends before `rollover` (and after the schedule before `finalize`) is accepted. */
  registrationGraceSeconds: number;
  /** Flags for the epochs in the lookback window, keyed by epoch. */
  flags: ReadonlyMap<bigint, { released: boolean; rolledOver: boolean }>;
  finalized: boolean;
  /** Unix ms after which a previously reverting action may be retried, keyed "rollover:<n>" / "finalize". */
  retryAfter: Readonly<Record<string, number>>;
  /** Unix ms. */
  now: number;
}

/** Unix seconds at which `rollover(epoch)` becomes callable. Pure. */
export function rolloverOpensAt(i: Pick<EpochDecisionInput, "launchAt" | "epochSeconds" | "registrationGraceSeconds">, epoch: bigint): number {
  return Number(i.launchAt + (epoch + 1n) * i.epochSeconds) + i.registrationGraceSeconds;
}

/** Epochs to look at: the current one and up to `lookback` before it. Pure. */
export function epochWindow(currentEpoch: bigint, weeks: bigint, lookback: number): bigint[] {
  const last = currentEpoch < weeks ? currentEpoch : weeks - 1n;
  const first = last - BigInt(lookback) < 0n ? 0n : last - BigInt(lookback);
  const out: bigint[] = [];
  for (let e = first; e <= last; e += 1n) out.push(e);
  return out;
}

/** Pure. In execution order: releases (oldest first), rollovers (oldest first), then finalize. */
export function decideEpochActions(i: EpochDecisionInput): EpochAction[] {
  if (i.launchAt === 0n) return [];
  const actions: EpochAction[] = [];
  const epochs = [...i.flags.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const e of epochs) {
    const f = i.flags.get(e)!;
    if (!f.released && e <= i.currentEpoch) actions.push({ kind: "release", epoch: e });
  }
  const nowSec = Math.floor(i.now / 1000);
  for (const e of epochs) {
    const f = i.flags.get(e)!;
    const ended = e < i.currentEpoch || i.scheduleOver;
    const graceOver = nowSec >= rolloverOpensAt(i, e);
    if (ended && graceOver && !f.rolledOver && (i.retryAfter[`rollover:${e}`] ?? 0) <= i.now) {
      actions.push({ kind: "rollover", epoch: e });
    }
  }
  const finalizeOpensAt = rolloverOpensAt(i, i.weeks - 1n);
  if (i.scheduleOver && nowSec >= finalizeOpensAt && !i.finalized && (i.retryAfter.finalize ?? 0) <= i.now) {
    actions.push({ kind: "finalize", epoch: i.currentEpoch });
  }
  return actions;
}

const ROLLOVER_RETRY_MS = 10 * 60 * 1000;
const FINALIZE_RETRY_MS = 60 * 60 * 1000;

export async function runEpoch(ctx: JobContext): Promise<void> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "epoch", ["Emissions"]);
  if (addrs === undefined) return;
  const [emissions] = addrs as [`0x${string}`];

  const s = await ctx.views.emissionsState(emissions);
  if (s.launchAt === 0n) {
    ctx.log.info("epoch_not_launched", { emissions });
    return;
  }
  const window = epochWindow(s.currentEpoch, s.weeks, ctx.config.epochLookback);
  const flagList = await ctx.views.epochFlags(emissions, window);
  const flags = new Map(window.map((e, i) => [e, flagList[i]!] as const));
  const actions = decideEpochActions({
    launchAt: s.launchAt,
    currentEpoch: s.currentEpoch,
    weeks: s.weeks,
    scheduleOver: s.scheduleOver,
    epochSeconds: s.epochSeconds,
    registrationGraceSeconds: Math.floor(ctx.config.registrationGraceMs / 1000),
    flags,
    finalized: ctx.state.finalized,
    retryAfter: ctx.state.epochRetryAfter,
    now: ctx.now(),
  });
  const nextBoundary = await ctx.views.epochStart(emissions, s.currentEpoch + 1n);
  ctx.log.info("epoch_state", {
    currentEpoch: s.currentEpoch,
    scheduleOver: s.scheduleOver,
    secondsToBoundary: Number(nextBoundary) - Math.floor(ctx.now() / 1000),
    actions: actions.map((a) => `${a.kind}:${a.epoch}`),
  });

  for (const a of actions) {
    const call = {
      address: emissions,
      abi: emissionsAbi,
      ...(a.kind === "finalize"
        ? { label: "Emissions.finalize", functionName: "finalize" }
        : { label: `Emissions.${a.kind}`, functionName: a.kind, args: [a.epoch] }),
    };
    const out = await ctx.sender.execute(call);
    if (a.kind === "finalize" && out.status === "sent") ctx.state.finalized = true;
    if (out.status === "reverted") {
      // The grace is the contract's to enforce; if it differs from REGISTRATION_GRACE, back off rather than spam.
      if (a.kind === "rollover") {
        ctx.state.epochRetryAfter[`rollover:${a.epoch}`] = ctx.now() + ROLLOVER_RETRY_MS;
        ctx.log.info("rollover_not_yet", { epoch: a.epoch, error: out.revert.name, retryInMs: ROLLOVER_RETRY_MS });
      } else if (a.kind === "finalize") {
        ctx.state.epochRetryAfter.finalize = ctx.now() + FINALIZE_RETRY_MS;
      }
    }
    if (out.status === "refused") break;
  }
}
