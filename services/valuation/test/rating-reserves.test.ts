import { describe, expect, it, vi } from "vitest";
import { reserveLookup, valueReportedAmount } from "../src/ratings/reserves.js";
import { assessMarket, conservativeDepth } from "../src/ratings/model.js";
import { A, fixtureDeployment } from "./helpers/fake.js";

const pool = fixtureDeployment().pools.nvdaUsdg!;
const pair = { chainId: "robinhood", pairAddress: pool.poolId, baseToken: { address: A.NVDAx }, quoteToken: { address: A.USDG },
  liquidity: { base: 12.5, quote: 1200, usd: 999_999_999 }, pairCreatedAt: 1_700_000_000_000 };
describe("reported pool reserves", () => {
  it("matches exact pool and both currencies, orients quantities, and ignores USD values", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ pairs: [pair] }));
    const lookup = reserveLookup(fetcher);
    const [a, b] = await Promise.all([lookup(4663, pool), lookup(4663, pool)]);
    expect(a).toMatchObject({ amount0: 1200, amount1: 12.5, createdAt: 1_700_000_000 });
    expect(b).toEqual(a); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await lookup(1, pool)).toBeNull();
    for (const wrong of [{ ...pair, chainId: "ethereum" }, { ...pair, pairAddress: `0x${"f".repeat(64)}` },
      { ...pair, baseToken: { address: A.NVDOG } }, { ...pair, liquidity: { base: -1, quote: 2 } }]) {
      expect(await reserveLookup(async () => Response.json({ pairs: [wrong] }))(4663, pool)).toBeNull();
    }
  });
  it("values token quantities in raw USDG with local prices and only tightens liquidity", () => {
    expect(valueReportedAmount(12.5, 18, { num: 100_000_000n, den: 10n ** 18n })).toBe(1_250_000_000n);
    expect(valueReportedAmount(1200, 6, { num: 1n, den: 1n })).toBe(1_200_000_000n);
    expect(conservativeDepth("102000000000", "44000000000")).toBe("44000000000");
    expect(conservativeDepth("102000000000", "500000000000")).toBe("102000000000");
    expect(conservativeDepth(null, "500000000000")).toBeNull();
    expect(conservativeDepth("102000000000", null, true)).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const e = { profile: "pool" as const, price: "1", depth: "102000000000", reportedDepth: "44000000000", mcap: null,
      ageDays: null, volatility: null, topTen: null, at: now, decimals: 6 };
    expect(assessMarket(e, now).grade).toBe("CC");
    expect(assessMarket({ ...e, reportedDepth: "0" }, now).grade).toBe("C");
    expect(assessMarket({ ...e, requireReportedDepth: true, reportedDepth: null }, now).grade).toBe("NR");
  });
  it("bounds failures and refreshes optional reports", async () => {
    let now = 1_800_000_000_000;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(Response.json({ pairs: [pair] }));
    const lookup = reserveLookup(fetcher, () => now);
    expect(await lookup(4663, pool)).toBeNull();
    expect(await lookup(4663, pool)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 30_001;
    expect(await lookup(4663, pool)).not.toBeNull();
  });
});
