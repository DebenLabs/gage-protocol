import { describe, expect, it } from "vitest";

import { zeroAddress, type Address, type Hex } from "viem";

import { WAD } from "../src/lib/pool";
import {
  PriceGraph,
  WEEK,
  changeBps,
  dealPhase,
  lastWeeks,
  median,
  ratioBps,
  rawPrice1Per0Wad,
  replayPrices,
  scaleDecimals,
  sharesBps,
  weekStart,
} from "../src/lib/stats";

const MON_7_SEP_2026 = BigInt(Date.UTC(2026, 8, 7) / 1000);

describe("weeks (Monday 00:00 UTC)", () => {
  it("starts the week on Monday", () => {
    expect(weekStart(MON_7_SEP_2026)).toBe(MON_7_SEP_2026);
    expect(weekStart(MON_7_SEP_2026 + 3n * 86_400n + 5n)).toBe(MON_7_SEP_2026);
    expect(weekStart(MON_7_SEP_2026 - 1n)).toBe(MON_7_SEP_2026 - WEEK);
  });
  it("lists the last n weeks ascending, ending with the current one", () => {
    expect(lastWeeks(MON_7_SEP_2026 + 10n, 3)).toEqual([MON_7_SEP_2026 - 2n * WEEK, MON_7_SEP_2026 - WEEK, MON_7_SEP_2026]);
  });
});

describe("median and ratios", () => {
  it("takes the middle value, the floored mean of two middles, null when empty", () => {
    expect(median([])).toBeNull();
    expect(median([5n])).toBe(5n);
    expect(median([9n, 1n, 5n])).toBe(5n);
    expect(median([1n, 2n, 3n, 6n])).toBe(2n);
  });
  it("computes bps and changes, null without a base", () => {
    expect(ratioBps(1n, 4n)).toBe(2_500);
    expect(ratioBps(1n, 0n)).toBeNull();
    expect(changeBps(1_068n, 1_000n)).toBe(680);
    expect(changeBps(900n, 1_000n)).toBe(-1_000);
    expect(changeBps(1n, 0n)).toBeNull();
  });
});

describe("dealPhase", () => {
  const base = { listingExpiry: 200n, expiry: 300n, graceEnd: 400n };
  it("follows the Dashboard's four live buckets", () => {
    expect(dealPhase({ ...base, state: "LISTED" }, 100n)).toBe("LISTED");
    expect(dealPhase({ ...base, state: "LISTED" }, 200n)).toBeNull();
    expect(dealPhase({ ...base, state: "FUNDED" }, 299n)).toBe("FUNDED");
    expect(dealPhase({ ...base, state: "FUNDED" }, 300n)).toBe("RECLAIMABLE");
    expect(dealPhase({ ...base, state: "FUNDED" }, 400n)).toBe("CLAIMABLE");
    expect(dealPhase({ ...base, state: "RECLAIMED" }, 100n)).toBeNull();
  });
});

describe("PriceGraph", () => {
  const usdg: Address = "0x000000000000000000000000000000000000000a";
  const nvda: Address = "0x000000000000000000000000000000000000000b";
  const meme: Address = "0x000000000000000000000000000000000000000c";
  const q96 = 1n << 96n;
  // sqrtP = 2 * 2^96 means currency1 per currency0 = 4.
  const four = 2n * q96;
  const pools = [
    { currency0: nvda, currency1: usdg, sqrtPriceX96: four },
    { currency0: meme, currency1: nvda, sqrtPriceX96: four },
  ];
  it("prices a raw unit at the pool", () => {
    expect(rawPrice1Per0Wad(q96)).toBe(WAD);
    expect(rawPrice1Per0Wad(four)).toBe(4n * WAD);
  });
  it("values directly, inversely and through two hops", () => {
    const g = new PriceGraph(pools);
    expect(g.value(10n, nvda, usdg)).toBe(40n);
    expect(g.value(40n, usdg, nvda)).toBe(10n);
    expect(g.value(1n, meme, usdg)).toBe(16n);
    expect(g.value(5n, usdg, usdg)).toBe(5n);
    expect(g.value(1n, "0x000000000000000000000000000000000000000d", usdg)).toBeNull();
  });
  it("ignores uninitialised pools", () => {
    expect(new PriceGraph([{ currency0: nvda, currency1: usdg, sqrtPriceX96: 0n }]).value(1n, nvda, usdg)).toBeNull();
  });
  it("prices configured WETH and native ETH identically without an extra pool hop", () => {
    const weth: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    const nativePools = [
      { currency0: zeroAddress, currency1: nvda, sqrtPriceX96: four },
      ...pools,
    ];
    const g = new PriceGraph(nativePools, weth);
    expect(g.value(10n, weth, usdg)).toBe(160n);
    expect(g.value(160n, usdg, weth)).toBe(10n);
    expect(g.value(10n, weth, zeroAddress)).toBe(10n);
    expect(g.value(10n, zeroAddress, weth)).toBe(10n);
    expect(new PriceGraph(nativePools).value(10n, weth, usdg)).toBeNull();
  });
  it("connects WETH pools to native ETH routes within the three-pool limit", () => {
    const weth: Address = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const g = new PriceGraph([
      { currency0: meme, currency1: nvda, sqrtPriceX96: four },
      { currency0: nvda, currency1: weth, sqrtPriceX96: four },
      { currency0: zeroAddress, currency1: usdg, sqrtPriceX96: four },
    ], weth);
    expect(g.value(1n, meme, usdg)).toBe(64n);
    expect(g.value(64n, usdg, meme)).toBe(1n);
    expect(g.priceWad(meme, usdg, 2)).toBeNull();
    expect(g.value(1n, "0x0000000000000000000000000000000000000099", usdg)).toBeNull();
    expect(new PriceGraph([], weth).value(1n, weth, usdg)).toBeNull();
  });
});

