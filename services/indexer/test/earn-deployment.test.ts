import { describe, expect, it } from "vitest";
import { parseDeployment } from "../src/lib/deployment";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const engine = { engine: address(20), registry: address(21), rewards: address(22), cashoutRouter: address(23), entryRouter: address(24), zapRouter: address(25), startBlock: 50, grace: 172800, name: "V2" };
const base = { chainId: 46630, DealVault: address(1), CollateralRegistry: address(2), FeeSink: address(3), EntryRouter: address(4), USDG: address(5), nativeV2: { adapter: address(19), engines: [engine] } };
describe("Earn deployment registration", () => {
  it("keeps Earn absent on existing releases", () => {
    expect(parseDeployment(JSON.stringify(base), "release.json").earn).toBeUndefined();
  });
  it("registers the strategy, the reserve, the V2 core and the deployment start block; the fee companion is read from the chain", () => {
    const parsed = parseDeployment(JSON.stringify({ ...base, HybridVault: address(10), HybridFees: address(11), HybridReserve: address(12), EarnCore: address(20), earnStartBlock: 100 }), "release.json");
    expect(parsed.earn).toEqual({ id: "gage-mix", title: "Gage USDG Mix", HybridVault: address(10), HybridReserve: address(12), core: address(20), startBlock: 100 });
    expect(parsed.earnStrategies).toEqual([parsed.earn]);
    expect(parseDeployment(JSON.stringify(base), "release.json").earnStrategies).toEqual([]);
  });
  it("registers every strategy of earnStrategies, the flagship first, mirrored by the flat keys", () => {
    const flat = { HybridVault: address(10), HybridFees: address(11), HybridReserve: address(12), EarnCore: address(20), earnStartBlock: 100 };
    const flagship = { id: "earn", title: "Gage USDG Mix", ...flat };
    const stocks = { id: "stocks", title: "Gage USDG Stocks", HybridVault: address(13), HybridFees: address(14), HybridReserve: address(12), EarnCore: address(20), earnStartBlock: 150 };
    const parsed = parseDeployment(JSON.stringify({ ...base, ...flat, earnStrategies: [flagship, stocks] }), "release.json");
    expect(parsed.earnStrategies.map(item => [item.id, item.title, item.HybridVault, item.startBlock])).toEqual([["earn", "Gage USDG Mix", address(10), 100], ["stocks", "Gage USDG Stocks", address(13), 150]]);
    expect(parsed.earn?.HybridVault).toBe(address(10));
    expect(parseDeployment(JSON.stringify({ ...base, deployer: address(7), earnStrategies: [{ ...flagship, earnMandate: { curator: address(7) } }, { ...stocks, earnMandate: { curator: address(7) } }] }), "release.json").earnStrategies).toHaveLength(2);
    expect(parseDeployment(JSON.stringify({ ...base, earnStrategies: [flagship, stocks] }), "release.json").earnStrategies).toHaveLength(2);
    for (const invalid of [
      { ...flat, earnStrategies: [{ ...flagship, HybridVault: address(13) }] },
      { ...flat, earnStrategies: [] },
      { earnStrategies: [flagship, { ...stocks, id: "earn" }] },
      { earnStrategies: [flagship, { ...stocks, HybridVault: address(10) }] },
      { earnStrategies: [flagship, { ...stocks, HybridReserve: address(15) }] },
      { earnStrategies: [flagship, { ...stocks, id: "Stocks" }] },
      { earnStrategies: [flagship, { ...stocks, title: "" }] },
      { earnStrategies: [flagship, { ...stocks, EarnCore: address(99) }] },
      { deployer: address(7), earnStrategies: [flagship, { ...stocks, earnMandate: { curator: address(8) } }] },
    ]) expect(() => parseDeployment(JSON.stringify({ ...base, ...invalid }), "release.json")).toThrow(/Earn/);
  });
  it("rejects incomplete identities instead of silently serving another contract", () => {
    const complete = { HybridVault: address(10), HybridReserve: address(12), EarnCore: address(20) };
    for (const invalid of [{ HybridVault: address(10) }, { ...complete, HybridReserve: address(0) }, { ...complete, earnStartBlock: -1 }, { ...complete, EarnCore: address(99) }]) {
      expect(() => parseDeployment(JSON.stringify({ ...base, ...invalid }), "release.json")).toThrow(/Earn/);
    }
  });
});
