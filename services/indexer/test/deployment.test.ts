import { describe, expect, it } from "vitest";

import { parseDeployment } from "../src/lib/deployment";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const m1 = { chainId: 46630, DealVault: addr(1), CollateralRegistry: addr(2), FeeSink: addr(3), EntryRouter: addr(4), USDG: addr(5) };

describe("parseDeployment", () => {
  it("retains the configured WETH address for native-asset pricing", () => {
    const weth = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    expect(parseDeployment(JSON.stringify({ ...m1, WETH: weth }), "t.json").token.WETH).toBe(weth.toLowerCase());
  });
  it("retains a verified token launch block and rejects invalid metadata", () => {
    expect(parseDeployment(JSON.stringify({ ...m1, tokenLaunchBlock: 57081951 }), "t.json").tokenLaunchBlock).toBe(57081951);
    expect(() => parseDeployment(JSON.stringify({ ...m1, tokenLaunchBlock: -1 }), "t.json")).toThrow(/tokenLaunchBlock/);
  });
  it("accepts an M1-only file and leaves the token layer empty", () => {
    const d = parseDeployment(JSON.stringify({ ...m1, NVDAx: addr(6), deployer: addr(7) }), "t.json");
    expect(d.chainId).toBe(46630);
    expect(d.m1.DealVault).toBe(addr(1));
    expect(d.token).toEqual({});
    expect(d.pools).toEqual([]);
  });
  it("picks up token-layer keys and pools when present, lowercased", () => {
    const pool = { currency0: addr(0xa).toUpperCase().replace("0X", "0x"), currency1: addr(0xb), fee: 30_000, tickSpacing: 600, hooks: addr(0xc), poolId: `0x${"ab".repeat(32)}` };
    const d = parseDeployment(JSON.stringify({ ...m1, Drip: addr(8), sGAGE: addr(9), pools: { gageSgage: pool } }), "t.json");
    expect(d.token.Drip).toBe(addr(8));
    expect(d.token.sGAGE).toBe(addr(9));
    expect(d.pools).toHaveLength(1);
    expect(d.pools[0]?.name).toBe("gageSgage");
    expect(d.pools[0]?.currency0).toBe(addr(0xa));
  });
  it("treats LPStreamer as optional even where the rest of the token layer exists (D64)", () => {
    const streamer = "0x00000000000000000000000000000000000000AB";
    const without = parseDeployment(JSON.stringify({ ...m1, LPRewards: addr(8), Emissions: addr(9) }), "t.json");
    expect(without.token.LPRewards).toBe(addr(8));
    expect(without.token.LPStreamer).toBeUndefined();
    const withKey = parseDeployment(JSON.stringify({ ...m1, LPRewards: addr(8), LPStreamer: streamer }), "t.json");
    expect(withKey.token.LPStreamer).toBe(streamer.toLowerCase());
    expect(withKey.token.LPStreamerDrip).toBeUndefined();
    const streamerDrip = "0x00000000000000000000000000000000000000CD";
    const withDrip = parseDeployment(JSON.stringify({ ...m1, Drip: addr(7), LPStreamer: streamer, LPStreamerDrip: streamerDrip }), "t.json");
    expect(withDrip.token.Drip).toBe(addr(7));
    expect(withDrip.token.LPStreamerDrip).toBe(streamerDrip.toLowerCase());
  });
  it("rejects a file missing an M1 key or a malformed pool", () => {
    const noUsdg: Record<string, unknown> = { ...m1 };
    delete noUsdg.USDG;
    expect(() => parseDeployment(JSON.stringify(noUsdg), "t.json")).toThrow(/USDG/);
    expect(() => parseDeployment(JSON.stringify({ ...m1, pools: { gageSgage: { fee: 1 } } }), "t.json")).toThrow(/gageSgage/);
  });
});
