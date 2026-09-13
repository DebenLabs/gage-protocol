/** Number and date formatting for the message register (docs/ui-screens.md 8h). Pure. */

/** Raw units → decimal string with thousands separators and at most `maxFrac` places (trailing zeros trimmed past `minFrac`). */
export function formatUnits(raw: bigint, decimals: number, minFrac: number, maxFrac: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFrac);
  while (frac.length > minFrac && frac.endsWith("0")) frac = frac.slice(0, -1);
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${wholeStr}${frac.length > 0 ? `.${frac}` : ""}`;
}

/** `1,824.00`: USDG with two places, no unit (the copy adds "USDG" where the register does). */
export function formatUSDG(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals, 2, 2);
}

/** `12.5`: a token amount with up to four places. */
export function formatToken(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals, 0, 4);
}

/** `2.00M`, `402K`, `1.9M`-style sGAGE figures (18 decimals), as the week strip shows them. */
export function formatCompactSGAGE(raw: bigint): string {
  const n = Number(raw) / 1e18;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function parts(unix: number, timeZone: string, extra: Intl.DateTimeFormatOptions): (type: string) => string {
  const list = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", ...extra }).formatToParts(new Date(unix * 1000));
  return (type) => list.find((x) => x.type === type)?.value ?? "";
}

/** `8 Sep 16:40 UTC` (with the zone) or `9 Sep 16:40` (without), in the given IANA zone. */
export function formatMoment(unix: number, timeZone: string, withZone: boolean): string {
  const p = parts(unix, timeZone, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const base = `${p("day")} ${p("month")} ${p("hour")}:${p("minute")}`;
  return withZone ? `${base} ${p("timeZoneName")}` : base;
}

/** `Monday 14 Sep`. */
export function formatDay(unix: number, timeZone: string): string {
  const p = parts(unix, timeZone, { weekday: "long", day: "numeric", month: "short" });
  return `${p("weekday")} ${p("day")} ${p("month")}`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** `https://gage.cash` → `gage.cash`, the way links read in the register. */
export function hostOf(appUrl: string): string {
  return appUrl.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
}
