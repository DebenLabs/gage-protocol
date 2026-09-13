import { describe, expect, it } from "vitest";
import { decideEpochActions, epochWindow, rolloverOpensAt, runEpoch, type EpochDecisionInput } from "../src/jobs/epoch.js";
import { m6Deployment, mockCtx, msgs } from "./helpers.js";

const flags = (entries: [number, boolean, boolean][]) =>
  new Map(entries.map(([e, released, rolledOver]) => [BigInt(e), { released, rolledOver }] as const));

const base: EpochDecisionInput = {
  launchAt: 1n,
  currentEpoch: 3n,
  weeks: 52n,
  scheduleOver: false,
  epochSeconds: 604_800n,
  registrationGraceSeconds: 6 * 3_600,
  flags: flags([
    [0, true, true],
    [1, true, true],
    [2, true, true],
    [3, true, false],
  ]),
  finalized: false,
  retryAfter: {},
  // Two epochs after epoch 3 ended, well past every grace in the window.
  now: (1 + 6 * 604_800) * 1000,
};

const ms = (sec: number): number => sec * 1000;

describe("epochWindow", () => {
  it("covers the current epoch and the lookback, clamped to the schedule", () => {
    expect(epochWindow(0n, 52n, 4)).toEqual([0n]);
    expect(epochWindow(5n, 52n, 2)).toEqual([3n, 4n, 5n]);
    expect(epochWindow(60n, 52n, 1)).toEqual([50n, 51n]);
  });
});

describe("decideEpochActions", () => {
  it("does nothing before launch", () => {
    expect(decideEpochActions({ ...base, launchAt: 0n })).toEqual([]);
  });
  it("does nothing mid-epoch when everything is in order", () => {
    expect(decideEpochActions(base)).toEqual([]);
  });
  it("releases the new epoch at the boundary and rolls over the previous one", () => {
    const i = { ...base, currentEpoch: 4n, flags: flags([[2, true, true], [3, true, false], [4, false, false]]) };
    expect(decideEpochActions(i)).toEqual([
      { kind: "release", epoch: 4n },
      { kind: "rollover", epoch: 3n },
    ]);
  });
  it("catches up on missed epochs oldest first", () => {
    const i = { ...base, currentEpoch: 5n, flags: flags([[3, false, false], [4, false, false], [5, false, false]]) };
    expect(decideEpochActions(i).map((a) => `${a.kind}:${a.epoch}`)).toEqual([
      "release:3",
      "release:4",
      "release:5",
      "rollover:3",
      "rollover:4",
    ]);
  });
  it("honours the rollover backoff", () => {
    const i = { ...base, currentEpoch: 4n, flags: flags([[3, true, false], [4, true, false]]), retryAfter: { "rollover:3": base.now + 10 } };
    expect(decideEpochActions(i)).toEqual([]);
    expect(decideEpochActions({ ...i, now: base.now + 10 })).toEqual([{ kind: "rollover", epoch: 3n }]);
  });
  it("waits for the registration grace before a rollover", () => {
    const i = { ...base, currentEpoch: 4n, flags: flags([[3, true, false], [4, true, false]]) };
    const epoch3Ends = 1 + 4 * 604_800;
    expect(rolloverOpensAt(i, 3n)).toBe(epoch3Ends + 6 * 3_600);
    expect(decideEpochActions({ ...i, now: ms(epoch3Ends) })).toEqual([]);
    expect(decideEpochActions({ ...i, now: ms(epoch3Ends + 6 * 3_600 - 1) })).toEqual([]);
    expect(decideEpochActions({ ...i, now: ms(epoch3Ends + 6 * 3_600) })).toEqual([{ kind: "rollover", epoch: 3n }]);
    // A release is never held back by the grace.
    expect(decideEpochActions({ ...i, now: ms(epoch3Ends), flags: flags([[3, true, false], [4, false, false]]) })).toEqual([{ kind: "release", epoch: 4n }]);
  });
  it("finalizes once the schedule is over, after the last rollover and the grace", () => {
    const scheduleEnds = 1 + 52 * 604_800;
    const i = { ...base, currentEpoch: 52n, scheduleOver: true, flags: flags([[51, true, false]]), now: ms(scheduleEnds + 6 * 3_600) };
    expect(decideEpochActions({ ...i, now: ms(scheduleEnds) })).toEqual([]);
    expect(decideEpochActions(i)).toEqual([
      { kind: "rollover", epoch: 51n },
      { kind: "finalize", epoch: 52n },
    ]);
    expect(decideEpochActions({ ...i, finalized: true, flags: flags([[51, true, true]]) })).toEqual([]);
  });
});

describe("runEpoch", () => {
  it("skips cleanly when Emissions is absent", async () => {
    const ctx = mockCtx();
    await runEpoch(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(msgs(ctx)).toEqual(["job_skipped"]);
  });

  it("sends release and rollover, and backs off a too-early rollover", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      views: {
        emissionsState: () => Promise.resolve({ launchAt: 1n, currentEpoch: 1n, weeks: 52n, epochSeconds: 604_800n, scheduleOver: false }),
        epochFlags: (_a, epochs) => Promise.resolve(epochs.map((e) => ({ released: e === 0n, rolledOver: false }))),
        epochStart: (_a, e) => Promise.resolve(1n + e * 604_800n),
      },
    });
    ctx.sender.script["Emissions.rollover"] = { status: "reverted", revert: { name: "EpochNotEnded", args: [0n], message: "" } };
    await runEpoch(ctx);
    expect(ctx.sender.calls.map((c) => `${c.label}:${String(c.args?.[0])}`)).toEqual(["Emissions.release:1", "Emissions.rollover:0"]);
    expect(ctx.state.epochRetryAfter["rollover:0"]).toBe(ctx.now() + 600_000);
    expect(msgs(ctx)).toContain("rollover_not_yet");
  });

  it("records finalize", async () => {
    const ctx = mockCtx({
      deployment: m6Deployment(),
      views: {
        emissionsState: () => Promise.resolve({ launchAt: 1n, currentEpoch: 52n, weeks: 52n, epochSeconds: 604_800n, scheduleOver: true }),
        epochFlags: (_a, epochs) => Promise.resolve(epochs.map(() => ({ released: true, rolledOver: true }))),
        epochStart: () => Promise.resolve(0n),
      },
    });
    ctx.sender.script["Emissions.finalize"] = { status: "sent", hash: "0x01", gasUsed: 1n, result: undefined };
    await runEpoch(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["Emissions.finalize"]);
    expect(ctx.state.finalized).toBe(true);
  });
});