describe("PriceGraph.route and replayPrices", () => {
  const usdg: Address = "0x000000000000000000000000000000000000000a";
  const gage: Address = "0x000000000000000000000000000000000000000e";
  const q96 = 1n << 96n;
  const four = 2n * q96;
  const gageEth = { poolId: "0x01" as Hex, currency0: zeroAddress, currency1: gage, sqrtPriceX96: four };
  const usdgEth = { poolId: "0x02" as Hex, currency0: zeroAddress, currency1: usdg, sqrtPriceX96: four };
  const gageSgage = { poolId: "0x03" as Hex, currency0: gage, currency1: "0x000000000000000000000000000000000000000f" as Address, sqrtPriceX96: four };
  it("names the pools a price crosses, in order, and nothing for the same token", () => {
    const g = new PriceGraph([gageSgage, gageEth, usdgEth]);
    expect(g.route(gage, usdg)).toEqual([gageEth, usdgEth]);
    expect(g.route(usdg, gage)).toEqual([usdgEth, gageEth]);
    expect(g.route(gage, gage)).toEqual([]);
    expect(g.route(gage, "0x0000000000000000000000000000000000000099")).toBeNull();
  });
  it("replays swaps into the pools' state at each sample time", () => {
    // ETH per GAGE = 1/4 and USDG per ETH = 4, so USDG per GAGE starts at 1.
    const price = (pools: readonly typeof gageEth[]) => new PriceGraph(pools).priceWad(gage, usdg);
    const swaps = [
      { poolId: "0x01" as Hex, at: 150n, sqrtPriceX96: q96 }, // ETH per GAGE = 1
      { poolId: "0x02" as Hex, at: 250n, sqrtPriceX96: q96 }, // USDG per ETH = 1
      { poolId: "0x09" as Hex, at: 260n, sqrtPriceX96: 7n * q96 }, // a pool off the route is ignored
    ];
    expect(replayPrices([gageEth, usdgEth], swaps, [100n, 200n, 300n], price)).toEqual([
      { t: 100n, priceWad: WAD },
      { t: 200n, priceWad: 4n * WAD },
      { t: 300n, priceWad: WAD },
    ]);
  });
  it("applies a swap at the sample time itself and leaves out times without a price", () => {
    const price = (pools: readonly typeof gageEth[]) => new PriceGraph(pools).priceWad(gage, usdg);
    const swaps = [{ poolId: "0x01" as Hex, at: 200n, sqrtPriceX96: q96 }];
    expect(replayPrices([gageEth, usdgEth], swaps, [200n], price)).toEqual([{ t: 200n, priceWad: 4n * WAD }]);
    expect(replayPrices([gageEth], swaps, [100n, 200n], price)).toEqual([]);
  });
});

describe("display helpers", () => {
  it("scales a raw price for token decimals", () => {
    expect(scaleDecimals(WAD, 18, 6)).toBe(WAD * 10n ** 12n);
    expect(scaleDecimals(WAD, 6, 18)).toBe(WAD / 10n ** 12n);
    expect(scaleDecimals(WAD, 18, 18)).toBe(WAD);
  });
  it("shares sum to 10000 with the rounding on the largest", () => {
    const shares = sharesBps([
      ["a", 1n],
      ["b", 1n],
      ["c", 1n],
    ]);
    expect(shares.reduce((acc, [, s]) => acc + s, 0)).toBe(10_000);
    expect(shares[0]?.[1]).toBe(3_334);
    expect(sharesBps([["a", 0n]])).toEqual([["a", 0]]);
  });
});
