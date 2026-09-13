/**
 * Message copy, in the register of docs/ui-screens.md screen 8h (the Telegram reminders) and design-brief.md §5
 * and §6: plain words, amounts with their unit, exact moments with a zone, reclaim and walk away side by side.
 * The same text goes to every channel; email and push carry `subject` as their title. `test/messages.test.ts`
 * pins the five register lines word for word and enforces the banned-word list.
 */
import { formatCompactSGAGE, formatDay, formatMoment, formatToken, formatUSDG, hostOf, shortAddress } from "./format.js";
import type { NoticeKind } from "./schedule.js";

export interface DealForMessage {
  id: string;
  kind: "ERC20" | "UNIV4_POSITION" | "UNIV3_POSITION";
  token: string;
  amountOrTokenId: string;
  cap: string;
  price: string;
  expiry: number;
  graceEnd: number;
}

export interface AssetInfo {
  symbol: string;
  decimals: number;
  /** 18-decimal multiplier for Stock Tokens (ERC-8056), display only. */
  uiMultiplier: string | null;
}

export interface RenderOptions {
  timezone: string;
  usdgDecimals: number;
  appUrl: string;
  asset: AssetInfo | undefined;
  /** The borrower's USDG wallet balance, raw units, when the notifier can read it (T−24h line). */
  walletUSDG?: bigint | undefined;
}

export interface Rendered {
  subject: string;
  text: string;
}

/** `12.5 NVDA`, `position #112`, or `12.5 0x5EF1…41f3` when the indexer has no asset row yet. */
export function describeCollateral(deal: DealForMessage, asset: AssetInfo | undefined): string {
  if (deal.kind === "UNIV4_POSITION" || deal.kind === "UNIV3_POSITION") return `position #${deal.amountOrTokenId}`;
  if (asset === undefined) return `${deal.amountOrTokenId} ${shortAddress(deal.token)}`;
  let raw = BigInt(deal.amountOrTokenId);
  if (asset.uiMultiplier !== null && asset.uiMultiplier !== "") raw = (raw * BigInt(asset.uiMultiplier)) / 10n ** 18n;
  return `${formatToken(raw, asset.decimals)} ${asset.symbol}`;
}

export type DealNoticeKind = Exclude<NoticeKind, "epoch" | "budget7" | "budget21">;

export function renderDealNotice(kind: DealNoticeKind, deal: DealForMessage, o: RenderOptions): Rendered {
  const id = `#${deal.id}`;
  const cap = formatUSDG(BigInt(deal.cap), o.usdgDecimals);
  const kept = formatUSDG(BigInt(deal.price), o.usdgDecimals);
  const collateral = describeCollateral(deal, o.asset);
  const expiryAt = formatMoment(deal.expiry, o.timezone, true);
  const graceAt = formatMoment(deal.graceEnd, o.timezone, true);
  const graceDay = formatMoment(deal.graceEnd, o.timezone, false);
  const link = `${hostOf(o.appUrl)}/deal/${deal.id}`;

  switch (kind) {
    case "t48":
      return {
        subject: `${id} expires in 48 h`,
        text: `${id} · ${collateral} expires ${expiryAt}. Reclaim for ${cap} USDG before ${graceDay}, or walk away and keep ${kept}. ${link}`,
      };
    case "t24": {
      const wallet = o.walletUSDG === undefined ? "" : ` Wallet has ${formatUSDG(o.walletUSDG, o.usdgDecimals)}.`;
      return { subject: `${id} expires in 24 h`, text: `${id} expires in 24 h. Reclaim ${cap} USDG or walk away.${wallet} ${link}` };
    }
    case "t6":
      return { subject: `${id} expires in 6 h`, text: `${id} expires in 6 h. Reclaim ${collateral} for ${cap} USDG, or walk away.` };
    case "t1":
      return { subject: `${id} expires in 1 h`, text: `${id} expires in 1 h. Grace runs to ${graceAt}, after which the lender keeps ${collateral}.` };
    case "expiry":
      return {
        subject: `${id} expired · you choose`,
        text: `${id} · ${collateral} expired ${expiryAt}. Grace runs to ${graceAt}: reclaim for ${cap} USDG before then, or walk away and keep ${kept}. ${link}`,
      };
    case "claimable":
      return { subject: `${id} · yours to claim`, text: `${id} · the borrower walked away, so ${collateral} is yours to claim.` };
  }
}

export interface EpochForMessage {
  n: number;
  startsAt: number;
  endsAt: number;
  dealBudget7: string;
  dealBudget21: string;
}

export type NoticeOptions = Pick<RenderOptions, "timezone" | "appUrl">;

/** design-brief.md §6: "This week's rewards are fully allocated. New deals earn rewards again on [day]." */
export function renderBudgetExhausted(term: 7 | 21, epoch: EpochForMessage, o: NoticeOptions): Rendered {
  const day = formatDay(epoch.endsAt, o.timezone);
  return {
    subject: `Week ${epoch.n} · ${term}-day rewards fully allocated`,
    text: `Week ${epoch.n} · ${term}-day deals: this week's rewards are fully allocated. New deals earn rewards again on ${day}. ${hostOf(o.appUrl)}/rewards`,
  };
}

export function renderEpochRoll(epoch: EpochForMessage, o: NoticeOptions): Rendered {
  const b7 = BigInt(epoch.dealBudget7);
  const b21 = BigInt(epoch.dealBudget21);
  return {
    subject: `Week ${epoch.n} opens`,
    text: `Week ${epoch.n} opens ${formatMoment(epoch.startsAt, o.timezone, true)} · ${formatCompactSGAGE(b7 + b21)} sGAGE for deals this week, ${formatCompactSGAGE(b7)} on 7 days and ${formatCompactSGAGE(b21)} on 21 days. ${hostOf(o.appUrl)}/rewards`,
  };
}

/** Words the copy must never contain (design brief §5). "no liquidation" is the one permitted use. */
export const BANNED = ["interest", "stake", "staking", "apy", "yield", "farm", "vault"] as const;

export function violations(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = BANNED.filter((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (/\bliquidation\b/.test(lower.replace(/no liquidation/g, ""))) found.push("liquidation");
  return found;
}
