import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { toFunctionSelector } from "viem";
import { runChecks, selectorsInBytecode, hasDelegateCall, type CheckInputs } from "../src/facts/checks.js";
import { assembleFacts, buildRules, capsFromDepth, formatUSDG, type FactsDeps } from "../src/facts/facts.js";
import { assessLock } from "../src/facts/lock.js";
import { SampleStore, mcapMedian7d } from "../src/facts/store.js";
import { medianBig } from "../src/math/stats.js";
import { Pricer } from "../src/pricing/pricer.js";
import { A, FakeExplorer, FakeIndexer, FakeReader, POOL_ID, fixtureDeployment } from "./helpers/fake.js";

/** Runtime bytecode that "exposes" the given signatures: PUSH4 <selector> for each, padded with STOP. */
function codeWith(...sigs: string[]): Hex {
  return `0x${sigs.map((s) => `63${toFunctionSelector(s).slice(2)}`).join("00")}00` as Hex;
}

const cleanInputs: CheckInputs = {
  bytecode: codeWith("transfer(address,uint256)", "balanceOf(address)"),
  pausedCall: null,
  probe: { ok: true, sentDelta: 10n ** 18n, receivedDelta: 10n ** 18n },
  probeAmount: 10n ** 18n,
  probeHolder: A.alice,
  implementationSlot: `0x${"0".repeat(64)}`,
  beaconSlot: `0x${"0".repeat(64)}`,
  explorer: { isContract: true, isVerified: true, creatorAddress: A.bob, creationTx: null, proxyType: null, implementations: [] },
  supplyNow: 10n ** 24n,
  supplyAtLaunch: 10n ** 24n
};

