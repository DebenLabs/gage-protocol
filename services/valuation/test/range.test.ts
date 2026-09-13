import { describe, expect, it } from "vitest";
import { SampleStore } from "../src/facts/store.js";
import { LN_TICK, getSqrtPriceAtTick } from "../src/math/tickMath.js";
import { Pricer } from "../src/pricing/pricer.js";
import { DEFAULT_HALF_WIDTH_LOG, RANGE_NOTE, feeEstimateBps, snapRange, suggestRange } from "../src/range/suggest.js";
import { FakeIndexer, FakeReader, POOL_ID, fixtureDeployment, sqrtPriceOf } from "./helpers/fake.js";

describe("snapRange", () => {
  it("centres on the current tick, snaps outwards to the spacing and is at least one spacing each side", () => {
    const r = snapRange({ currentTick: 1234, tickSpacing: 60, halfWidthLog: Math.log(1.1) });
    const halfTicks = Math.log(1.1) / LN_TICK; // ≈ 953
    expect(r.tickLower % 60).toBe(0);
    expect(r.tickUpper % 60).toBe(0);
    expect(r.tickLower).toBeLessThanOrEqual(1234 - halfTicks);
    expect(r.tickUpper).toBeGreaterThanOrEqual(1234 + halfTicks);
    expect(r.tickLower).toBeGreaterThan(1234 - halfTicks - 60);
    expect(r.tickUpper).toBeLessThan(1234 + halfTicks + 60);
    // width ≈ (1.1 − 1/1.1) ≈ 19.1% before snapping
    expect(r.widthBps).toBeGreaterThan(1900);
    expect(r.widthBps).toBeLessThan(2100);
    const tiny = snapRange({ currentTick: 0, tickSpacing: 60, halfWidthLog: 0 });
    expect(tiny).toMatchObject({ tickLower: -60, tickUpper: 60 });
  });

  it("clamps to the usable tick bounds", () => {
    const r = snapRange({ currentTick: 887_000, tickSpacing: 60, halfWidthLog: Math.log(100) });
    expect(r.tickUpper).toBe(887_220);
    expect(r.tickUpper % 60).toBe(0);
  });
});

describe("feeEstimateBps", () => {
  const state = { sqrtPriceX96: getSqrtPriceAtTick(0), liquidity: 10n ** 24n, lpFee: 30_000 };

  it("is proportional to volume and to the term, and falls with a larger position share", () => {
    const base = { state, tickLower: -6000, tickUpper: 6000, volume7dCurrency1: 10n ** 24n, termSeconds: 7 * 86_400, positionValueCurrency1: null };
    const a = feeEstimateBps(base);
    const b = feeEstimateBps({ ...base, volume7dCurrency1: 2n * 10n ** 24n });
    const c = feeEstimateBps({ ...base, termSeconds: 21 * 86_400 });
    expect(a.feeEstimateBps).toBeGreaterThan(0);
    expect(b.feeEstimateBps).toBeGreaterThanOrEqual(2 * a.feeEstimateBps - 1);
    expect(c.feeEstimateBps).toBeGreaterThanOrEqual(3 * a.feeEstimateBps - 1);
    expect(a.inRangeShare).toBe(0);
    // a sized position takes a share of the in-range liquidity and so earns less per unit than the marginal case
    const big = feeEstimateBps({ ...base, positionValueCurrency1: 2n * 10n ** 24n });
    expect(big.inRangeShare).toBeGreaterThan(0);
    expect(big.inRangeShare).toBeLessThan(1);
    expect(big.feeEstimateBps).toBeLessThan(a.feeEstimateBps);
    const bigger = feeEstimateBps({ ...base, positionValueCurrency1: 4n * 10n ** 24n });
    expect(bigger.inRangeShare).toBeGreaterThan(big.inRangeShare);
  });

  it("returns zero without in-range liquidity", () => {
    const r = feeEstimateBps({ state: { ...state, liquidity: 0n }, tickLower: -60, tickUpper: 60, volume7dCurrency1: 10n ** 18n, termSeconds: 86_400, positionValueCurrency1: null });
    expect(r.feeEstimateBps).toBe(0);
  });
});

