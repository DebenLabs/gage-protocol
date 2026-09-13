import { describe, expect, it } from "vitest";
import { buybackFeeAmounts } from "../src/lib/buyback-fees";

describe("executed buyback fee accounting", () => {
  it("excludes operations and caller bounties and retains every clip in a transaction", () => {
    expect(buybackFeeAmounts([
      { ethTotal: 100n, ethToOps: 49n, bounty: 1n },
      { ethTotal: 201n, ethToOps: 100n, bounty: 0n },
    ], [{ usdgIn: 123456789n }, { usdgIn: 75n }])).toEqual({ creatorETH: 151n, dealUSDG: 123456864n });
  });
  it("reconciles the verified 8 September executed totals without adding unspent lending fees", () => {
    const { creatorETH, dealUSDG } = buybackFeeAmounts([
      { ethTotal: 16172585354585488200n, ethToOps: 8086292677292744056n, bounty: 0n },
    ], [{ usdgIn: 367518189n }]);
    expect(creatorETH * 2472029827n / 10n ** 18n + dealUSDG).toBe(20357074877n);
  });
  it("distinguishes confirmed zero spending from corrupt rows", () => {
    expect(buybackFeeAmounts([], [])).toEqual({ creatorETH: 0n, dealUSDG: 0n });
    expect(() => buybackFeeAmounts([{ ethTotal: 1n, ethToOps: 2n, bounty: 0n }], [])).toThrow();
    expect(() => buybackFeeAmounts([], [{ usdgIn: -1n }])).toThrow();
  });
});
