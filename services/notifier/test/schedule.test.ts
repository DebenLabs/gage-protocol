import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../src/prefs.js";
import { dueReminders, lenderClaimDue, OFFSETS, reminderKey, triggerAt, type ReminderKind } from "../src/schedule.js";

const H = 3_600;
const EXPIRY = 1_800_000_000;
const GRACE_END = EXPIRY + 48 * H;
const prefs = { ...DEFAULT_PREFS };

/** Runs the poller's decision minute by minute from `from` to `to`, recording what goes out. */
function simulate(from: number, to: number, stepSec = 60, p = prefs): { at: number; kind: ReminderKind }[] {
  const done = new Set<string>();
  const sent: { at: number; kind: ReminderKind }[] = [];
  for (let now = from; now <= to; now += stepSec) {
    const due = dueReminders({ expiry: EXPIRY, now, prefs: p, done });
    due.skip.forEach((k) => done.add(k));
    if (due.send !== undefined) {
      done.add(due.send);
      sent.push({ at: now, kind: due.send });
    }
  }
  return sent;
}

describe("dueReminders", () => {
  it("has the five offsets", () => {
    expect(OFFSETS).toEqual({ t48: 48 * H, t24: 24 * H, t6: 6 * H, t1: H, expiry: 0 });
    expect(triggerAt("t6", EXPIRY)).toBe(EXPIRY - 6 * H);
  });
  it("sends nothing before T−48h", () => {
    expect(dueReminders({ expiry: EXPIRY, now: EXPIRY - 48 * H - 1, prefs, done: new Set() })).toEqual({ send: undefined, skip: [] });
  });
  it("sends each reminder once, at its moment, over a 7-day deal polled every minute", () => {
    const sent = simulate(EXPIRY - 7 * 86_400, EXPIRY + 10 * 60);
    expect(sent).toEqual([
      { at: EXPIRY - 48 * H, kind: "t48" },
      { at: EXPIRY - 24 * H, kind: "t24" },
      { at: EXPIRY - 6 * H, kind: "t6" },
      { at: EXPIRY - H, kind: "t1" },
      { at: EXPIRY, kind: "expiry" },
    ]);
  });
  it("after downtime sends only the latest reached reminder and marks the missed ones skipped", () => {
    const now = EXPIRY - 5 * H; // the notifier was down from before T−48h
    const due = dueReminders({ expiry: EXPIRY, now, prefs, done: new Set() });
    expect(due).toEqual({ send: "t6", skip: ["t48", "t24"] });
  });
  it("never sends a T−x reminder after expiry, only the expiry message, until it is done", () => {
    const after = dueReminders({ expiry: EXPIRY, now: EXPIRY + 3 * H, prefs, done: new Set() });
    expect(after).toEqual({ send: "expiry", skip: ["t48", "t24", "t6", "t1"] });
    const later = dueReminders({ expiry: EXPIRY, now: EXPIRY + 40 * H, prefs, done: new Set(["t48", "t24", "t6", "t1", "expiry"]) });
    expect(later).toEqual({ send: undefined, skip: [] });
  });
  it("skips reminders the deal's term never reaches", () => {
    // A 1-day deal: T−48h is already in the past at funding, T−24h is exactly now.
    const fundedAt = EXPIRY - 86_400;
    expect(dueReminders({ expiry: EXPIRY, now: fundedAt, prefs, done: new Set() })).toEqual({ send: "t24", skip: ["t48"] });
  });
  it("respects preferences: an opted-out kind is skipped, not sent", () => {
    const p = { ...prefs, t24: false, t1: false };
    const sent = simulate(EXPIRY - 49 * H, EXPIRY, 60, p).map((s) => s.kind);
    expect(sent).toEqual(["t48", "t6", "expiry"]);
  });
  it("does not resend a kind already recorded", () => {
    expect(dueReminders({ expiry: EXPIRY, now: EXPIRY - 47 * H, prefs, done: new Set(["t48"]) })).toEqual({ send: undefined, skip: [] });
  });
});

describe("lenderClaimDue", () => {
  it("is due once the grace has ended, once, and only when the expiry preference is on", () => {
    expect(lenderClaimDue({ graceEnd: GRACE_END, now: GRACE_END - 1, prefs, done: new Set() })).toBe(false);
    expect(lenderClaimDue({ graceEnd: GRACE_END, now: GRACE_END, prefs, done: new Set() })).toBe(true);
    expect(lenderClaimDue({ graceEnd: GRACE_END, now: GRACE_END + H, prefs, done: new Set(["claimable"]) })).toBe(false);
    expect(lenderClaimDue({ graceEnd: GRACE_END, now: GRACE_END + H, prefs: { ...prefs, expiry: false }, done: new Set() })).toBe(false);
  });
});

describe("reminderKey", () => {
  it("is one per kind, deal, wallet and channel, case-insensitive on the wallet", () => {
    expect(reminderKey("t48", "4821", "0xABC", "telegram")).toBe("t48:4821:0xabc:telegram");
  });
});
