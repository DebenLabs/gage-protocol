/**
 * Which reminder a FUNDED deal's borrower is due, given the time and what has already gone out. Pure.
 *
 * Reminders fire at T−48h, T−24h, T−6h, T−1h and at expiry. Only the latest reached reminder is sent; earlier
 * ones that were never sent (the notifier was down, or the deal's term is shorter than the offset) are marked
 * skipped so they never go out late. Before expiry only the T−x kinds are sendable; from expiry on only the
 * expiry message is, and it stays due while the deal is still FUNDED because the borrower can still reclaim
 * until a claim executes. The lender gets one message once the grace has ended and the deal is still FUNDED.
 */
import type { Prefs } from "./prefs.js";

export const REMINDER_KINDS = ["t48", "t24", "t6", "t1", "expiry"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** The lender's notice after the grace: "yours to claim". Gated by the `expiry` preference. */
export const LENDER_KIND = "claimable";
export type NoticeKind = ReminderKind | typeof LENDER_KIND | "epoch" | "budget7" | "budget21";

/** Seconds before expiry at which each reminder is due. */
export const OFFSETS: Record<ReminderKind, number> = { t48: 48 * 3_600, t24: 24 * 3_600, t6: 6 * 3_600, t1: 3_600, expiry: 0 };

export function triggerAt(kind: ReminderKind, expiry: number): number {
  return expiry - OFFSETS[kind];
}

export interface DueInput {
  expiry: number;
  now: number;
  prefs: Prefs;
  /** Kinds already sent, dry-sent or skipped for this deal, wallet and channel. */
  done: ReadonlySet<string>;
}

export interface Due {
  send: ReminderKind | undefined;
  skip: ReminderKind[];
}

export function dueReminders(i: DueInput): Due {
  const reached = REMINDER_KINDS.filter((k) => triggerAt(k, i.expiry) <= i.now && !i.done.has(k));
  const sendable = reached.filter((k) => i.prefs[k] && (k === "expiry" ? i.now >= i.expiry : i.now < i.expiry));
  const send = sendable.at(-1);
  return { send, skip: reached.filter((k) => k !== send) };
}

/** Whether the lender's after-grace notice is due for a deal still FUNDED. */
export function lenderClaimDue(i: { graceEnd: number; now: number; prefs: Prefs; done: ReadonlySet<string> }): boolean {
  return i.prefs.expiry && i.now >= i.graceEnd && !i.done.has(LENDER_KIND);
}

/** The sent-ledger key for a deal notice. */
export function reminderKey(kind: NoticeKind, dealId: string, wallet: string, channel: string): string {
  return `${kind}:${dealId}:${wallet.toLowerCase()}:${channel}`;
}
