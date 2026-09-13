import { describe, expect, it } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { parseDeployment } from "../src/lib/deployment";
import fixture from "./fixtures/tvl-4663-57363095.json";
import { calculateTvl, liquidityPositionId, poolPrincipal, type TvlPool, type TvlPosition } from "../src/lib/tvl";
import { Q96, depthInGage } from "../src/lib/pool";
import { PriceGraph } from "../src/lib/stats";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const pool: TvlPool = { ...fixture.pool, poolId: fixture.pool.poolId as Hex, currency0: fixture.pool.currency0 as Address, currency1: fixture.pool.currency1 as Address, sqrtPriceX96: BigInt(fixture.pool.sqrtPriceX96) };
const pools = fixture.pricingPools.map(p => ({ ...p, poolId: p.poolId as Hex, currency0: p.currency0 as Address, currency1: p.currency1 as Address, sqrtPriceX96: BigInt(p.sqrtPriceX96) }));
const positions: TvlPosition[] = fixture.positions.map(p => ({ ...p, poolId: p.poolId as Hex, liquidity: BigInt(p.liquidity) }));

describe("TVL principal regression: Robinhood block 57363095", () => {
  it("matches all six on-chain balances, including the inactive floor", () => {
    expect(poolPrincipal(pool, positions)).toEqual({ amount0: BigInt(fixture.expectedGage), amount1: BigInt(fixture.expectedSgage) });
    fixture.positions.forEach((p, i) => expect(poolPrincipal(pool, [positions[i]!])).toEqual({ amount0: BigInt(p.amount0), amount1: BigInt(p.amount1) }));
    const result = calculateTvl([], [], pools, usdg, 1n, positions, [], new Map(), address(1), pool.poolId);
    // Aggregating token amounts before USDG conversion saves up to one micro-USDG per side/position.
    expect(result.pool - BigInt(fixture.expectedPrincipalUSDG)).toBeGreaterThanOrEqual(0n);
    expect(result.pool - BigInt(fixture.expectedPrincipalUSDG)).toBeLessThan(12n);
    const old = new PriceGraph(pools).value(depthInGage(pool.sqrtPriceX96, BigInt(fixture.pool.liquidity), false), pool.currency0, usdg);
    expect(old).toBe(BigInt(fixture.oldVirtualDepthUSDG));
    expect(result.pool).toBeLessThan(old!);
    expect(result.unpriced).toBe(0);
  });
  it("counts only its own pool, ignores removed liquidity, and rejects negative balances", () => {
    const extra = { poolId: id(5), tickLower: -60, tickUpper: 60, liquidity: 10n ** 30n };
    expect(poolPrincipal(pool, [...positions, extra, { ...extra, poolId: pool.poolId, liquidity: 0n }])).toEqual(poolPrincipal(pool, positions));
    expect(() => poolPrincipal(pool, [{ ...extra, poolId: pool.poolId, liquidity: -1n }])).toThrow();
  });
  it("includes liquidity on either side of the active range", () => {
    const p = { ...pool, sqrtPriceX96: Q96 };
    expect(poolPrincipal(p, [{ poolId: p.poolId, tickLower: 60, tickUpper: 120, liquidity: 10n ** 18n }]).amount0).toBeGreaterThan(0n);
    expect(poolPrincipal(p, [{ poolId: p.poolId, tickLower: -120, tickUpper: -60, liquidity: 10n ** 18n }]).amount1).toBeGreaterThan(0n);
  });
  it("keeps direct v4 owners and ranges distinct even with the same salt", () => {
    const keys = [liquidityPositionId(id(1), address(1), 0, 60, id(0)), liquidityPositionId(id(1), address(2), 0, 60, id(0)), liquidityPositionId(id(1), address(1), 60, 120, id(0))];
    expect(new Set(keys).size).toBe(3);
  });
});

