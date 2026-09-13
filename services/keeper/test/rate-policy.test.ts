import { describe, expect, it } from "vitest";
import { TARGET_BPS, validatedPrice, rewardValueBps, type Rates } from "../src/rate-policy.js";
import { proposeRates } from "../src/math.js";
const now = 200_000;
const samples = () => Array.from({ length: 145 }, (_, i) => ({ t: now - 86_400 + i * 600, priceUSDGPerSGAGE: "100" }));
const rates: Rates = { rate7: 5n * 10n ** 21n, rate21: 5n * 10n ** 21n, priceUSDGPerSGAGE: 100n, lenderShareBps: 5000, set: true };

describe("reward price history", () => {
  it("uses the higher validated TWAP/spot and preserves a full window", () => {
    expect(validatedPrice(samples(), now, 110n)).toMatchObject({ price: 110n, twap: 100n, coverageSeconds: 86_400 });
    expect(validatedPrice(samples(), now, 90n).price).toBe(100n);
  });
  it("rejects stale, insufficient and gapped history", () => {
    expect(() => validatedPrice(samples(), now + 601, 100n)).toThrow("stale");
    expect(() => validatedPrice(samples().slice(-1), now, 100n)).toThrow("insufficient");
    expect(() => validatedPrice(samples().slice(-20), now, 100n)).toThrow("coverage");
    expect(() => validatedPrice(samples().filter((_, i) => i !== 50), now, 100n)).toThrow("gap");
  });
  it("rejects invalid and duplicate observations", () => {
    expect(() => validatedPrice([...samples(), samples()[0]!], now, 100n)).toThrow("duplicate");
    expect(() => validatedPrice([...samples(), { t: now + 1, priceUSDGPerSGAGE: "100" }], now, 100n)).toThrow("invalid");
    expect(() => validatedPrice([{ t: now, priceUSDGPerSGAGE: "0" }], now, 100n)).toThrow("invalid");
  });
  it("blocks upside divergence and explicitly identifies reduction-only downside mode", () => {
    expect(() => validatedPrice(samples(), now, 121n, true)).toThrow("divergence");
    expect(() => validatedPrice(samples(), now, 70n)).toThrow("divergence");
    expect(validatedPrice(samples(), now, 70n, true)).toMatchObject({ price: 100n, downsideDivergence: true });
  });
});

describe("reward value monitoring", () => {
  it("targets 60% of eligible fees and preserves a smaller term budget", () => {
    const p = proposeRates({
      budget7: 10n ** 30n, budget21: 10n ** 20n,
      fees7: 1_000_000n, fees21: 1_000_000n,
      usdgUnit: 1_000_000n, priceUSDGPerSGAGE: 100n,
      maxRewardShareBps: TARGET_BPS,
    });
    expect(rewardValueBps({ ...rates, rate7: p.rate7, rate21: p.rate21 }, 100n)).toBe(6000n);
    expect(p.rate21).toBe(10n ** 20n);
  });
  it("measures appreciation independently of remaining budget", () => {
    expect(rewardValueBps(rates, 100n)).toBe(5000n);
    expect(rewardValueBps(rates, 130n)).toBe(6500n);
    expect(rewardValueBps(rates, 140n)).toBe(7000n);
  });
  it("applies the contract cap and chooses the riskier term", () => {
    expect(rewardValueBps({ ...rates, rate21: 10n ** 25n }, 100n)).toBe(8000n);
    expect(rewardValueBps({ ...rates, rate7: 0n, rate21: 0n }, 100n)).toBe(0n);
  });
});
