import { describe, expect, it } from "vitest";

import type { PoolDef } from "../src/lib/deployment";
import { decodePositionInfo, formatWalletPosition, isEmptyPositionInfo, poolIdOf, poolNameOf } from "../src/lib/position";

// contracts/deployments/46630.json, pools.nvdaUsdg
const NVDA_USDG = {
  currency0: "0x2167e6d67347e0df1292f26926610b15be6f7780",
  currency1: "0x512d23c1acc455973d51a228e8c4fc16f80de2b8",
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000",
} as const;
const NVDA_USDG_POOL_ID = "0x1e2c7ff813b2cb379fb2b870e57b6273b5cbc0d563f5249351ab331f9142cf16";

// PositionManager.getPoolAndPositionInfo(3) on the testnet: full range, no subscriber.
const INFO_3 = 13648009938275541468743810101008642002920335409946185741944603351359530880000n;

describe("poolIdOf", () => {
  it("is keccak256(abi.encode(poolKey)), matching the deployment json", () => {
    expect(poolIdOf(NVDA_USDG)).toBe(NVDA_USDG_POOL_ID);
  });
  it("changes with any field of the key", () => {
    expect(poolIdOf({ ...NVDA_USDG, fee: 500 })).not.toBe(NVDA_USDG_POOL_ID);
    expect(poolIdOf({ ...NVDA_USDG, tickSpacing: 10 })).not.toBe(NVDA_USDG_POOL_ID);
  });
});

describe("decodePositionInfo", () => {
  it("unpacks the ticks and the subscriber flag from the live word", () => {
    expect(decodePositionInfo(INFO_3)).toEqual({ tickLower: -887220, tickUpper: 887220, hasSubscriber: false });
    // The top 200 bits are the truncated pool id.
    expect(`0x${INFO_3.toString(16).slice(0, 50)}`).toBe(NVDA_USDG_POOL_ID.slice(0, 52));
  });
  it("sign-extends negative ticks and reads the subscriber bit", () => {
    const pack = (lower: number, upper: number, sub: boolean): bigint =>
      ((BigInt(upper) & 0xffffffn) << 32n) | ((BigInt(lower) & 0xffffffn) << 8n) | (sub ? 1n : 0n);
    expect(decodePositionInfo(pack(-60, 120, true))).toEqual({ tickLower: -60, tickUpper: 120, hasSubscriber: true });
    expect(decodePositionInfo(pack(-887272, -887212, false))).toEqual({ tickLower: -887272, tickUpper: -887212, hasSubscriber: false });
    expect(decodePositionInfo(pack(0, 0, false))).toEqual({ tickLower: 0, tickUpper: 0, hasSubscriber: false });
  });
  it("treats the zero word as empty (burned or unknown)", () => {
    expect(isEmptyPositionInfo(0n)).toBe(true);
    expect(isEmptyPositionInfo(INFO_3)).toBe(false);
  });
});

describe("formatWalletPosition", () => {
  const pools: PoolDef[] = [{ name: "nvdaUsdg", ...NVDA_USDG, poolId: NVDA_USDG_POOL_ID }];
  const row = { tokenId: 3n, poolId: NVDA_USDG_POOL_ID, ...NVDA_USDG, tickLower: -887220, tickUpper: 887220 } as const;
  it("names the pool from the deployment json and serialises bigints as strings", () => {
    expect(formatWalletPosition(row, 100_000_000_000_000n, true, poolNameOf(pools, row.poolId))).toEqual({
      tokenId: "3",
      poolId: NVDA_USDG_POOL_ID,
      poolName: "nvdaUsdg",
      currency0: NVDA_USDG.currency0,
      currency1: NVDA_USDG.currency1,
      fee: 3000,
      tickSpacing: 60,
      hooks: NVDA_USDG.hooks,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: "100000000000000",
      allowed: true,
      lane: "POSITION",
    });
  });
  it("leaves the name null for a pool the json does not list", () => {
    expect(poolNameOf(pools, `0x${"ab".repeat(32)}`)).toBeNull();
  });
});
