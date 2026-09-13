import { describe, expect, it } from "vitest";
import { NATIVE } from "../src/deployment.js";
import { Pricer } from "../src/pricing/pricer.js";
import { quoteEntry } from "../src/quote/entry.js";
import { parsePayoutTarget, quotePayout } from "../src/quote/payout.js";
import { matchAmounts, quoteReinvest, resolveReinvestPools } from "../src/quote/reinvest.js";
import { swapAlongRoute } from "../src/quote/route.js";
import { A, FakeReader, POOL_ID, fixtureDeployment } from "./helpers/fake.js";

function setup(withV4 = true): { reader: FakeReader; pricer: Pricer } {
  const reader = new FakeReader();
  return { reader, pricer: new Pricer(reader, fixtureDeployment(withV4)) };
}

describe("payout quote", () => {
  it("sells USDG for ETH through usdgEth with the fee and impact accounted for", async () => {
    const { reader, pricer } = setup();
    const deployment = pricer.deployment;
    const usdg = 3000n * 10n ** 6n; // 3000 USDG ≈ 1 ETH before fee and impact
    const q = await quotePayout({ pricer, reader, deployment }, usdg, NATIVE, 100);
    const out = BigInt(q.amountOut);
    expect(out).toBeGreaterThan((994n * 10n ** 18n) / 1000n); // 0.05% fee + tiny impact
    expect(out).toBeLessThan(10n ** 18n);
    expect(BigInt(q.minOut)).toBe((out * 9900n) / 10_000n);
    expect(q.route.pools).toEqual(["usdgEth"]);
    expect(q.route.path).toEqual(["USDG", "ETH"]);
    expect(q.to.symbol).toBe("ETH");
    expect(Number(q.rate)).toBeGreaterThan(3000); // USDG per ETH at execution, a little above spot
    expect(Number(q.rate)).toBeLessThan(3003);
    expect(q.priceImpactBps).toBeGreaterThanOrEqual(0);
    expect(q.priceImpactBps).toBeLessThan(10);
    expect(BigInt(q.feePaidUSDG)).toBe((usdg * 5n + 9999n) / 10_000n);
    expect(q.slippageBps).toBe(100);
  });

  it("sells USDG for a Stock Token through its USDG pool", async () => {
    const { reader, pricer } = setup();
    const q = await quotePayout({ pricer, reader, deployment: pricer.deployment }, 1000n * 10n ** 6n, A.NVDAx);
    const out = BigInt(q.amountOut);
    // 1000 USDG buys about 10 NVDA less the 0.3% fee
    expect(out).toBeGreaterThan((996n * 10n ** 16n));
    expect(out).toBeLessThan(10n * 10n ** 18n);
    expect(q.route.pools).toEqual(["nvdaUsdg"]);
    expect(Number(q.rate)).toBeGreaterThan(100);
    expect(Number(q.rate)).toBeLessThan(100.5);
  });

  it("reaches a meme in two hops", async () => {
    const { reader, pricer } = setup();
    const q = await quotePayout({ pricer, reader, deployment: pricer.deployment }, 100n * 10n ** 6n, A.NVDOG);
    expect(q.route.pools).toEqual(["nvdaUsdg", "nvdogNvda"]);
    expect(q.route.path).toEqual(["USDG", "NVDAx", "NVDOG"]);
    // 100 USDG ≈ 1000 NVDOG before fees (0.3% + 1%)
    const out = BigInt(q.amountOut);
    expect(out).toBeGreaterThan(975n * 10n ** 18n);
    expect(out).toBeLessThan(987n * 10n ** 18n);
  });

  it("reports price impact that grows with size", async () => {
    const { pricer } = setup();
    const small = await swapAlongRoute(pricer, A.USDG, [pricer.deployment.pools.usdgEth!], 10n ** 6n);
    const large = await swapAlongRoute(pricer, A.USDG, [pricer.deployment.pools.usdgEth!], 10n ** 12n);
    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
  });

  it("refuses USDG as the target and validates slippage", async () => {
    const { reader, pricer } = setup();
    await expect(quotePayout({ pricer, reader, deployment: pricer.deployment }, 1n, A.USDG)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(quotePayout({ pricer, reader, deployment: pricer.deployment }, 1n, NATIVE, 501)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answers NO_POOL while the pools are absent", async () => {
    const { reader, pricer } = setup(false);
    await expect(quotePayout({ pricer, reader, deployment: pricer.deployment }, 10n ** 6n, NATIVE)).rejects.toMatchObject({ code: "NO_POOL" });
  });

  it("parses the target", () => {
    const d = fixtureDeployment();
    expect(parsePayoutTarget("ETH", d)).toBe(NATIVE);
    expect(parsePayoutTarget("eth", d)).toBe(NATIVE);
    expect(parsePayoutTarget(A.NVDAx.toUpperCase().replace("0X", "0x"), d)).toBe(A.NVDAx);
    expect(() => parsePayoutTarget("nvda", d)).toThrow();
    expect(() => parsePayoutTarget(undefined, d)).toThrow();
  });
});

describe("entry quote", () => {
  it("sells ETH for USDG through usdgEth", async () => {
    const { pricer } = setup();
    const q = await quoteEntry(pricer, pricer.deployment, 10n ** 18n, 100);
    const out = BigInt(q.usdgOut);
    expect(out).toBeGreaterThan(2990n * 10n ** 6n);
    expect(out).toBeLessThan(3000n * 10n ** 6n);
    expect(BigInt(q.minUsdg)).toBe((out * 9900n) / 10_000n);
    expect(q.route.pools).toEqual(["usdgEth"]);
    expect(q.route.router).toContain("minHopPriceX36");
  });
});

describe("reinvest quote", () => {
  it.each(["ETH", "USDG"] as const)("quotes %s through funding pools into GAGE/sGAGE with all limits", async inputAsset => {
    const { pricer } = setup();
    const amount = inputAsset === "ETH" ? 10n ** 18n : 3000n * 10n ** 6n;
    const q = await quoteReinvest({ pricer, pools: resolveReinvestPools(pricer.deployment) }, { inputAsset, amount, tickLower: -6000, tickUpper: 6000, route: "zap", payAsset: "ETH", slippageBps: 100 });
    expect(q.route).toBe("funded-zap");
    if (q.route !== "funded-zap") throw Error("wrong route");
    expect(q.inputAsset).toBe(inputAsset);
    expect(q.amountIn).toBe(String(amount));
    expect(q.pools).toEqual(inputAsset === "ETH" ? ["gageEth", "gageSgage"] : ["usdgEth", "gageEth", "gageSgage"]);
    expect(BigInt(q.gageBought)).toBeGreaterThan(9900n * 10n ** 18n);
    expect(BigInt(q.gageBought)).toBeLessThan(10000n * 10n ** 18n);
    expect(BigInt(q.minGageOut)).toBe(BigInt(q.gageBought) * 99n / 100n);
    expect(BigInt(q.gageRemaining) + BigInt(q.gageToSwap)).toBe(BigInt(q.gageBought));
    expect(BigInt(q.minLiquidity)).toBeGreaterThan(0n);
    expect(BigInt(q.minSgageOut)).toBeGreaterThan(0n);
    expect(q.fundingFees.map(f => f.asset)).toEqual(inputAsset === "ETH" ? ["ETH"] : ["USDG", "ETH"]);
    if (inputAsset === "USDG") expect(BigInt(q.minEthOut)).toBeGreaterThan(0n);
    await expect(quoteReinvest({ pricer, pools: resolveReinvestPools(pricer.deployment) }, { inputAsset, amount, tickLower: -6000, tickUpper: 6000, route: "match", payAsset: "ETH", slippageBps: 100 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("zaps GAGE using only GAGE/sGAGE with bounded output, fees and liquidity", async () => {
    const { pricer } = setup();
    const pools = { ...resolveReinvestPools(pricer.deployment), gageEth: null, usdgEth: null };
    const amount = 1000n * 10n ** 18n;
    const q = await quoteReinvest({ pricer, pools }, { inputAsset: "GAGE", amount, tickLower: -6000, tickUpper: 6000, route: "zap", payAsset: "USDG", slippageBps: 100 });
    expect(q.route).toBe("gage-zap");
    if (q.route !== "gage-zap") throw new Error("wrong route");
    expect(q.pools).toEqual(["gageSgage"]);
    expect(BigInt(q.gageToSwap) + BigInt(q.gageRemaining)).toBe(amount);
    expect(BigInt(q.sgageOut)).toBeGreaterThan(0n);
    expect(BigInt(q.minSgageOut)).toBe(BigInt(q.sgageOut) * 9900n / 10000n);
    expect(BigInt(q.minLiquidity)).toBeGreaterThan(0n);
    expect(BigInt(q.feeOnSwapped)).toBe((BigInt(q.gageToSwap) * BigInt(q.feePips) + 999999n) / 1000000n);
  });

  it("rejects GAGE Match, dust and non-earning ranges", async () => {
    const { pricer } = setup();
    const ctx = { pricer, pools: resolveReinvestPools(pricer.deployment) };
    const p = { inputAsset: "GAGE" as const, amount: 10n ** 18n, tickLower: -6000, tickUpper: 6000, route: "zap" as const, payAsset: "USDG" as const, slippageBps: 100 };
    await expect(quoteReinvest(ctx, { ...p, route: "match" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(quoteReinvest(ctx, { ...p, amount: 1n })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(quoteReinvest(ctx, { ...p, tickLower: 6000, tickUpper: 12000 })).rejects.toMatchObject({ code: "RANGE_ONE_SIDED" });
  });
  it("match pairs sGAGE with GAGE at 1:1 in a symmetric range and prices the GAGE in USDG", async () => {
    const { pricer } = setup();
    const pools = resolveReinvestPools(pricer.deployment);
    const amount = 1000n * 10n ** 18n;
    const q = await quoteReinvest({ pricer, pools }, { amount, tickLower: -6000, tickUpper: 6000, route: "match", payAsset: "USDG", slippageBps: 100 });
    expect(q.route).toBe("match");
    if (q.route !== "match") return;
    // symmetric range at price 1: the GAGE needed equals the sGAGE brought (within rounding)
    const gage = BigInt(q.gageNeeded);
    expect(gage - amount).toBeLessThanOrEqual(1n);
    expect(gage - amount).toBeGreaterThanOrEqual(-1n);
    // 1000 GAGE = 0.1 ETH = 300 USDG, plus fees on both hops
    const pay = BigInt(q.payAmount);
    expect(pay).toBeGreaterThan(300n * 10n ** 6n);
    expect(pay).toBeLessThan(302n * 10n ** 6n);
    expect(BigInt(q.maxPay)).toBe((pay * 10_100n) / 10_000n);
    expect(q.pools).toEqual(["gageSgage", "usdgEth", "gageEth"]);
    expect(BigInt(q.minLiquidity)).toBeGreaterThan(0n);
    expect(q.note).not.toMatch(/best|interest|APY/);
  });

  it("match in ETH uses only gageEth", async () => {
    const { pricer } = setup();
    const pools = resolveReinvestPools(pricer.deployment);
    const q = await quoteReinvest({ pricer, pools }, { amount: 10n ** 18n, tickLower: -6000, tickUpper: 6000, route: "match", payAsset: "ETH", slippageBps: 50 });
    if (q.route !== "match") throw new Error("expected match");
    expect(q.pools).toEqual(["gageSgage", "gageEth"]);
    const eth = BigInt(q.payAmount);
    expect(eth).toBeGreaterThan(10n ** 14n); // 1 GAGE = 0.0001 ETH
    expect(eth).toBeLessThan((1004n * 10n ** 14n) / 1000n);
  });

  it("zap sells about half and states the 3% fee", async () => {
    const { pricer } = setup();
    const pools = resolveReinvestPools(pricer.deployment);
    const amount = 1000n * 10n ** 18n;
    const q = await quoteReinvest({ pricer, pools }, { amount, tickLower: -6000, tickUpper: 6000, route: "zap", payAsset: "USDG", slippageBps: 100 });
    if (q.route !== "zap") throw new Error("expected zap");
    const sold = BigInt(q.sgageToSell);
    expect(sold).toBeGreaterThan(amount / 2n);
    expect(sold).toBeLessThan((amount * 53n) / 100n);
    expect(BigInt(q.maxSold)).toBe((sold * 10_100n) / 10_000n);
    expect(BigInt(q.feeOnSold)).toBe((sold * 3n + 99n) / 100n);
    expect(q.note).toContain("3.00%");
    expect(q.pools).toEqual(["gageSgage"]);
  });

  it("rejects a one-sided range that cannot take sGAGE and bad ticks", async () => {
    const { pricer } = setup();
    const pools = resolveReinvestPools(pricer.deployment);
    // sGAGE is currency1 in the fixture; a range entirely above the price holds only currency0 = GAGE
    await expect(quoteReinvest({ pricer, pools }, { amount: 1n, tickLower: 6000, tickUpper: 12000, route: "match", payAsset: "USDG", slippageBps: 100 })).rejects.toMatchObject({ code: "RANGE_ONE_SIDED" });
    await expect(quoteReinvest({ pricer, pools }, { amount: 1n, tickLower: -61, tickUpper: 60, route: "match", payAsset: "USDG", slippageBps: 100 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(quoteReinvest({ pricer, pools }, { amount: 1n, tickLower: -60, tickUpper: 60, route: "match", payAsset: "USDG", slippageBps: 600 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("matchAmounts needs no GAGE for a range entirely below the price when sGAGE is currency1", async () => {
    const { reader, pricer } = setup();
    const state = await pricer.poolState(pricer.deployment.pools.gageSgage!);
    const m = matchAmounts(state, false, 10n ** 18n, -12000, -6000);
    expect(m.gageNeeded).toBe(0n);
    expect(m.liquidity).toBeGreaterThan(0n);
    expect(reader.pools.get(POOL_ID.gageSgage)).toBeDefined();
  });

  it("answers NO_POOL without the token layer", () => {
    expect(() => resolveReinvestPools(fixtureDeployment(false))).toThrow(expect.objectContaining({ code: "NO_POOL" }));
  });
});
