import { afterEach, describe, expect, it, vi } from "vitest";
import { poolIdOf } from "../src/deployment.js";
import { Pricer } from "../src/pricing/pricer.js";
import { valueDeal } from "../src/valuation/deal.js";
import { A, FakeReader, fixtureDeployment } from "./helpers/fake.js";

afterEach(() => vi.useRealTimers());

const delay = <T>(value: T): Promise<T> => new Promise(resolve => setTimeout(() => resolve(value), 100));

describe("valuation RPC scheduling", () => {
  it.each(["priceInUSDG", "bestRoute"] as const)("evaluates independent routes together in %s and still selects the deepest", async (method) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const reader = new FakeReader();
    const deployment = fixtureDeployment();
    const first = deployment.pools.nvdaUsdg!;
    const second = { ...first, name: "deepNvdaUsdg", fee: 500 };
    second.poolId = poolIdOf(second);
    deployment.pools.deepNvdaUsdg = second;
    reader.pools.set(second.poolId, { ...reader.pools.get(first.poolId)!, liquidity: 10n ** 25n });
    const original = reader.slot0.bind(reader);
    vi.spyOn(reader, "slot0").mockImplementation(async (pool) => delay(await original(pool)));
    const pricer = new Pricer(reader, deployment);
    let finishedAt = -1;
    const request = pricer[method](A.NVDAx).then(result => { finishedAt = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await request;
    expect(finishedAt).toBe(100);
    expect(Array.isArray(result) ? result.map(pool => pool.name) : result.pools).toEqual(["deepNvdaUsdg"]);
  });

  it("overlaps independent position reads within three RPC rounds for a cold deal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const reader = new FakeReader();
    const deployment = fixtureDeployment();
    const pool = deployment.pools.nvdogNvda!;
    reader.addPositionDeal(1n, 7n, 1_000_000n, pool, 60_000, 80_000, 10n ** 18n);
    reader.configs.set(A.NVDOG, { allowed: true, lane: "MEME", minAmount: 1n, maxDealRaw: 1n, maxOpenRaw: 1n });
    const methods = ["getDeal", "position", "tokenMeta", "getERC20Config", "slot0", "liquidity", "blockNumber", "feeGrowthInside", "positionFeeState"] as const;
    for (const method of methods) {
      // All reads incur the same simulated network delay, including cold token metadata.
      const original = reader[method].bind(reader) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(reader, method).mockImplementation((...args: unknown[]) => original(...args).then(delay) as never);
    }
    let finishedAt = -1;
    const request = valueDeal({ reader, pricer: new Pricer(reader, deployment) }, 1n)
      .then(result => { finishedAt = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(1000);
    const valuation = await request;
    expect(valuation.asset.symbol).toBe("NVDOG");
    expect(BigInt(valuation.valueUSDG)).toBeGreaterThan(0n);
    expect(finishedAt).toBeLessThanOrEqual(300);
  });
});