describe("suggestRange", () => {
  function setup(): { reader: FakeReader; pricer: Pricer; indexer: FakeIndexer; store: SampleStore } {
    const reader = new FakeReader();
    return { reader, pricer: new Pricer(reader, fixtureDeployment()), indexer: new FakeIndexer(), store: SampleStore.inMemory() };
  }

  it("describes the log-symmetric fallback accurately when there is no history", async () => {
    const { pricer, indexer, store } = setup();
    const pool = pricer.deployment.pools.gageSgage!;
    const state = await pricer.poolState(pool);
    const r = await suggestRange({ indexer, store, sigmaMultiplier: 1.5 }, pool, state, 7 * 86_400, null);
    expect(r.recommended.note).toBe(RANGE_NOTE);
    expect(r.recommended.label).toBe("Recommended");
    expect(r.basis.volSource).toBe("default");
    expect(r.basis.note).toContain("indexer unreachable");
    expect(r.basis.note).toContain("-33% to +50%");
    expect(r.feeEstimateBps).toBeNull();
    expect(Math.abs(r.full.tickLower % 60)).toBe(0);
    expect(r.full.tickLower).toBeLessThan(-887_000);
    expect(r.full.tickUpper).toBeGreaterThan(887_000);
    // Symmetric in log space: upper ≈ 1.5×, lower ≈ 1/1.5.
    const up = Math.exp((r.recommended.tickUpper - state.tick) * LN_TICK);
    expect(up).toBeGreaterThan(1.49);
    expect(up).toBeLessThan(1.52);
    expect(Math.abs(DEFAULT_HALF_WIDTH_LOG - Math.log(1.5))).toBeLessThan(1e-12);
  });

  it("scales the width by realised volatility and the square root of the term", async () => {
    const { pricer, indexer, store } = setup();
    const pool = pricer.deployment.pools.gageSgage!;
    const state = await pricer.poolState(pool);
    // 30 days of hourly samples with a ±2% alternating log move: sigma per hour ≈ 2%
    const now = Math.floor(Date.now() / 1000);
    const swaps = [];
    for (let i = 0; i < 24 * 30; i++) {
      const p = i % 2 === 0 ? 1.02 : 1 / 1.02;
      swaps.push({ at: now - (24 * 30 - i) * 3600, sqrtPriceX96: sqrtPriceOf(BigInt(Math.round(p * 1e12)), 10n ** 12n), amount0: 10n ** 18n, amount1: -(10n ** 18n) });
    }
    indexer.poolResult = { value: { poolId: POOL_ID.gageSgage, sqrtPriceX96: state.sqrtPriceX96, liquidity: state.liquidity, swaps }, reason: null };
    const r7 = await suggestRange({ indexer, store, sigmaMultiplier: 1.5 }, pool, state, 7 * 86_400, null);
    const r21 = await suggestRange({ indexer, store, sigmaMultiplier: 1.5 }, pool, state, 21 * 86_400, null);
    expect(r7.basis.volSource).toBe("indexer");
    expect(r7.basis.realisedVol30d).toBeGreaterThan(1);
    expect(r7.basis.sigmaTerm).not.toBeNull();
    // sqrt(3) wider for three times the term
    expect(r21.basis.sigmaTerm! / r7.basis.sigmaTerm!).toBeCloseTo(Math.sqrt(3), 6);
    expect(r21.recommended.widthBps).toBeGreaterThan(r7.recommended.widthBps);
    expect(r7.feeEstimateBps).not.toBeNull();
    expect(r7.basis.volume7d).not.toBeNull();
    expect(r7.basis.note).not.toMatch(/best/);
  });
});
