/** Earn notices use canonical indexed outcomes; they never infer holder receipts from a balance delta. */
import type { EarnApproval, EarnKeeperAlert, EarnLoan, EarnNotice, EarnStrategy } from "../../../shared/earn.js";
import type { IndexedListing } from "./indexer.js";
import type { NoticeOptions, Rendered } from "./messages.js";
import { describeCollateral } from "./messages.js";
import { formatMoment, formatUSDG, hostOf } from "./format.js";

export interface EarnMessage { id: string; kind: string; wallet: string; message: Rendered }
const downside = "You may end up holding the collateral instead of USDG.";
const lpDownside = "You may end up holding the LP position's underlying assets instead of USDG.";

/** Frontend strategy routes use published catalog slugs, never on-chain addresses; a strategy without a slug links to the Earn catalog. */
function link(strategy: EarnStrategy, o: NoticeOptions): string {
  return /^[a-z][a-z0-9-]{0,31}$/.test(strategy.id ?? "") ? `${hostOf(o.appUrl)}/earn/${strategy.id}` : `${hostOf(o.appUrl)}/earn`;
}
const title = (strategy: EarnStrategy): string => strategy.title?.trim() || "the strategy";

function message(strategy: EarnStrategy, o: NoticeOptions, kind: string, id: string, wallet: string, subject: string, detail: string, manage = false): EarnMessage {
  return { id, kind: `earn_${kind}`, wallet, message: {
    subject: `Earn · ${title(strategy)} · ${subject}`,
    text: `Earn · ${title(strategy)}: ${detail}${manage ? ` Open the Manage page of ${title(strategy)}.` : ""} ${link(strategy, o)}`,
  } };
}

export function listingNotice(strategy: EarnStrategy, listing: IndexedListing, o: NoticeOptions): EarnMessage | undefined {
  if (listing.kind !== "ERC20") {
    if (!strategy.lanes.some(lane => lane.lane === "LP" && lane.weightBps > 0)) return undefined;
    return message(strategy, o, "listing", listing.id, strategy.curator, `New listing #${listing.id}`,
      `New listing #${listing.id} in the LP category. Review its pool, underlying assets and mandate before approving. ${lpDownside}`, true);
  }
  const token = strategy.tokens.find(token => token.allowed && BigInt(token.ceiling) > 0n && token.token.toLowerCase() === listing.token.toLowerCase());
  if (!token) return undefined;
  const risk = token.lane === "MEME" ? `${downside} Memes can go to zero. If the borrower walks away, you hold it.` : downside;
  return message(strategy, o, "listing", listing.id, strategy.curator, `New listing #${listing.id}`,
    `New listing #${listing.id} in ${token.symbol}, an admitted token. Review the mandate before approving. ${risk}`, true);
}

export function approvalNotice(strategy: EarnStrategy, approval: EarnApproval, now: number, o: NoticeOptions): EarnMessage | undefined {
  if (approval.funded || approval.revoked || approval.validUntil <= now || approval.validUntil - now > 600) return undefined;
  return message(strategy, o, "approval_expiring", `${approval.dealId}:${approval.validUntil}`, strategy.curator,
    `Approval #${approval.dealId} expires soon`,
    `Approval #${approval.dealId} is unfunded and expires ${formatMoment(approval.validUntil, o.timezone, true)}. Funding must complete before then. ${approval.kind === "ERC20" ? downside : lpDownside}`, true);
}

/** The curator hears once when a loan can be finalized, even if the keeper already recovered its collateral. */
export function claimableNotice(strategy: EarnStrategy, loan: EarnLoan, now: number, o: NoticeOptions): EarnMessage | undefined {
  if (loan.claimableAt === 0 || loan.claimableAt > now || loan.withdrawn || (loan.coreState !== "ACTIVE" && loan.coreState !== "DEFAULTED")) return undefined;
  if (loan.coreState === "DEFAULTED") {
    const pockets = loan.pocketIds.length > 1 ? "separate side pockets" : "a side pocket";
    const collateral = loan.kind === "ERC20" ? "Its collateral" : "Its underlying assets";
    const completed = loan.settled ? `${collateral} ${loan.kind === "ERC20" ? "was" : "were"} recovered into ${pockets} for the holders of record.` : `${collateral} ${loan.kind === "ERC20" ? "was" : "were"} collected. Strategy settlement is pending.`;
    return message(strategy, o, "claimable", loan.dealId, strategy.curator, `Loan #${loan.dealId} reached claimable time`,
      `Loan #${loan.dealId} reached claimable time ${formatMoment(loan.claimableAt, o.timezone, true)}. ${completed}`, true);
  }
  if (loan.settled) return undefined;
  return message(strategy, o, "claimable", loan.dealId, strategy.curator, `Loan #${loan.dealId} is claimable`,
    `Loan #${loan.dealId} is claimable from ${formatMoment(loan.claimableAt, o.timezone, true)}. The keeper can recover its collateral for the holders of record.`, true);
}