describe("contract checks", () => {
  it("finds selectors as PUSH4 immediates only", () => {
    expect(selectorsInBytecode(codeWith("mint(address,uint256)"), ["mint(address,uint256)", "pause()"])).toEqual(["mint(address,uint256)"]);
    expect(selectorsInBytecode("0x", ["mint(address,uint256)"])).toEqual([]);
  });

  it("does not claim an uninspected clone implementation lacks token controls", () => {
    const clone: Hex = "0x3d3d3d3d363d3d37363d733be8b97fd0e713b5abe0649fa830223b6b4bc5995af43d3d93803e602a57fd5bf3";
    const c = runChecks({ ...cleanInputs, bytecode: clone });
    expect(c.proxy.status).toBe("fail");
    expect(c.mintAfterLaunch.status).toBe("unknown");
    expect(c.pause.status).toBe("unknown");
    expect(c.blocklist.status).toBe("unknown");
    expect(c.transferTax.status).toBe("pass"); // the observed transfer still arrived in full
    expect(hasDelegateCall("0x60f400")).toBe(false); // PUSH data is not an opcode
    expect(selectorsInBytecode("0x646340c10f1900", ["mint(address,uint256)"])).toEqual([]);
  });

  it("passes a plain token", () => {
    const c = runChecks(cleanInputs);
    expect(Object.values(c).map((x) => x.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
  });

  it("fails mint when the selector exists or supply grew after the pool was created", () => {
    expect(runChecks({ ...cleanInputs, bytecode: codeWith("mint(address,uint256)") }).mintAfterLaunch.status).toBe("fail");
    const grew = runChecks({ ...cleanInputs, supplyNow: 2n * 10n ** 24n });
    expect(grew.mintAfterLaunch.status).toBe("fail");
    expect(grew.mintAfterLaunch.detail).toContain("grew");
  });

  it("fails pause when paused() answers, even if not paused", () => {
    const c = runChecks({ ...cleanInputs, pausedCall: false });
    expect(c.pause.status).toBe("fail");
    expect(c.pause.detail).toContain("not paused");
  });

  it("measures a transfer tax from the simulated balance deltas", () => {
    const c = runChecks({ ...cleanInputs, probe: { ok: true, sentDelta: 10n ** 18n, receivedDelta: 95n * 10n ** 16n } });
    expect(c.transferTax.status).toBe("fail");
    expect(c.transferTax.detail).toContain("5.00%");
  });

  it("is unknown when no simulation ran and no tax selector exists", () => {
    expect(runChecks({ ...cleanInputs, probe: null, probeHolder: null }).transferTax.status).toBe("unknown");
    expect(runChecks({ ...cleanInputs, probe: null, bytecode: codeWith("sellTax()") }).transferTax.status).toBe("fail");
  });

  it("flags blocklists and proxies", () => {
    expect(runChecks({ ...cleanInputs, bytecode: codeWith("isBlacklisted(address)") }).blocklist.status).toBe("fail");
    const impl = `0x${"0".repeat(24)}${A.bob.slice(2)}` as Hex;
    expect(runChecks({ ...cleanInputs, implementationSlot: impl }).proxy.status).toBe("fail");
    expect(runChecks({ ...cleanInputs, explorer: { ...cleanInputs.explorer!, proxyType: "eip1967" } }).proxy.status).toBe("fail");
    expect(runChecks({ ...cleanInputs, implementationSlot: null, beaconSlot: null }).proxy.status).toBe("unknown");
    expect(runChecks({ ...cleanInputs, bytecode: "0x" }).proxy.status).toBe("unknown");
  });
});

describe("liquidity lock heuristic", () => {
  const positions = [
    { tokenId: 1n, owner: A.timelock, liquidity: 90n, tickLower: -60, tickUpper: 60 },
    { tokenId: 2n, owner: A.alice, liquidity: 10n, tickLower: -60, tickUpper: 60 }
  ];

  it("reports locked when 80% or more sits with a known locker", async () => {
    const r = await assessLock({ positions, lockers: new Set([A.timelock]), unlockTimeOf: () => Promise.resolve(null) });
    expect(r.liquidityLocked).toBe(true);
    expect(r.lockedShare).toBe(0.9);
    expect(r.lockedUntil).toBeNull();
  });

  it("uses a timelock's unlock time and reports false honestly otherwise", async () => {
    const r = await assessLock({ positions, lockers: new Set(), unlockTimeOf: (o) => Promise.resolve(o === A.timelock ? 1_800_000_000 : null) });
    expect(r.liquidityLocked).toBe(true);
    expect(r.lockedUntil).toBe(1_800_000_000);
    const none = await assessLock({ positions, lockers: new Set(), unlockTimeOf: () => Promise.resolve(null) });
    expect(none.liquidityLocked).toBe(false);
    expect(none.lockedShare).toBe(0);
    expect(none.detail).toContain("no position is held by a known locker");
    const empty = await assessLock({ positions: [], lockers: new Set(), unlockTimeOf: () => Promise.resolve(null) });
    expect(empty.detail).toContain("no live positions");
  });
});

describe("sample store", () => {
  it("needs seven days of samples for the median and prunes old ones", () => {
    const store = SampleStore.inMemory();
    const now = 1_700_000_000;
    for (let i = 0; i < 24 * 3; i++) store.addTokenSample(A.NVDOG, { at: now - i * 3600, priceUSDG: "0.1", mcapUSDG: String(1_000_000 + i) });
    expect(mcapMedian7d(store, A.NVDOG, now, medianBig).median).toBeNull();
    for (let i = 24 * 3; i < 24 * 7; i++) store.addTokenSample(A.NVDOG, { at: now - i * 3600, priceUSDG: "0.1", mcapUSDG: String(1_000_000 + i) });
    const m = mcapMedian7d(store, A.NVDOG, now, medianBig);
    expect(m.median).not.toBeNull();
    expect(m.samples).toBe(24 * 7);
    store.addTokenSample(A.NVDOG, { at: now - 40 * 86_400, priceUSDG: "1", mcapUSDG: "1" });
    store.prune(now);
    expect(store.tokenSamples(A.NVDOG, 0).length).toBe(24 * 7);
    expect(store.counts().tokens).toBe(1);
  });
});

describe("facts assembly", () => {
  function setup(): { deps: FactsDeps; reader: FakeReader; explorer: FakeExplorer; indexer: FakeIndexer; store: SampleStore } {
    const reader = new FakeReader();
    const deployment = fixtureDeployment();
    const pricer = new Pricer(reader, deployment);
    const explorer = new FakeExplorer();
    const indexer = new FakeIndexer();
    const store = SampleStore.inMemory();
    reader.configs.set(A.NVDOG, { allowed: true, lane: "MEME", minAmount: 1n, maxDealRaw: 10n ** 24n, maxOpenRaw: 10n ** 25n });
    reader.configs.set(A.NVDAx, { allowed: true, lane: "STOCK", minAmount: 1n, maxDealRaw: 10n ** 24n, maxOpenRaw: 10n ** 25n });
    reader.supplies.set(A.NVDOG, 100_000_000n * 10n ** 18n); // 100M × 0.1 USDG = 10M USDG
    reader.codes.set(A.NVDOG, codeWith("transfer(address,uint256)"));
    return { deps: { reader, pricer, deployment, explorer, indexer, store, knownLockers: [] }, reader, explorer, indexer, store };
  }

  it("degrades to unknowns with reasons when the explorer, indexer and sampler have nothing", async () => {
    const { deps } = setup();
    const f = await assembleFacts(deps, A.NVDOG);
    expect(f.lane).toBe("MEME");
    expect(f.pool).toBe("nvdogNvda");
    expect(f.pairToken).toBe(A.NVDAx);
    expect(f.pairSymbol).toBe("NVDAx");
    expect(f.priceUSDG).toBe("0.1");
    expect(f.mcapUSDG).toBe((10_000_000n * 10n ** 6n).toString());
    expect(f.mcapMedian7d).toBeNull();
    expect(f.poolCreatedAt).toBe(1_700_000_000);
    expect(f.poolAgeDays).toBeGreaterThan(7);
    expect(BigInt(f.depthUSDG!)).toBeGreaterThan(0n);
    expect(f.liquidityLocked).toBe(false);
    expect(f.topTenShare).toBeNull();
    expect(f.creatorShare).toBeNull();
    expect(f.volume7d).toBeNull();
    expect(f.drawdown30d).toBeNull();
    expect(f.checks.transferTax.status).toBe("unknown");
    expect(f.eligible).toBe(false);
    expect(f.rules.find((r) => r.rule === "marketCap")?.status).toBe("unknown");
    expect(f.basis.explorer).toBe("offline");
    expect(f.basis.indexer).toBe("offline");
    expect(f.basis.notes.join(" ")).toContain("explorer offline");
    expect(f.listingNote).toContain("Memes can go to zero. If the borrower walks away, you hold it.");
    expect(f.listingNote).toContain("Does not meet the listing rules");
    expect(f.listingNote).not.toMatch(/\bbest\b|\binterest\b|\bAPY\b/);
    expect(f.suggestedCaps).not.toBeNull();
  });

  it("shows an exact-token admission disclosure without changing screening results", async () => {
    const { deps, reader } = setup();
    const before = await assembleFacts(deps, A.NVDOG);
    deps.deployment.collateralNotes = { [A.NVDOG]: { poolId: deps.deployment.pools.nvdogNvda!.poolId, note: "Individually admitted ERC20; the selected pool is a pricing route only." } };
    const after = await assembleFacts(deps, A.NVDOG);
    expect(after.listingNote).toContain(deps.deployment.collateralNotes[A.NVDOG]!.note);
    expect(after.rules).toEqual(before.rules);
    expect(after.eligible).toBe(before.eligible);
    reader.configs.set(A.NVDOG, { ...reader.configs.get(A.NVDOG)!, allowed: false });
    const disabled = await assembleFacts(deps, A.NVDOG);
    expect(disabled.listingNote).not.toContain("Individually admitted ERC20");
    reader.configs.set(A.NVDOG, { ...reader.configs.get(A.NVDOG)!, allowed: true });
    deps.deployment.collateralNotes[A.NVDOG]!.poolId = deps.deployment.pools.nvdaUsdg!.poolId;
    expect((await assembleFacts(deps, A.NVDOG)).listingNote).not.toContain("Individually admitted ERC20");
  });

  it("qualifies a token with seven days of samples, a stock pair and clean checks", async () => {
    const { deps, reader, explorer, indexer, store } = setup();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 24 * 7; i++) store.addTokenSample(A.NVDOG, { at: now - i * 3600, priceUSDG: i < 24 ? "0.1" : "0.2", mcapUSDG: (10_000_000n * 10n ** 6n).toString() });
    explorer.holdersResult = {
      value: [
        { address: A.pm, isContract: true, value: 50_000_000n * 10n ** 18n },
        { address: A.alice, isContract: false, value: 20_000_000n * 10n ** 18n },
        { address: A.bob, isContract: false, value: 5_000_000n * 10n ** 18n }
      ],
      reason: null
    };
    explorer.creatorResult = { value: { wallet: A.bob, via: "sender of the creation transaction" }, reason: null };
    explorer.infoResult = { value: { isContract: true, isVerified: true, creatorAddress: A.bob, creationTx: null, proxyType: null, implementations: [] }, reason: null };
    reader.poolPositionList.set(POOL_ID.nvdogNvda, [{ tokenId: 1n, owner: A.timelock, liquidity: 10n ** 22n, tickLower: -600, tickUpper: 600 }]);
    reader.unlockTimes.set(A.timelock, now + 30 * 86_400);
    indexer.poolResult = {
      value: { poolId: POOL_ID.nvdogNvda, sqrtPriceX96: 0n, liquidity: 0n, swaps: [{ at: now - 3600, sqrtPriceX96: 1n, amount0: -(10n ** 18n), amount1: 1000n * 10n ** 18n }] },
      reason: null
    };
    const f = await assembleFacts(deps, A.NVDOG);
    expect(f.eligible).toBe(true);
    expect(f.mcapMedian7d).toBe((10_000_000n * 10n ** 6n).toString());
    // pool manager excluded: top ten = alice + bob = 25%
    expect(f.topTenShare).toBe(0.25);
    expect(f.creatorShare).toBe(0.05);
    expect(f.creatorWallet).toBe(A.bob);
    expect(f.liquidityLocked).toBe(true);
    expect(f.lockedUntil).toBe(now + 30 * 86_400);
    // 1000 NVDOG at 0.1 USDG
    expect(f.volume7d).toBe((100n * 10n ** 6n).toString());
    expect(f.drawdown30d).toBeCloseTo(0.5, 6);
    expect(f.checks.transferTax.status).toBe("pass");
    expect(reader.probeCalls[0]?.holder).toBe(A.alice);
    expect(reader.probeCalls[0]?.amount).toBe(10n ** 18n);
    expect(f.listingNote).toContain("Meets the listing rules of spec 7.4");
    expect(f.listingNote).toContain("Liquidity is locked");
    expect(f.basis.explorer).toBe("ok");
  });

  it("requires explicit quote-policy approval for USDG and keeps stock policy revocable", () => {
    const base = { picked: { pool: fixtureDeployment().pools.nvdogNvda!, pairLane: null, pairAllowed: false, quoteAsset: "USDG" as const, quoteApproved: false }, poolAgeDays: 10, medianMcap: 2_000_000n * 10n ** 6n, medianSamples: 168, usdgDecimals: 6, checks: runChecks(cleanInputs) };
    expect(buildRules(base).find(r => r.rule === "pool")?.status).toBe("fail");
    expect(buildRules({ ...base, picked: { ...base.picked, quoteApproved: true } }).find(r => r.rule === "pool")?.status).toBe("pass");
    expect(buildRules({ ...base, picked: { ...base.picked, pairLane: "STOCK", pairAllowed: true, quoteApproved: false } }).find(r => r.rule === "pool")?.status).toBe("fail");
  });

  it("records findings without blocking, but a transfer tax blocks", () => {
    const base = { picked: { pool: fixtureDeployment().pools.nvdogNvda!, pairLane: "STOCK" as const, pairAllowed: true }, poolAgeDays: 10, medianMcap: 2_000_000n * 10n ** 6n, medianSamples: 168, usdgDecimals: 6 };
    const clean = runChecks(cleanInputs);
    expect(buildRules({ ...base, checks: clean }).every((r) => r.status === "pass")).toBe(true);
    const paused = runChecks({ ...cleanInputs, pausedCall: true });
    const rules = buildRules({ ...base, checks: paused });
    expect(rules.find((r) => r.rule === "contractChecks")).toMatchObject({ status: "pass" });
    expect(rules.find((r) => r.rule === "contractChecks")?.detail).toContain("pause fails");
    const taxed = runChecks({ ...cleanInputs, probe: { ok: true, sentDelta: 100n, receivedDelta: 90n } });
    expect(buildRules({ ...base, checks: taxed }).find((r) => r.rule === "contractChecks")?.status).toBe("fail");
    expect(buildRules({ ...base, poolAgeDays: 3, checks: clean }).find((r) => r.rule === "poolAge")?.status).toBe("fail");
    expect(buildRules({ ...base, medianMcap: 999_999n * 10n ** 6n, checks: clean }).find((r) => r.rule === "marketCap")?.status).toBe("fail");
  });

  it("sizes the 1% / 5% caps from depth", () => {
    // 1,000,000 USDG depth at 0.1 USDG per whole token (6 vs 18 decimals)
    const caps = capsFromDepth(1_000_000n * 10n ** 6n, { num: 10n ** 5n, den: 10n ** 18n });
    expect(caps.perDealRaw).toBe((100_000n * 10n ** 18n).toString());
    expect(caps.perAssetRaw).toBe((500_000n * 10n ** 18n).toString());
    expect(formatUSDG(1_234_567n * 10n ** 6n, 6)).toBe("1,234,567");
  });

  it("404s a non-token address", async () => {
    const { deps } = setup();
    await expect(assembleFacts(deps, "0x9000000000000000000000000000000000000009" as Address)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