describe("escrow and valuation completeness", () => {
  const deal = { id: 1n, kind: "ERC20", token: usdg, amountOrTokenId: 100n, listedAt: 1n, settledAt: null, state: "FUNDED", price: 80n, cap: 10n ** 30n };
  const bid = { price: 20n, placedAt: 1n, closedAt: null as bigint | null };
  const credit = { account: address(2), kind: "USDG", asset: usdg, amount: 30n };
  const calc = (ds = [deal], bs = [bid], cs = [credit], nfts = new Map<string, bigint | null>()) => calculateTvl(ds, bs, [], usdg, 10n, [], cs, nfts, address(1));
  it("includes deal 38's WETH collateral and withdrawable WETH using the deployment's native price", () => {
    const deployment = parseDeployment(readFileSync(new URL("../../../launch/live/4663.json", import.meta.url), "utf8"), "4663.json");
    const weth = deployment.token.WETH!;
    const nativePools = pools.filter(p => p.currency0 === zeroAddress || p.currency1 === zeroAddress);
    const amount = 57_700_000_000_000_000n;
    const expected = new PriceGraph(nativePools).value(amount, zeroAddress, usdg);
    expect(expected).not.toBeNull();
    expect(expected!).toBeGreaterThan(0n);
    const ds = [{ ...deal, id: 38n, token: weth, amountOrTokenId: amount }];
    const cs = [{ ...credit, kind: "ERC20", asset: weth, amount }];
    const before = calculateTvl(ds, [], nativePools, usdg, 10n, [], cs, new Map(), address(1));
    expect(before.unpriced).toBe(2);
    const after = calculateTvl(ds, [], nativePools, usdg, 10n, [], cs, new Map(), address(1), undefined, weth);
    expect(after.collateral).toBe(expected);
    expect(after.withdrawable).toBe(expected);
    expect(after.priced.get(38n)).toBe(expected);
    expect(after.byToken.get(weth)).toBe(expected);
    expect(after.outstandingLoans).toBe(80n);
    expect(after.unpriced).toBe(0);
  });
  it("counts escrow, open bids and withdrawable credits once, excluding fee-sink funds", () => {
    const r = calc([deal], [bid, { ...bid, closedAt: 2n }], [credit, { ...credit, account: address(1), amount: 999n }]);
    expect([r.collateral, r.bids, r.withdrawable]).toEqual([100n, 20n, 30n]);
    expect(r.unpriced).toBe(0);
    expect(r.outstandingLoans).toBe(80n);
  });
  it("never substitutes a repayment cap for an unknown asset price", () => {
    const r = calc([{ ...deal, token: address(99) }]);
    expect(r.collateral).toBe(0n);
    expect(r.unpriced).toBe(1);
    expect(r.priced.has(1n)).toBe(false);
  });
  it("uses underlying NFT principal and flags missing NFT values", () => {
    const d = { ...deal, kind: "UNIV4_POSITION", token: address(3) };
    expect(calc([d]).unpriced).toBe(1);
    expect(calc([d], [], [], new Map([[`${d.token}:${d.amountOrTokenId}`, 123n]])).collateral).toBe(123n);
  });
  it("counts current funded principal, excluding listings and closed deals regardless of their caps", () => {
    const r = calculateTvl([
      deal,
      { ...deal, id: 2n, state: "LISTED", price: null },
      { ...deal, id: 3n, state: "RECLAIMED", settledAt: 9n, price: 900n },
      { ...deal, id: 4n, state: "CLAIMED", settledAt: 9n, price: 800n },
      { ...deal, id: 5n, state: "FUNDED", price: 40n },
    ], [], [], usdg, 10n, [], [], new Map(), address(1));
    expect(r.outstandingLoans).toBe(120n);
  });
  it("does not count settled or not-yet-listed deals", () => {
    const r = calculateTvl([{ ...deal, settledAt: 9n }, { ...deal, id: 2n, listedAt: 11n }], [], [], usdg, 10n, [], [], new Map(), address(1));
    expect(r.collateral).toBe(0n);
  });
});
