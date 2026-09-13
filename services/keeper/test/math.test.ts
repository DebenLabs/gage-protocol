import { describe, expect, it } from "vitest";
import { decidePrep, feesByTerm } from "../src/jobs/prep.js";
import { composePrice, conservativeRewardPrice, priceUSDGPerSGAGE, pruneSamples } from "../src/jobs/price.js";
import { extrapolate, poolPrice, priceOfIn, proposeRates, timeWeightedAverage, toScaled } from "../src/math.js";
import { A } from "./helpers.js";

const Q96 = 1n << 96n;
const WAD = 10n ** 18n;
const DAY = 86_400;

describe("pool prices", () => {
  it("sqrtPriceX96 = 2^96 means 1:1", () => {
    expect(poolPrice(Q96)).toEqual({ num: 1n, den: 1n });
  });
  it("prices either currency in the other", () => {
    const sqrt = 2n * Q96; // currency1 per currency0 = 4
    const pool = { currency0: A.gage, currency1: A.sgage };
    expect(toScaled(priceOfIn(A.gage, pool, sqrt), WAD)).toBe(4n * WAD);
    expect(toScaled(priceOfIn(A.sgage, pool, sqrt), WAD)).toBe(WAD / 4n);
    expect(() => priceOfIn(A.usdg, pool, sqrt)).toThrow();
  });
  it("composes sGAGE → GAGE → ETH → USDG into USDG raw per 1e18 sGAGE", () => {
    // 1 sGAGE = 0.25 GAGE; 1 GAGE = 1/1024 ETH; 1 ETH = 3000 USDG (6 decimals, 18-decimal ETH)
    const legs = [
      { token: A.sgage, pool: { currency0: A.gage, currency1: A.sgage }, sqrtPriceX96: 2n * Q96 },
      { token: A.gage, pool: { currency0: A.weth, currency1: A.gage }, sqrtPriceX96: 32n * Q96 },
      // USDG raw per ETH wei = 3000e6 / 1e18 = 3e-9  -> sqrt = sqrt(3e-9)
      { token: A.weth, pool: { currency0: A.weth, currency1: A.usdg }, sqrtPriceX96: isqrt(3n * 10n ** 9n * 2n ** 192n / 10n ** 18n) },
    ];
    const r = composePrice(legs);
    // 0.25 GAGE × (1/1024) ETH/GAGE × 3000 USDG/ETH = 0.732421875 USDG = 732_421.875 raw per sGAGE
    const raw = priceUSDGPerSGAGE(legs);
    expect(raw).toBe(732_422n); // upper bound, so reward value is never rounded up
    expect(r.den).toBeGreaterThan(0n);
  });
});

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

describe("timeWeightedAverage", () => {
  it("weights each sample by how long it held", () => {
    const twap = timeWeightedAverage(
      [
        { t: 0, priceUSDGPerSGAGE: "100" },
        { t: 30, priceUSDGPerSGAGE: "200" },
      ],
      0,
      40,
    );
    expect(twap?.price).toBe((100n * 30n + 200n * 10n) / 40n);
    expect(twap?.source).toBe("twap");
    expect(twap?.coverageSeconds).toBe(40);
  });
  it("clips the sample before the window to the window start", () => {
    const twap = timeWeightedAverage([{ t: 0, priceUSDGPerSGAGE: "100" }, { t: 50, priceUSDGPerSGAGE: "300" }], 40, 60);
    expect(twap?.price).toBe((100n * 10n + 300n * 10n) / 20n);
  });
  it("is a spot with one sample and undefined with none", () => {
    expect(timeWeightedAverage([{ t: 5, priceUSDGPerSGAGE: "7" }], 0, 5)?.source).toBe("spot");
    expect(timeWeightedAverage([], 0, 5)).toBeUndefined();
  });
  it("pruneSamples keeps twice the window", () => {
    const kept = pruneSamples([{ t: 0, priceUSDGPerSGAGE: "1" }, { t: 150, priceUSDGPerSGAGE: "2" }], 250, 100);
    expect(kept.map((s) => s.t)).toEqual([150]);
  });
});

