import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { dueJobs, Scheduler, selectJobs, type Job, type JobState } from "../src/scheduler.js";

const quiet = createLogger({}, { write: () => undefined });

describe("dueJobs", () => {
  const jobs: Job[] = [
    { name: "a", intervalMs: 1_000, run: () => Promise.resolve() },
    { name: "b", intervalMs: 10_000, run: () => Promise.resolve() },
  ];

  it("runs everything on the first tick", () => {
    expect(dueJobs(jobs, new Map(), 0).map((j) => j.name)).toEqual(["a", "b"]);
  });

  it("waits for each job's own interval", () => {
    const states = new Map<string, JobState>([
      ["a", { lastStart: 0, running: false, runs: 1, failures: 0, consecutiveFailures: 0, lastFinish: undefined, lastSuccess: undefined }],
      ["b", { lastStart: 0, running: false, runs: 1, failures: 0, consecutiveFailures: 0, lastFinish: undefined, lastSuccess: undefined }],
    ]);
    expect(dueJobs(jobs, states, 999).map((j) => j.name)).toEqual([]);
    expect(dueJobs(jobs, states, 1_000).map((j) => j.name)).toEqual(["a"]);
    expect(dueJobs(jobs, states, 10_000).map((j) => j.name)).toEqual(["a", "b"]);
  });

  it("never overlaps a running job", () => {
    const states = new Map<string, JobState>([["a", { lastStart: 0, running: true, runs: 1, failures: 0, consecutiveFailures: 0, lastFinish: undefined, lastSuccess: undefined }]]);
    expect(dueJobs(jobs, states, 5_000).map((j) => j.name)).toEqual(["b"]);
  });
});

describe("Scheduler", () => {
  it("isolates a failing job and records the failure", async () => {
    const ran: string[] = [];
    const jobs: Job[] = [
      { name: "bad", intervalMs: 1, run: () => Promise.reject(new Error("boom")) },
      { name: "good", intervalMs: 1, run: () => Promise.resolve(void ran.push("good")) },
    ];
    const s = new Scheduler(jobs, { tickMs: 1, log: quiet, now: () => 0 });
    await s.runAllOnce();
    expect(ran).toEqual(["good"]);
    expect(s.state("bad")?.failures).toBe(1);
    expect(s.state("good")?.runs).toBe(1);
    expect(s.state("bad")?.running).toBe(false);
  });

  it("tick starts only what is due and marks it running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const jobs: Job[] = [{ name: "slow", intervalMs: 100, run: () => gate }];
    let now = 0;
    const s = new Scheduler(jobs, { tickMs: 1, log: quiet, now: () => now });
    expect(s.tick(now)).toEqual(["slow"]);
    now = 500;
    expect(s.tick(now)).toEqual([]);
    expect(s.state("slow")?.running).toBe(true);
    release();
    await gate;
    await Promise.resolve();
    expect(s.state("slow")?.running).toBe(false);
    expect(s.tick(now)).toEqual(["slow"]);
  });
});

describe("selectJobs", () => {
  const jobs: Job[] = [{ name: "earn", intervalMs: 1, run: async () => {} }, { name: "fees", intervalMs: 1, run: async () => {} }];
  it("keeps every job for an empty allowlist and filters by name otherwise", () => {
    expect(selectJobs(jobs, []).map((j) => j.name)).toEqual(["earn", "fees"]);
    expect(selectJobs(jobs, ["earn"]).map((j) => j.name)).toEqual(["earn"]);
    expect(selectJobs(jobs, ["rates"])).toEqual([]);
  });
});


describe("scheduler recovery and shutdown", () => {
  afterEach(() => vi.useRealTimers());

  it("clears current failures after success while retaining incident totals and completion times", async () => {
    let now = 10, fail = true;
    const job: Job = { name: "earn", intervalMs: 5, run: () => { now += 2; return fail ? Promise.reject(Error("boom")) : Promise.resolve(); } };
    const scheduler = new Scheduler([job], { tickMs: 1, log: quiet, now: () => now });
    await scheduler.runJob(job);
    expect(scheduler.health()).toEqual([expect.objectContaining({ failures: 1, consecutiveFailures: 1, lastFinish: 12, lastSuccessAgeMs: null })]);
    fail = false; now = 20;
    await scheduler.runJob(job);
    expect(scheduler.health(30)).toEqual([expect.objectContaining({ failures: 1, consecutiveFailures: 0, lastFinish: 22, lastSuccess: 22, lastSuccessAgeMs: 8, runningForMs: 0 })]);
  });

  it("waits for active work and stops scheduling during a graceful drain", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const scheduler = new Scheduler([{ name: "earn", intervalMs: 1, run }], { tickMs: 1, log: quiet, now: () => 10 });
    scheduler.tick();
    const drained = scheduler.drain(1_000);
    expect(scheduler.tick(20)).toEqual([]);
    expect(scheduler.health(20)[0]).toMatchObject({ running: true, runningForMs: 10 });
    release();
    expect(await drained).toBe(true);
    expect(scheduler.state("earn")?.running).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps the running guard after a drain timeout without starting overlapping work", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const scheduler = new Scheduler([{ name: "earn", intervalMs: 1, run }], { tickMs: 1, log: quiet });
    scheduler.tick();
    const drained = scheduler.drain(20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await drained).toBe(false);
    expect(scheduler.state("earn")?.running).toBe(true);
    expect(scheduler.tick()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
  });
});
