import { describe, expect, it } from "vitest";
import { Pricer } from "../src/pricing/pricer.js";
import { positionValueAt, solveCapSqrtPrice, valueDeal, type PositionModel } from "../src/valuation/deal.js";
import { valueAsset } from "../src/valuation/asset.js";
import { ApiError } from "../src/errors.js";
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from "../src/math/tickMath.js";
import { NATIVE } from "../src/deployment.js";
import { A, FakeReader, NVDA_KEY, POOL_ID, fixtureDeployment, sqrtPriceOf } from "./helpers/fake.js";

function setup(withV4 = true): { reader: FakeReader; pricer: Pricer } {
  const reader = new FakeReader();
  const deployment = fixtureDeployment(withV4);
  return { reader, pricer: new Pricer(reader, deployment) };
}

describe("ERC-20 valuation", () => {
  it("prices sGAGE through GAGE, native ETH and USDG", async () => {
    const { reader, pricer } = setup();
    const v = await valueAsset({ reader, pricer }, A.sGAGE);
    expect(Number(v.priceUSDG)).toBeCloseTo(0.3, 10);
    expect(v.source.kind).toBe("three-hop");
    expect(v.source.pools).toEqual(["gageSgage", "gageEth", "usdgEth"]);
    expect(pricer.routes(A.sGAGE).every(route => route.length <= 3 && new Set(route.map(p => p.poolId)).size === route.length)).toBe(true);
  });

  it("prices a Stock Token through the stock/USDG pool", async () => {
    const { reader, pricer } = setup();
    reader.addDeal(1n, A.NVDAx, 10n * 10n ** 18n, 800n * 10n ** 6n, "STOCK");
    const v = await valueDeal({ reader, pricer }, 1n);
    expect(v.priceUSDG).toBe("100");
    expect(v.valueUSDG).toBe((1000n * 10n ** 6n).toString());
    expect(v.source).toEqual({ kind: "pool", pools: ["nvdaUsdg"], asOfBlock: 1000 });
    expect(v.scenarios.now).toBe(v.valueUSDG);
    expect(v.scenarios.atCap).toBe((800n * 10n ** 6n).toString());
    expect(v.scenarios.down20).toBe((800n * 10n ** 6n).toString());
    expect(v.scenarios.down50).toBe((500n * 10n ** 6n).toString());
    expect(v.scenarios.down80).toBeNull();
    expect(v.scenarios.atRangeTop).toBeNull();
    expect(v.position).toBeNull();
    expect(v.reference.chainlink).toBeNull();
    expect(v.lane).toBe("STOCK");
    // cap is reached when NVDA falls 20%
    expect(v.capPrice).toEqual({ priceUSDG: "80", moveBps: -2000 });
  });

  it("prices a meme in two hops and adds the −80% scenario", async () => {
    const { reader, pricer } = setup();
    reader.addDeal(2n, A.NVDOG, 1_000_000n * 10n ** 18n, 10n * 10n ** 6n, "MEME");
    const v = await valueDeal({ reader, pricer }, 2n);
    expect(v.priceUSDG).toBe("0.1"); // 0.001 NVDA × 100 USDG
    expect(v.valueUSDG).toBe((100_000n * 10n ** 6n).toString());
    expect(v.source.kind).toBe("two-hop");
    expect(v.source.pools).toEqual(["nvdogNvda", "nvdaUsdg"]);
    expect(v.scenarios.down80).toBe((20_000n * 10n ** 6n).toString());
    expect(v.lane).toBe("MEME");
  });

  it("returns NO_POOL while the v4 layer is absent", async () => {
    const { reader, pricer } = setup(false);
    reader.addDeal(1n, A.NVDAx, 10n ** 18n, 10n ** 6n, "STOCK");
    await expect(valueDeal({ reader, pricer }, 1n)).rejects.toMatchObject({ code: "NO_POOL" });
  });

  it("404s an unknown deal", async () => {
    const { reader, pricer } = setup();
    const err = await valueDeal({ reader, pricer }, 99n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("NOT_FOUND");
  });

  it("values ETH through usdgEth and treats WETH-less deployments as native only", async () => {
    const { reader, pricer } = setup();
    const v = await valueAsset({ reader, pricer }, NATIVE);
    // 3e-9 has no exact sqrtPriceX96, so the fixture sits a hair under 3000
    expect(Math.abs(Number(v.priceUSDG) - 3000)).toBeLessThan(1e-9);
    expect(v.source.pools).toEqual(["usdgEth"]);
    expect(v.symbol).toBe("ETH");
  });
});

describe("position valuation", () => {
  it("uses the V2 haircut and 80% downside without altering V1", async () => {
    const { reader, pricer } = setup();
    const state = reader.pools.get(POOL_ID.nvdaUsdg)!;
    const tick = getTickAtSqrtPrice(state.sqrtPriceX96);
    reader.addPositionDeal(1n, 1n, 100n * 10n ** 6n, NVDA_KEY, Math.floor((tick-6000)/60)*60, Math.ceil((tick+6000)/60)*60, 10n ** 15n);
    const legacy = await valueDeal({reader,pricer},1n);
    expect(legacy.suggestedCap.shareBps).toBe(9000);
    pricer.deployment.vaultVersion=2;
    const v2 = await valueDeal({reader,pricer},1n);
    expect(v2.suggestedCap.capUSDG).toBe((BigInt(v2.valueUSDG)/2n).toString());
    expect(v2.suggestedCap.shareBps).toBe(5000);
    expect(BigInt(v2.scenarios.down80!)).toBeLessThan(BigInt(v2.scenarios.down50));
  });
  it("values both meme/stock sides and fees, with meme scenarios regardless of token ordering", async () => {
    const { reader, pricer } = setup();
    reader.configs.set(A.NVDAx, { allowed: true, lane: "STOCK", minAmount: 1n, maxDealRaw: 1n, maxOpenRaw: 1n });
    reader.configs.set(A.NVDOG, { allowed: true, lane: "MEME", minAmount: 1n, maxDealRaw: 1n, maxOpenRaw: 1n });
    const key = pricer.deployment.pools.nvdogNvda!;
    const state = reader.pools.get(POOL_ID.nvdogNvda)!;
    const tick = getTickAtSqrtPrice(state.sqrtPriceX96);
    const lower = Math.floor((tick - 6000) / 200) * 200;
    const upper = Math.ceil((tick + 6000) / 200) * 200;
    const liquidity = 10n ** 18n;
    reader.addPositionDeal(9n, 19n, 100_000_000n, key, lower, upper, liquidity);
    reader.feeGrowth.set(`${POOL_ID.nvdogNvda}:${lower}:${upper}`, { inside0: 1n << 128n, inside1: 2n << 128n });
    const v = await valueDeal({ reader, pricer }, 9n);
    const p = v.position!;
    expect(v.asset.symbol).toBe("NVDOG");
    expect(p.assetIsCurrency0).toBe(false);
    expect(p.quoteAsset.symbol).toBe("NVDAx");
    expect(p.quoteAsset.priceUSDG).toBe("100");
    const stockValue = (BigInt(p.amount0) + liquidity) * 100_000_000n / 10n ** 18n;
    const memeValue = (BigInt(p.amount1) + 2n * liquidity) * 100_000n / 10n ** 18n;
    expect(BigInt(v.valueUSDG) - stockValue - memeValue).toBeGreaterThanOrEqual(-2n);
    expect(BigInt(v.valueUSDG) - stockValue - memeValue).toBeLessThanOrEqual(2n);
    expect(BigInt(p.value0USDG) + BigInt(p.value1USDG)).toBe(BigInt(v.valueUSDG));
    expect(BigInt(p.feesUSDG)).toBeGreaterThan(100_000_000n);
    expect(Number(p.rangeLowerUSDG)).toBeLessThan(Number(v.priceUSDG));
    expect(Number(p.rangeUpperUSDG)).toBeGreaterThan(Number(v.priceUSDG));
    expect(BigInt(v.scenarios.down50)).toBeLessThan(BigInt(v.valueUSDG));
    expect(p.scenarioAssumption).toContain("NVDAx USDG price held constant");
  });
  it("values an in-range stock/USDG position from liquidity and ticks, with uncollected fees", async () => {
    const { reader, pricer } = setup();
    const state = reader.pools.get(POOL_ID.nvdaUsdg)!;
    const tick = getTickAtSqrtPrice(state.sqrtPriceX96);
    const lower = Math.floor((tick - 6000) / 60) * 60;
    const upper = Math.ceil((tick + 6000) / 60) * 60;
    const liquidity = 10n ** 15n;
    reader.addPositionDeal(3n, 7n, 100n * 10n ** 6n, NVDA_KEY, lower, upper, liquidity);
    // fee growth inside grew by 2^128 per unit of liquidity on each side: fees = liquidity on each side
    reader.feeGrowth.set(`${POOL_ID.nvdaUsdg}:${lower}:${upper}`, { inside0: 1n << 128n, inside1: 1n << 128n });
    const v = await valueDeal({ reader, pricer }, 3n);
    expect(v.position).not.toBeNull();
    const p = v.position!;
    expect(p.inRange).toBe(true);
    expect(p.uncollectedFees0).toBe(liquidity.toString());
    expect(p.uncollectedFees1).toBe(liquidity.toString());
    // value = amount0 (USDG) + amount1 (NVDAx) × 100 USDG + fees
    const amount0 = BigInt(p.amount0);
    const amount1 = BigInt(p.amount1);
    const expected = amount0 + liquidity + ((amount1 + liquidity) * 100n * 10n ** 6n) / 10n ** 18n;
    expect(BigInt(v.valueUSDG) - expected).toBeLessThanOrEqual(1n);
    expect(v.lane).toBe("POSITION");
    expect(v.asset.symbol).toBe("NVDAx");
    // at the range top (all USDG) the position is worth more than now only if it holds NVDA that would be sold up
    expect(v.scenarios.atRangeTop).not.toBeNull();
    expect(BigInt(v.scenarios.down20!)).toBeLessThan(BigInt(v.scenarios.now));
    expect(BigInt(v.scenarios.down50!)).toBeLessThan(BigInt(v.scenarios.down20!));
    expect(v.scenarios.down80).toBeNull();
    expect(v.source.pools).toEqual(["nvdaUsdg"]);
  });

  it("solves the pool price at which a position is worth the cap", () => {
    const sqrtP = sqrtPriceOf(10n ** 10n, 1n);
    const model: PositionModel = {
      liquidity: 10n ** 15n,
      sqrtLower: getSqrtPriceAtTick(getTickAtSqrtPrice(sqrtP) - 6000),
      sqrtUpper: getSqrtPriceAtTick(getTickAtSqrtPrice(sqrtP) + 6000),
      fees0: 0n,
      fees1: 0n,
      sqrtPriceX96: sqrtP,
      p0: { num: 1n, den: 1n },
      p1: { num: 10n ** 8n, den: 10n ** 18n }, // USDG raw per NVDAx raw at spot
      assetIsCurrency0: false,
      otherIsUSDG: true
    };
    const now = positionValueAt(model, sqrtP);
    const cap = now / 2n;
    const s = solveCapSqrtPrice(model, cap);
    expect(s).not.toBeNull();
    const at = positionValueAt(model, s!);
    // within one part in a million of the cap
    expect((at > cap ? at - cap : cap - at) * 1_000_000n).toBeLessThanOrEqual(cap);
    // asset is currency1 so a lower value means a higher pool price (fewer currency1 per currency0)
    expect(s!).toBeGreaterThan(sqrtP);
    expect(solveCapSqrtPrice(model, now * 100n)).toBeNull();
  });

  it("404s a position that is not on the PositionManager", async () => {
    const { reader, pricer } = setup();
    reader.addPositionDeal(4n, 8n, 1n, NVDA_KEY, -60, 60, 1n);
    reader.positions.delete(8n);
    await expect(valueDeal({ reader, pricer }, 4n)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
