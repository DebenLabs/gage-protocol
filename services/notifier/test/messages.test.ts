import { describe, expect, it } from "vitest";
import { formatCompactSGAGE, formatDay, formatMoment, formatUSDG, hostOf } from "../src/format.js";
import { describeCollateral, renderBudgetExhausted, renderDealNotice, renderEpochRoll, violations, type DealNoticeKind } from "../src/messages.js";
import { designDeal, EXPIRY, GRACE_END, nvdaAsset } from "./helpers.js";

const deal = designDeal();
const o = { timezone: "UTC", usdgDecimals: 6, appUrl: "https://gage.cash", asset: nvdaAsset };

describe("format", () => {
  it("renders moments and days the way the register does", () => {
    expect(formatMoment(EXPIRY, "UTC", true)).toBe("8 Sep 16:40 UTC");
    expect(formatMoment(GRACE_END, "UTC", false)).toBe("9 Sep 16:40");
    expect(formatMoment(Date.UTC(2026, 8, 14, 0, 0) / 1000, "UTC", true)).toBe("14 Sep 00:00 UTC");
    expect(formatDay(Date.UTC(2026, 8, 14, 0, 0) / 1000, "UTC")).toBe("Monday 14 Sep");
    expect(formatUSDG(1_824_000_000n, 6)).toBe("1,824.00");
    expect(formatUSDG(1_814_880_000n, 6)).toBe("1,814.88");
    expect(formatCompactSGAGE(2_000_000n * 10n ** 18n)).toBe("2.00M");
    expect(formatCompactSGAGE(1_340_000n * 10n ** 18n)).toBe("1.34M");
    expect(formatCompactSGAGE(402_000n * 10n ** 18n)).toBe("402.0K");
    expect(hostOf("https://gage.cash/")).toBe("gage.cash");
  });
  it("describes collateral as amount and symbol, scaled by the UI multiplier when there is one", () => {
    expect(describeCollateral(deal, nvdaAsset)).toBe("12.5 NVDA");
    expect(describeCollateral(deal, { ...nvdaAsset, uiMultiplier: (2n * 10n ** 18n).toString() })).toBe("25 NVDA");
    expect(describeCollateral({ ...deal, kind: "UNIV4_POSITION", amountOrTokenId: "112" }, undefined)).toBe("position #112");
    expect(describeCollateral({ ...deal, kind: "UNIV3_POSITION", amountOrTokenId: "113" }, undefined)).toBe("position #113");
    expect(describeCollateral(deal, undefined)).toBe("12500000000000000000 0x5ef1…41f3");
  });
});

describe("renderDealNotice matches docs/ui-screens.md 8h word for word", () => {
  it("48 h", () => {
    expect(renderDealNotice("t48", deal, o).text).toBe(
      "#4821 · 12.5 NVDA expires 8 Sep 16:40 UTC. Reclaim for 1,824.00 USDG before 9 Sep 16:40, or walk away and keep 1,814.88. gage.cash/deal/4821",
    );
  });
  it("24 h, with the wallet balance when known", () => {
    expect(renderDealNotice("t24", deal, { ...o, walletUSDG: 2_102_400_000n }).text).toBe(
      "#4821 expires in 24 h. Reclaim 1,824.00 USDG or walk away. Wallet has 2,102.40. gage.cash/deal/4821",
    );
    expect(renderDealNotice("t24", deal, o).text).toBe("#4821 expires in 24 h. Reclaim 1,824.00 USDG or walk away. gage.cash/deal/4821");
  });
  it("6 h", () => {
    expect(renderDealNotice("t6", deal, o).text).toBe("#4821 expires in 6 h. Reclaim 12.5 NVDA for 1,824.00 USDG, or walk away.");
  });
  it("1 h", () => {
    expect(renderDealNotice("t1", deal, o).text).toBe("#4821 expires in 1 h. Grace runs to 9 Sep 16:40 UTC, after which the lender keeps 12.5 NVDA.");
  });
  it("lender, grace ended", () => {
    expect(renderDealNotice("claimable", deal, o).text).toBe("#4821 · the borrower walked away, so 12.5 NVDA is yours to claim.");
  });
  it("expiry, with the grace deadline, in the same voice", () => {
    expect(renderDealNotice("expiry", deal, o).text).toBe(
      "#4821 · 12.5 NVDA expired 8 Sep 16:40 UTC. Grace runs to 9 Sep 16:40 UTC: reclaim for 1,824.00 USDG before then, or walk away and keep 1,814.88. gage.cash/deal/4821",
    );
  });
  it("follows the configured time zone", () => {
    expect(renderDealNotice("t1", deal, { ...o, timezone: "America/New_York" }).text).toContain("Grace runs to 9 Sep 12:40 EDT");
  });
});

describe("reward notices", () => {
  const epoch = { n: 37, startsAt: Date.UTC(2026, 8, 14) / 1000, endsAt: Date.UTC(2026, 8, 21) / 1000, dealBudget7: (600_000n * 10n ** 18n).toString(), dealBudget21: (1_400_000n * 10n ** 18n).toString() };
  it("budget exhausted carries the fixed sentence from design-brief §6", () => {
    const r = renderBudgetExhausted(7, { ...epoch, n: 36, endsAt: epoch.startsAt }, o);
    expect(r.text).toBe("Week 36 · 7-day deals: this week's rewards are fully allocated. New deals earn rewards again on Monday 14 Sep. gage.cash/rewards");
  });
  it("epoch roll names the week, its opening moment and the budgets", () => {
    expect(renderEpochRoll(epoch, o).text).toBe("Week 37 opens 14 Sep 00:00 UTC · 2.00M sGAGE for deals this week, 600.0K on 7 days and 1.40M on 21 days. gage.cash/rewards");
  });
});

describe("banned words", () => {
  it("flags the design brief's list and allows `no liquidation`", () => {
    expect(violations("Fixed cost, never interest. No liquidation.")).toEqual(["interest"]);
    expect(violations("liquidation risk")).toEqual(["liquidation"]);
    expect(violations("Reclaim or walk away.")).toEqual([]);
  });
  it("finds none in any rendered message", () => {
    const kinds: DealNoticeKind[] = ["t48", "t24", "t6", "t1", "expiry", "claimable"];
    for (const k of kinds) {
      const r = renderDealNotice(k, deal, { ...o, walletUSDG: 1n });
      expect(violations(`${r.subject} ${r.text}`), k).toEqual([]);
    }
    const epoch = { n: 1, startsAt: 0, endsAt: 604_800, dealBudget7: "0", dealBudget21: "0" };
    expect(violations(renderEpochRoll(epoch, o).text)).toEqual([]);
    expect(violations(renderBudgetExhausted(21, epoch, o).text)).toEqual([]);
  });
});
