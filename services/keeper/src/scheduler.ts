/**
 * Interval scheduler. `tick(now)` is pure over the job table: it returns the jobs due and marks them running,
 * so tests drive it with hand-picked timestamps. A job never overlaps itself; an error in one job never stops
 * another.
 */
import type { Logger } from "./log.js";
import { safeErrorCode } from "./errors.js";

export interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

export interface JobState {
  lastStart: number | undefined;
  running: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  lastFinish: number | undefined;
  lastSuccess: number | undefined;
}

/** Which jobs are due at `now`: never run, or their interval has elapsed since their last start, and not running. */
export function dueJobs(jobs: readonly Job[], states: ReadonlyMap<string, JobState>, now: number): Job[] {
  return jobs.filter((job) => {
    const s = states.get(job.name);
    if (s === undefined) return true;
    if (s.running) return false;
    return s.lastStart === undefined || now - s.lastStart >= job.intervalMs;
  });
}

/** `KEEPER_JOBS` narrows the schedule; an empty allowlist keeps every job. */
export function selectJobs(jobs: readonly Job[], allowed: readonly string[]): Job[] {
  return allowed.length === 0 ? [...jobs] : jobs.filter((job) => allowed.includes(job.name));
}

export interface SchedulerOptions {
  tickMs: number;
  now?: () => number;
  log: Logger;
}

export class Scheduler {
  private readonly states = new Map<string, JobState>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly jobs: readonly Job[],
    private readonly opts: SchedulerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    for (const job of jobs) this.states.set(job.name, { lastStart: undefined, lastFinish: undefined, lastSuccess: undefined, running: false, runs: 0, failures: 0, consecutiveFailures: 0 });
  }

  state(name: string): JobState | undefined {
    return this.states.get(name);
  }

  /** Completion timestamps reflect work, independently of when an HTTP probe happens. */
  health(now: number = this.now()) {
    return this.jobs.map(job => {
      const s = this.states.get(job.name)!;
      return { name: job.name, intervalMs: job.intervalMs, ...s,
        runningForMs: s.running && s.lastStart !== undefined ? Math.max(0, now - s.lastStart) : 0,
        lastSuccessAgeMs: s.lastSuccess === undefined ? null : Math.max(0, now - s.lastSuccess) };
    });
  }

  /** Starts every due job (fire and forget) and returns their names. */
  tick(now: number = this.now()): string[] {
    if (this.stopped) return [];
    const due = dueJobs(this.jobs, this.states, now);
    for (const job of due) void this.runJob(job, now);
    return due.map((j) => j.name);
  }

  runJob(job: Job, startedAt: number = this.now()): Promise<void> {
    const s = this.states.get(job.name);
    if (s === undefined || s.running || this.stopped) return Promise.resolve();
    const task = this.executeJob(job, s, startedAt);
    this.inFlight.add(task);
    void task.then(() => this.inFlight.delete(task), () => this.inFlight.delete(task));
    return task;
  }

  private async executeJob(job: Job, s: JobState, startedAt: number): Promise<void> {
    s.running = true;
    s.lastStart = startedAt;
    s.runs += 1;
    const log = this.opts.log.child({ job: job.name });
    log.debug("job_start");
    try {
      await job.run();
      s.consecutiveFailures = 0;
      s.lastSuccess = this.now();
      log.debug("job_done", { ms: this.now() - startedAt });
    } catch (error) {
      s.failures += 1;
      s.consecutiveFailures += 1;
      log.error("job_failed", { error: safeErrorCode(error), consecutiveFailures: s.consecutiveFailures });
    } finally {
      s.lastFinish = this.now();
      s.running = false;
    }
  }

  /** Runs every job once, sequentially, in table order. Used by `--once`. */
  async runAllOnce(): Promise<void> {
    for (const job of this.jobs) await this.runJob(job);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stop scheduling and give active jobs time to persist results. Never release an overlap guard on timeout. */
  async drain(timeoutMs: number): Promise<boolean> {
    this.stop();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...this.inFlight]).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
