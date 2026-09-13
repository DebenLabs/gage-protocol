import { describe, expect, it, vi } from "vitest";
import { stockLookup } from "../src/ratings/stocks.js";

const token = `0x${"a".repeat(40)}`;
const body = { assets: [{ tokenSymbol: "AAPL", status: "ASSET_STATUS_ACTIVE", deployments: [{ chainId: 4663, contractAddress: token }] }] };

describe("stock rating identity", () => {
  it("requires an exact chain/address match, shares concurrent reads, and refreshes after five minutes", async () => {
    let now = 1_800_000_000_000;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
    const lookup = stockLookup(fetcher, () => now);
    const [first, second] = await Promise.all([lookup(4663, token), lookup(4663, token.toUpperCase())]);
    expect(first).toEqual({ kind: "stock", symbol: "AAPL", active: true, checkedAt: now / 1000 });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await lookup(46630, token)).toEqual({ kind: "other" });
    expect(await lookup(4663, `0x${"b".repeat(40)}`)).toEqual({ kind: "other" });
    now += 300_001;
    await lookup(4663, token);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not reuse stale identity after failure or upgrade malformed, inactive or wrong-chain assets", async () => {
    let now = 1_800_000_000_000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(body))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ assets: [{ ...body.assets[0], status: "ASSET_STATUS_INACTIVE" }] }));
    const lookup = stockLookup(fetcher, () => now);
    expect((await lookup(4663, token)).kind).toBe("stock");
    now += 300_001;
    expect(await lookup(4663, token)).toEqual({ kind: "unavailable" });
    expect(await lookup(4663, token)).toEqual({ kind: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 15_001;
    expect(await lookup(4663, token)).toMatchObject({ kind: "stock", active: false });
    for (const malformed of [{}, { assets: [] }, { assets: [{ ...body.assets[0], deployments: [{ chainId: 1, contractAddress: token }] }] }]) {
      expect(await stockLookup(async () => Response.json(malformed))(4663, token)).toEqual({ kind: "unavailable" });
    }
  });
});