export function keeperNotice(strategy: EarnStrategy, alert: EarnKeeperAlert, o: NoticeOptions): EarnMessage {
  const subject = { keeper_revert: "Keeper action failed", harvest_failed: "Collection failed", reserve_redemption_failed: "External lending withdrawal failed" }[alert.code];
  return message(strategy, o, alert.code, alert.id, strategy.curator, subject,
    `${subject} after ${alert.attempts} attempts at ${formatMoment(alert.at, o.timezone, true)}. Check the keeper before retrying.`, true);
}

/** Loan outcomes are strategy-wide: the curator and every subscribed holder hear them; a served request names its requester. */
export function outcomeNotices(strategy: EarnStrategy, notice: EarnNotice, holders: readonly string[], o: NoticeOptions): EarnMessage[] {
  const subject = { repayment: "Repayment received", collateral: "Collateral received", refund: "Commitment refunded", overdue: "Loan overdue", served: "Request served" }[notice.kind];
  const usdg = `${formatUSDG(BigInt(notice.amount), strategy.usdgDecimals)} USDG`;
  const days = Math.max(1, Math.round(strategy.totals.profitUnlockSeconds / 86400));
  let detail: string;
  if (notice.kind === "collateral") {
    const token = notice.token.toLowerCase() === "0x0000000000000000000000000000000000000000"
      ? { symbol: "ETH", decimals: 18, uiMultiplier: null }
      : notice.token.toLowerCase() === strategy.usdg.toLowerCase()
        ? { symbol: "USDG", decimals: strategy.usdgDecimals, uiMultiplier: null }
        : strategy.tokens.find(token => token.token.toLowerCase() === notice.token.toLowerCase())
          ?? strategy.pockets.find(pocket => pocket.dealId === notice.dealId && pocket.token.toLowerCase() === notice.token.toLowerCase())?.metadata;
    const amount = describeCollateral({ kind: "ERC20", amountOrTokenId: notice.amount, token: notice.token, id: "", cap: "0", price: "0", expiry: 0, graceEnd: 0 }, token);
    detail = `${subject} for loan #${notice.dealId ?? ""}: ${amount} was recovered into a side pocket for the holders of record. Each holder claims their part from the ${title(strategy)} page.`;
  } else if (notice.kind === "repayment") {
    const recovery = strategy.pockets.some(pocket => pocket.dealId === notice.dealId && pocket.token.toLowerCase() === strategy.usdg.toLowerCase());
    detail = recovery
      ? `${subject} for loan #${notice.dealId ?? ""}: ${usdg} is in a USDG recovery pocket for the holders of record at write-down. Eligible holders claim their part from the ${title(strategy)} page.`
      : `${subject} for loan #${notice.dealId ?? ""}: ${usdg} returned to ${title(strategy)}. Any premium is credited to the share price over ${days} days.`;
  } else if (notice.kind === "refund") {
    detail = `${subject} for listing #${notice.dealId ?? ""}: it did not activate, so ${usdg} returned to ${title(strategy)} as cash with no fee.`;
  } else if (notice.kind === "overdue") {
    detail = `Loan #${notice.dealId ?? ""} is overdue: ${usdg} of principal left the share price. Collateral is recovered after the grace period.`;
  } else {
    detail = `${subject}: ${usdg} is ready to claim from ${title(strategy)}.`;
  }
  const wallets = notice.kind === "served" ? [notice.account] : [strategy.curator, ...holders.filter(holder => holder.toLowerCase() !== strategy.curator.toLowerCase())];
  return wallets.map(wallet => message(strategy, o, notice.kind, notice.id, wallet, subject, detail));
}
