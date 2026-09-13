import { describe, expect, it } from "vitest";
import { encodeFunctionResult, type PublicClient } from "viem";
import { dealVaultAbi } from "../src/abi/index.js";
import { ForeverCache } from "../src/cache.js";
import { ViemChainReader } from "../src/chain/viemReader.js";
import { createApp, type AppDeps } from "../src/app.js";
import { SampleStore } from "../src/facts/store.js";
import { Pricer } from "../src/pricing/pricer.js";
import { A, FakeExplorer, FakeIndexer, FakeReader, fixtureDeployment } from "./helpers/fake.js";

describe("request-scoped valuation snapshots", () => {
  it("passes one fixed block to economic Viem reads", async () => {
    const seen: Array<{ name: string; block: bigint | undefined }> = [];
    const deal = encodeFunctionResult({ abi: dealVaultAbi, functionName: "getDeal", result: {
      borrower: A.alice, kind: 0, state: 1, term: 604_800, listingExpiry: 0, token: A.NVDOG,
      fundedAt: 0, expiry: 0, amountOrTokenId: 1n, cap: 2n, minPrice: 1n, lender: A.bob, price: 0n, fee: 0n
    } });
    const client = {
      readContract: async (request: { functionName: string; blockNumber?: bigint }) => {
        seen.push({ name: request.functionName, block: request.blockNumber });
        switch (request.functionName) {
          case "getERC20Config": return { allowed: true, lane: 0, minAmount: 1n, maxDealRaw: 2n, maxOpenRaw: 3n };
          case "memePairMask": return 4;
          case "totalSupply": return 100n;
          case "decimals": return 18;
          case "symbol": return "TENDIES";
          case "name": return "Tendies";
          case "paused": return false;
          case "getSlot0": return [2n ** 96n, 0, 0, 3_000];
          case "getLiquidity": return 1_000n;
          case "getFeeGrowthInside": return [4n, 5n];
          case "getPositionInfo": return [6n, 7n, 8n];
          default: throw new Error(`unexpected ${request.functionName}`);
        }
      },
      getCode: async (request: { blockNumber?: bigint }) => { seen.push({ name: "getCode", block: request.blockNumber }); return "0x6000"; },
      getStorageAt: async (request: { blockNumber?: bigint }) => { seen.push({ name: "getStorageAt", block: request.blockNumber }); return `0x${"0".repeat(64)}`; },
      call: async (request: { blockNumber?: bigint }) => { seen.push({ name: "getDeal", block: request.blockNumber }); return { data: deal }; }
    } as unknown as PublicClient;
    const deployment = fixtureDeployment();
    const reader = new ViemChainReader("", deployment, 0, { client, block: 777n, forever: new ForeverCache() });

    await Promise.all([
      reader.getERC20Config(A.NVDOG), reader.getERC20Config(A.NVDOG), reader.memePairMask!(), reader.getDeal(1n), reader.totalSupply(A.NVDOG),
      reader.tokenMeta(A.NVDOG), reader.getCode(A.NVDOG), reader.getStorageAt(A.NVDOG, `0x${"0".repeat(64)}`),
      reader.paused(A.NVDOG), reader.slot0(deployment.pools.nvdaUsdg!.poolId), reader.liquidity(deployment.pools.nvdaUsdg!.poolId),
      reader.feeGrowthInside(deployment.pools.nvdaUsdg!.poolId, -60, 60),
      reader.positionFeeState(deployment.pools.nvdaUsdg!.poolId, A.posm, -60, 60, `0x${"0".repeat(64)}`)
    ]);

    expect(seen.length).toBeGreaterThan(10);
    expect(seen.every(request => request.block === 777n)).toBe(true);
    expect(seen.filter(request => request.name === "getERC20Config")).toHaveLength(1);
  });

  it("takes one fresh snapshot for each economic endpoint while retaining request-local dedup", async () => {
    const reader = new FakeReader();
    const deployment = fixtureDeployment();
    const deps: AppDeps = { reader, pricer: new Pricer(reader, deployment), deployment, explorer: new FakeExplorer(),
      indexer: new FakeIndexer(), store: SampleStore.inMemory(), sampler: null,
      config: { knownLockers: [], rangeSigmaMultiplier: 1.5, factsTtlMs: 60_000 }, log: () => undefined };
    const app = createApp(deps);
    const paths = [`/assets/${A.NVDAx}/value`, "/range/suggest?pool=gageSgage&term=7",
      "/quote/reinvest?amount=1000000000000000000&tickLower=-6000&tickUpper=6000",
      "/quote/entry?eth=1000000000000000000", `/quote/payout?usdg=1000000000&to=${A.NVDAx}`];
    for (const [index, path] of paths.entries()) {
      reader.block = 1_000n + BigInt(index);
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(reader.snapshotCalls, path).toBe(index + 1);
    }
  });
});
