import { describe, expect, it } from "vitest";
import { findPool, hasV4, parseDeployment, poolIdOf, poolsWith } from "../src/deployment.js";
import { unpackPositionInfo } from "../src/chain/viemReader.js";
import { A, fixtureDeploymentJson } from "./helpers/fake.js";
import { parseNativeZapDeployments } from "../src/native-v2.js";

describe("deployment", () => {
  it("keeps native zap contexts separate from the legacy vault and rejects unknown pool keys", () => {
    const json=fixtureDeploymentJson(true), legacy=parseDeployment(json);
    const pools=Object.values(legacy.pools);
    const nativeV2={adapter:A.alice,zapQuoter:A.bob,v4Manager:legacy.positionManager,
      engines:[{engine:A.bob,registry:A.alice,zapRouter:A.bob}],routingPools:pools,pools:[pools[0]!]};
    const [native]=parseNativeZapDeployments({...json,nativeV2});
    expect(native?.dealVault).toBe(A.bob);
    expect(native?.registry).toBe(A.alice);
    expect(native?.nativeV2CollateralPools).toEqual(new Set([pools[0]!.poolId]));
    expect(parseDeployment(json).dealVault).toBe(A.vault);
    expect(parseNativeZapDeployments(json)).toEqual([]);
    expect(()=>parseNativeZapDeployments({...json,nativeV2:{...nativeV2,engines:[nativeV2.engines[0],nativeV2.engines[0]]}})).toThrow("Duplicate");
    expect(()=>parseNativeZapDeployments({...json,nativeV2:{...nativeV2,pools:[{...pools[0],poolId:`0x${"1".repeat(64)}`}]}})).toThrow("poolId");
  });
  it("parses the M1-only file and reports no v4", () => {
    const d = parseDeployment(fixtureDeploymentJson(false));
    expect(hasV4(d)).toBe(false);
    expect(d.pools).toEqual({});
    expect(d.tokens.NVDOG).toBe(A.NVDOG);
    expect(findPool(d, "usdgEth")).toBeNull();
  });

  it("parses pools, checks poolId against the key and finds pools by token", () => {
    const d = parseDeployment(fixtureDeploymentJson(true));
    expect(hasV4(d)).toBe(true);
    expect(Object.keys(d.pools).length).toBe(5);
    expect(poolsWith(d, A.NVDAx).map((p) => p.name).sort()).toEqual(["nvdaUsdg", "nvdogNvda"]);
    const bad = fixtureDeploymentJson(true) as { pools: Record<string, Record<string, unknown>> };
    bad.pools.usdgEth!.poolId = `0x${"1".repeat(64)}`;
    expect(() => parseDeployment(bad)).toThrow(/poolId/);
  });

  it("computes the v4 poolId as keccak of the abi-encoded key", () => {
    // Known vector: an all-zero key with fee 3000 and spacing 60
    const id = poolIdOf({ currency0: "0x0000000000000000000000000000000000000000", currency1: "0x0000000000000000000000000000000000000001", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" });
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolIdOf({ currency0: "0x0000000000000000000000000000000000000000", currency1: "0x0000000000000000000000000000000000000001", fee: 3000, tickSpacing: 61, hooks: "0x0000000000000000000000000000000000000000" })).not.toBe(id);
  });

  it("unpacks PositionInfo ticks with sign extension", () => {
    const pack = (lower: number, upper: number): bigint => ((BigInt(upper) & 0xffffffn) << 32n) | ((BigInt(lower) & 0xffffffn) << 8n);
    expect(unpackPositionInfo(pack(-887220, 887220))).toEqual({ tickLower: -887220, tickUpper: 887220, hasSubscriber: false });
    expect(unpackPositionInfo(pack(-60, 60) | 1n)).toEqual({ tickLower: -60, tickUpper: 60, hasSubscriber: true });
  });
});

describe("getDeal ABI shapes", () => {
  it("decodes both the 13-word (testnet 2026-09-07) and 14-word Deal structs", async () => {
    const { decodeFunctionResult, encodeAbiParameters } = await import("viem");
    const { dealVaultAbi, dealVaultLegacyAbi } = await import("../src/abi/index.js");
    const legacy = dealVaultLegacyAbi[0].outputs;
    const current = dealVaultAbi[0].outputs;
    const base = { borrower: A.alice, kind: 0, state: 1, term: 604_800, listingExpiry: 1_700_000_000, token: A.NVDAx, fundedAt: 0, expiry: 0, amountOrTokenId: 10n ** 18n, cap: 10n ** 6n, minPrice: 0n, lender: A.bob, price: 0n };
    const legacyData = encodeAbiParameters(legacy, [base]);
    expect((legacyData.length - 2) / 64).toBe(13);
    const d13 = decodeFunctionResult({ abi: dealVaultLegacyAbi, functionName: "getDeal", data: legacyData });
    expect(d13.cap).toBe(10n ** 6n);
    const currentData = encodeAbiParameters(current, [{ ...base, fee: 42n }]);
    expect((currentData.length - 2) / 64).toBe(14);
    const d14 = decodeFunctionResult({ abi: dealVaultAbi, functionName: "getDeal", data: currentData });
    expect(d14.fee).toBe(42n);
  });
});
