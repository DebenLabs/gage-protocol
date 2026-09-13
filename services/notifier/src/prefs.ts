export const PREF_KEYS = ["t48", "t24", "t6", "t1", "expiry", "budget", "epoch"] as const;
export type PrefKey = (typeof PREF_KEYS)[number];
export type Prefs = Record<PrefKey, boolean>;

/** Reminders default on, reward notices default off. */
export const DEFAULT_PREFS: Prefs = { t48: true, t24: true, t6: true, t1: true, expiry: true, budget: false, epoch: false };

/** Lenient: missing keys take the default, non-boolean values are an error. */
export function parsePrefs(v: unknown): Prefs | undefined {
  if (v === undefined || v === null) return { ...DEFAULT_PREFS };
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Prefs = { ...DEFAULT_PREFS };
  for (const k of PREF_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    if (typeof x !== "boolean") return undefined;
    out[k] = x;
  }
  return out;
}
