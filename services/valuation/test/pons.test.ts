import { describe, expect, it } from "vitest";
import { Pricer } from "../src/pricing/pricer.js";
import { payForGage, resolveReinvestPools } from "../src/quote/reinvest.js";
import { swapAlongRoute } from "../src/quote/route.js";
import { A, FakeReader, POOL_ID, fixtureDeployment } from "./helpers/fake.js";

function fixture() {
  const reader = new FakeReader();
  const d = fixtureDeployment();
  d.pons = { curve: A.alice, factory: A.bob, hookFeePips: 10_000 };
  reader.curveState = { graduated: false, quoteReserve: 178n * 10n ** 16n, tokenReserve: 940_000_000n * 10n ** 18n, realQuoteReserve: 10n ** 17n, sellableTokens: 650_000_000n * 10n ** 18n, feeBps: 100, block: 123n };
  const pricer = new Pricer(reader, d);
  return { reader, d, pricer, ctx: { pricer, pools: resolveReinvestPools(d) } };
}

describe("Pons phase-aware valuation", () => {
  it("quotes and values through the curve while the future v4 pool is absent, excluding phantom depth", async () => {
    const { reader, pricer, d, ctx } = fixture();
    reader.pools.delete(POOL_ID.gageEth);
    const state = await pricer.poolState(d.pools.gageEth!);
    expect(Pricer.virtualReserves(state).amount0).toBe(10n ** 17n);
    expect(state.liquidity).toBe(0n);
    const value = await pricer.priceInUSDG(A.sGAGE);
    expect(value.kind).toBe("three-hop");
    expect(value.price.num).toBeGreaterThan(0n);
    const out = 1_000n * 10n ** 18n;
    const quote = await payForGage(ctx, out, "ETH");
    // Check the quoted gross input actually buys at least the desired amount under curve invariant + fees.
    const gross = quote.payAmount;
    const net = gross - gross * 100n / 10_000n;
    const c = reader.curveState!;
    expect(c.tokenReserve * net / (c.quoteReserve + net)).toBeGreaterThanOrEqual(out);
    await expect(payForGage(ctx, c.sellableTokens + 1n, "ETH")).rejects.toMatchObject({ code: "NO_LIQUIDITY" });
    await expect(swapAlongRoute(pricer, A.GAGE, [d.pools.gageEth!], out)).rejects.toMatchObject({ code: "NO_ROUTE" });
  });

  it("refuses the swept interval then uses actual v4 liquidity and hook fee", async () => {
    const { reader, pricer, d, ctx } = fixture();
    reader.curveState!.graduated = true;
    const pool = reader.pools.get(POOL_ID.gageEth)!;
    reader.pools.delete(POOL_ID.gageEth);
    await expect(pricer.poolState(d.pools.gageEth!)).rejects.toMatchObject({ code: "NO_POOL" });
    reader.pools.set(POOL_ID.gageEth, pool);
    const state = await pricer.poolState(d.pools.gageEth!);
    expect(state.curve).toBeUndefined();
    expect(state.hookFeePips).toBe(10_000);
    const withFee = await payForGage(ctx, 10n ** 18n, "ETH");
    delete d.pons;
    const withoutFee = await payForGage(ctx, 10n ** 18n, "ETH");
    expect(withFee.payAmount).toBeGreaterThan(withoutFee.payAmount * 103n / 100n);
  });
});