describe("proposeRates", () => {
  const usdgUnit = 10n ** 6n;
  it("makes the budget last the week: fees × rate / unit == budget", () => {
    const p = proposeRates({
      budget7: 1_000n * WAD,
      budget21: 3_000n * WAD,
      fees7: 500n * usdgUnit,
      fees21: 1_000n * usdgUnit,
      usdgUnit,
      priceUSDGPerSGAGE: 1_000n, // 0.001 USDG per sGAGE
      maxRewardShareBps: 8_000,
    });
    expect((p.rate7 * 500n * usdgUnit) / usdgUnit).toBe(1_000n * WAD);
    expect(p.rate7).toBe(2n * WAD);
    expect(p.rate21).toBe(3n * WAD);
    expect(p.capped7).toBe(false);
    expect(p.notes).toEqual([]);
  });
  it("caps so a deal never earns more than 80% of its fee at the posted price", () => {
    const price = 500_000n; // 0.5 USDG per sGAGE
    const p = proposeRates({ budget7: 10n ** 9n * WAD, budget21: 0n, fees7: usdgUnit, fees21: 0n, usdgUnit, priceUSDGPerSGAGE: price, maxRewardShareBps: 8_000 });
    // cap: rate × fee(1 USDG) valued at price <= 0.8 USDG  ->  rate <= 1.6 sGAGE
    expect(p.rateCap).toBe((16n * WAD) / 10n);
    expect(p.rate7).toBe(p.rateCap);
    expect(p.capped7).toBe(true);
    expect(p.rate21).toBe(p.rateCap);
    expect(p.notes).toHaveLength(2);
    const fee = 40n * usdgUnit;
    const reward = (fee * p.rate7) / usdgUnit;
    expect((reward * price) / WAD).toBeLessThanOrEqual((fee * 8_000n) / 10_000n);
  });
  it("extrapolates a partial window", () => {
    expect(extrapolate(100n, 3 * DAY, 7 * DAY)).toBe((100n * 7n) / 3n);
    expect(extrapolate(100n, 7 * DAY, 7 * DAY)).toBe(100n);
    expect(extrapolate(100n, 0, 7 * DAY)).toBe(100n);
  });
});

describe("feesByTerm / decidePrep", () => {
  it("sums Funded.fee per term inside the window", () => {
    const funded = {
      "1": { dealId: "1", fee: "10", price: "1", fundedAt: 100, expiry: 100 + 7 * DAY },
      "2": { dealId: "2", fee: "20", price: "1", fundedAt: 200, expiry: 200 + 21 * DAY },
      "3": { dealId: "3", fee: "30", price: "1", fundedAt: 300, expiry: 300 + DAY },
      "4": { dealId: "4", fee: "40", price: "1", fundedAt: 1_000, expiry: 1_000 + 7 * DAY },
    };
    expect(feesByTerm(funded, 0, 1_000)).toEqual({ fees7: 10n, fees21: 20n, deals7: 1, deals21: 1, otherTerms: 1 });
  });
  it("prepares the next epoch once, inside the lead window", () => {
    const base = { launchAt: 1n, currentEpoch: 2n, weeks: 52n, nextEpochStart: 10_000, now: 0, leadSeconds: 3_600, written: [], force: false };
    expect(decidePrep(base)).toBeUndefined();
    expect(decidePrep({ ...base, now: 7_000 })).toBe(3n);
    expect(decidePrep({ ...base, now: 7_000, written: ["3"] })).toBeUndefined();
    expect(decidePrep({ ...base, force: true })).toBe(3n);
    expect(decidePrep({ ...base, force: true, currentEpoch: 51n })).toBeUndefined();
    expect(decidePrep({ ...base, force: true, launchAt: 0n })).toBeUndefined();
  });
});

// A sub-micro-dollar seed price must still produce a bounded reward proposal.
it("rounds positive reward prices upward without turning a missing price into a valid quote", () => {
  expect(conservativeRewardPrice({num: 4n, den: 10n ** 19n})).toBe(1n);
  expect(conservativeRewardPrice({num: 0n, den: 1n})).toBe(0n);
  expect(conservativeRewardPrice({num: 1n, den: 0n})).toBe(0n);
  expect(conservativeRewardPrice({num: 30001n, den: 10n ** 19n})).toBe(3001n);
});
