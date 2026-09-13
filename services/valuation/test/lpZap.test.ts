import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NATIVE } from "../src/deployment.js";
import { SampleStore } from "../src/facts/store.js";
import { Pricer } from "../src/pricing/pricer.js";
import { quoteLPZap, zapRoutes, type LPZapParams } from "../src/quote/lpZap.js";
import { readZapStatus, type ZapStatus } from "../src/zap/status.js";
import { A, FakeReader, FakeIndexer, FakeExplorer, fixtureDeployment } from "./helpers/fake.js";
import type { PublicClient } from "viem";
import type { ZapSimulator } from "../src/zap/simulate.js";
import { zapSimulator } from "../src/zap/simulate.js";

function fixture() {
  const deployment = fixtureDeployment();
  deployment.tokens.WETH = A.alice;
  const reader = new FakeReader();
  const pricer = new Pricer(reader, deployment);
  const suggest = { indexer: new FakeIndexer(), store: SampleStore.inMemory(), sigmaMultiplier: 1.5 };
  const status: ZapStatus = { enabled: true, reason: null, chainId: 46630, vault: A.vault, router: A.bob, quoter: A.bob, weth: A.alice,
    feeBps: 100, terms: [7 * 86400, 21 * 86400], routingPools: [deployment.pools.usdgEth!, deployment.pools.nvdaUsdg!],
    items: ["nvdaUsdg", "nvdogNvda"].map(name => {
      const pool = deployment.pools[name]!;
      return { pool, token0: reader.metas.get(pool.currency0)!, token1: reader.metas.get(pool.currency1)!,
        baseToken: name === "nvdaUsdg" ? A.USDG : A.NVDAx, minLiquidity: "1" };
    }) };
  const params: LPZapParams = { pool: "nvdaUsdg", payAsset: "USDG", amount: 1000_000000n, term: 7 * 86400, slippageBps: 100 };
  const simulate: ZapSimulator = async (_quoter, p, requiredBlock) => {
    const state = await pricer.poolState(p.pool);
    let available = p.amountIn;
    let currency = p.inputCurrency;
    const swaps = p.route.map(key => {
      const zeroForOne = key.currency0 === currency;
      const amountIn = available;
      available /= 2n;
      currency = zeroForOne ? key.currency1 : key.currency0;
      return { key, zeroForOne, amountIn, minOut: available };
    });
    swaps.push({ key: p.pool, zeroForOne: p.pool.currency0 === p.baseToken, amountIn: available / 2n, minOut: available / 3n });
    return { swaps, baseAmount: available, split: { sell: available / 2n, output: available / 3n,
      sqrtPriceAfterX96: state.sqrtPriceX96, liquidity: 100000000000000000000n, amount0: 100n, amount1: 100n },
      block: requiredBlock ?? 10n, at: 1000 };
  };
  return { deployment, reader, pricer, suggest, status, params, simulate };
}

describe("LP zap quotes", () => {
  it("pins the live simulation and timestamp read to the request block", async () => {
    const f = fixture();
    const getBlocks: Array<bigint | undefined> = [];
    const simulatedBlocks: Array<bigint | undefined> = [];
    const client = {
      getBlock: async (request?: { blockNumber?: bigint }) => {
        getBlocks.push(request?.blockNumber);
        return { number: request?.blockNumber ?? 999n, timestamp: 1_800_000_000n };
      },
      simulateContract: async (request: { blockNumber?: bigint }) => {
        simulatedBlocks.push(request.blockNumber);
        return { result: { swaps: [], split: { sell: 1n, output: 1n, sqrtPriceAfterX96: 2n ** 96n,
          liquidity: 1n, amount0: 1n, amount1: 1n }, baseAmount: 1n } };
      }
    } as unknown as PublicClient;
    const result = await zapSimulator(client)(A.bob, { inputCurrency: A.USDG, amountIn: 1n, pool: f.status.items[0]!.pool,
      baseToken: A.USDG, tickLower: -60, tickUpper: 60, slippageBps: 100, route: [] }, 777n);
    expect(result.block).toBe(777n);
    expect(getBlocks).toEqual([777n]);
    expect(simulatedBlocks).toEqual([777n]);
  });

  it("creates a two-sided USDG-funded LP quote using the recommended range", async () => {
    const f = fixture();
    const q = await quoteLPZap(f.pricer, f.suggest, f.status, f.params, f.simulate);
    expect(q.swaps).toHaveLength(1);
    expect(q.range.recommended.label).toBe("Recommended");
    expect(q.range.basis.volSource).toBe("default");
    expect(q.deadline - q.at).toBe(120);
    expect(BigInt(q.amount0)).toBeGreaterThan(0n);
    expect(BigInt(q.amount1)).toBeGreaterThan(0n);
    expect(BigInt(q.valueUSDG)).toBeGreaterThan(0n);
    expect(q.block).toBe("10");
    expect(q.at).toBe(1000);
    expect(BigInt(q.minLiquidity)).toBeLessThan(BigInt(q.liquidity));
    expect(q.unwrapWeth).toBe(false);
  });
  it("unwraps WETH only when the route starts with native ETH", async () => {
    const f = fixture();
    const q = await quoteLPZap(f.pricer, f.suggest, f.status, { ...f.params, payAsset: "WETH", amount: 10n ** 17n }, f.simulate);
    expect(q.unwrapWeth).toBe(true);
    expect(q.inputToken).toBe(A.alice);
    expect(q.swaps[0]!.key.currency0).toBe(NATIVE);
    expect(q.swaps).toHaveLength(2);
    expect(BigInt(q.swaps[1]!.amountIn)).toBeLessThan(BigInt(q.swaps[0]!.minOut));
  });
  it("routes USDG through stock before creating a meme/stock position", async () => {
    const f = fixture();
    const q = await quoteLPZap(f.pricer, f.suggest, f.status, { ...f.params, pool: "nvdogNvda" }, f.simulate);
    expect(q.swaps.map(s => s.key.name)).toEqual(["nvdaUsdg", "nvdogNvda"]);
    expect(BigInt(q.swaps[1]!.amountIn)).toBeLessThan(BigInt(q.swaps[0]!.minOut));
    expect(BigInt(q.valueUSDG)).toBeGreaterThan(0n);
  });
  it("rejects a pool that exists but is not collateral-admitted", async () => {
    const f = fixture();
    await expect(quoteLPZap(f.pricer, f.suggest, f.status, { ...f.params, pool: "usdgEth" }, f.simulate)).rejects.toThrow("not currently admitted");
  });
  it("rejects a missing reviewed route", async () => {
    const f = fixture();
    f.status.routingPools = [];
    await expect(quoteLPZap(f.pricer, f.suggest, f.status, { ...f.params, pool: "nvdogNvda" }, f.simulate)).rejects.toThrow("no reviewed route");
  });
  it("fails closed when unavailable, below minimum, or term/amount/slippage is invalid", async () => {
    const f = fixture();
    await expect(quoteLPZap(f.pricer, f.suggest, { ...f.status, enabled: false }, f.params, f.simulate)).rejects.toThrow("unavailable");
    for (const patch of [{ term: 86400 }, { amount: 0n }, { amount: 1n << 128n }, { slippageBps: 0 }, { slippageBps: 501 }]) {
      await expect(quoteLPZap(f.pricer, f.suggest, f.status, { ...f.params, ...patch }, f.simulate)).rejects.toThrow();
    }
    f.status.items[0]!.minLiquidity = (1n << 120n).toString();
    await expect(quoteLPZap(f.pricer, f.suggest, f.status, f.params, f.simulate)).rejects.toThrow("minimum liquidity");
  });
  it("keeps native ETH and WETH routes distinct", () => {
    const f = fixture();
    expect(zapRoutes(f.status.routingPools, A.alice, A.USDG, "")).toHaveLength(0);
    expect(zapRoutes(f.status.routingPools, NATIVE, A.USDG, "")).toHaveLength(1);
  });
  it("exposes disabled status without reading any RPC when no router is deployed", async () => {
    const f = fixture();
    const status = await readZapStatus({} as PublicClient, f.reader, f.deployment);
    expect(status).toMatchObject({ enabled: false, router: null, items: [] });
  });
  it("reads collateral eligibility separately from swap routes and stops on configuration mismatch or pause", async () => {
    const f = fixture();
    f.deployment.lpZapRouter = A.bob;
    f.deployment.lpZapQuoter = A.bob;
    f.reader.configs.set(A.NVDAx, { allowed: true, lane: "STOCK", minAmount: 0n, maxDealRaw: 0n, maxOpenRaw: 0n });
    f.reader.configs.set(A.NVDOG, { allowed: true, lane: "MEME", minAmount: 0n, maxDealRaw: 0n, maxOpenRaw: 0n });
    let paused = false;
    let memeUSDGPair = true;
    let memeUSDGCapability = 1n;
    let vault = A.vault;
    const seenBlocks: Array<bigint | undefined> = [];
    const client = { getCode: async (p: { blockNumber?: bigint }) => { seenBlocks.push(p.blockNumber); return "0x"; },
      getChainId: async () => 46630, readContract: async (p: { functionName: string; args?: unknown[]; blockNumber?: bigint }) => {
      seenBlocks.push(p.blockNumber);
      const values: Record<string, unknown> = { POOL_MANAGER: f.deployment.poolManager, VAULT: vault, POSM: A.posm, WETH: A.alice, USDG: A.USDG, REGISTRY: A.registry,
        isRouter: true, newDealsPaused: paused, feeBps: 100, allowedTerms: [86400, 604800, 1814400], isMemePairAllowed: true, zapListingVersion: 1n, memeUSDGZapVersion: memeUSDGCapability };
      if (p.functionName === "isMemePairAllowed") return p.args?.[0] === 1 ? memeUSDGPair : true;
      if (p.functionName === "routingPoolAllowed") return p.args?.[0] === f.deployment.pools.usdgEth!.poolId;
      if (p.functionName === "getPoolConfig") return { allowed: p.args?.[0] === f.deployment.pools.nvdaUsdg!.poolId, minLiquidity: 100n };
      return values[p.functionName];
    } } as unknown as PublicClient;
    const status = await readZapStatus(client, f.reader, f.deployment);
    expect(status.enabled).toBe(true);
    expect(seenBlocks.length).toBeGreaterThan(0);
    expect(seenBlocks.every(block => block === 1000n)).toBe(true);
    expect(status.terms).toEqual([604800, 1814400]);
    expect(status.items.map(i => i.pool.name)).toEqual(["nvdaUsdg"]);
    expect(status.routingPools.map(i => i.name)).toEqual(["usdgEth"]);
    f.reader.configs.set(A.NVDAx, { allowed: true, lane: "MEME", minAmount: 0n, maxDealRaw: 0n, maxOpenRaw: 0n });
    expect((await readZapStatus(client, f.reader, f.deployment)).items).toHaveLength(0);
    f.deployment.vaultVersion = 2;
    expect((await readZapStatus(client, f.reader, f.deployment)).items.map(i => i.pool.name)).toEqual(["nvdaUsdg"]);
    memeUSDGPair = false;
    expect((await readZapStatus(client, f.reader, f.deployment)).items).toHaveLength(0);
    memeUSDGPair = true;
    memeUSDGCapability = 0n;
    expect((await readZapStatus(client, f.reader, f.deployment)).enabled).toBe(false);
    memeUSDGCapability = 1n;
    f.reader.configs.set(A.NVDAx, { allowed: true, lane: "STOCK", minAmount: 0n, maxDealRaw: 0n, maxOpenRaw: 0n });
    expect((await readZapStatus(client, f.reader, f.deployment)).items).toHaveLength(0);
    f.deployment.vaultVersion = 1;
    paused = true;
    expect((await readZapStatus(client, f.reader, f.deployment)).enabled).toBe(false);
    paused = false;
    vault = A.alice;
    expect((await readZapStatus(client, f.reader, f.deployment)).reason).toContain("does not match");
  });
  it("HTTP routes preserve fail-closed status and validate requests", async () => {
    const f = fixture();
    const statusBlocks: bigint[] = [];
    let simulationBlock: bigint | undefined;
    const app = createApp({ reader: f.reader, pricer: f.pricer, deployment: f.deployment, ...f.suggest,
      explorer: new FakeExplorer(), sampler: null, config: { knownLockers: [], rangeSigmaMultiplier: 1.5, factsTtlMs: 1 },
      zapStatus: async (reader) => { statusBlocks.push(await reader.blockNumber()); return f.status; },
      zapSimulator: async (quoter, params, block) => { simulationBlock = block; return f.simulate(quoter, params, block); }, log: () => undefined });
    expect((await app.request("/zap/pools")).status).toBe(200);
    expect((await app.request("/quote/lp-zap?payAsset=ETH")).status).toBe(400);
    const response = await app.request("/quote/lp-zap?pool=nvdaUsdg&payAsset=USDG&amount=1000000000&term=604800");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payAsset: "USDG", vault: A.vault, router: A.bob });
    expect(statusBlocks).toEqual([1000n, 1000n]);
    expect(simulationBlock).toBe(1000n);
    expect(f.reader.snapshotCalls).toBe(2);
  });

  it("refuses to serve an LP quote when the simulator reports another block", async () => {
    const f = fixture();
    const app = createApp({ reader: f.reader, pricer: f.pricer, deployment: f.deployment, ...f.suggest,
      explorer: new FakeExplorer(), sampler: null, config: { knownLockers: [], rangeSigmaMultiplier: 1.5, factsTtlMs: 1 },
      zapStatus: async () => f.status,
      zapSimulator: async (quoter, params, block) => ({ ...(await f.simulate(quoter, params, block)), block: (block ?? 0n) + 1n }),
      log: () => undefined });
    const response = await app.request("/quote/lp-zap?pool=nvdaUsdg&payAsset=USDG&amount=1000000000&term=604800");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "RPC_ERROR" } });
  });
});
