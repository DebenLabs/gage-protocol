import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  checkpoint: "0000002000" + "4663".padStart(16, "0") + "100".padStart(16, "0") + "0".repeat(33),
  launchBlock: 10 as number | undefined,
  creator: [] as { tx: string; at: bigint; ethTotal: bigint; ethToOps: bigint; bounty: bigint }[],
  deals: [] as { tx: string; at: bigint; usdgIn: bigint; gageBought: bigint }[],
  read: vi.fn(), block: vi.fn(), receipt: vi.fn(),
}));
vi.mock("ponder:api", () => ({
  db: {
    execute: async () => [{ chain_id: 4663, latest_checkpoint: state.checkpoint }],
    select: () => ({ from: async (table: string) => table === "creator" ? state.creator : state.deals }),
  },
  publicClients: { robinhood: { readContract: state.read, getBlock: state.block, getTransactionReceipt: state.receipt } },
}));
vi.mock("ponder:schema", () => ({ creatorFeeSplits: "creator", dealFeeFloorDeposits: "deals" }));
vi.mock("../src/api/views", () => ({ deployment: {
  chainId: 4663,
  get tokenLaunchBlock() { return state.launchBlock; },
  m1: { USDG: "0x0000000000000000000000000000000000000001" },
  token: { GAGE: "0x0000000000000000000000000000000000000002", CreatorFeeSplitter: "0x0000000000000000000000000000000000000003", PoolManager: "0x0000000000000000000000000000000000000004", DealFeeRouter: "0x0000000000000000000000000000000000000005" },
  pools: [{ name: "gageEth", poolId: `0x${"0".repeat(64)}` }],
} }));
vi.mock("../src/lib/buybacks", () => ({ creatorGageBought: () => 123n }));

import { buybackTotals } from "../src/api/buybacks";

beforeEach(() => {
  vi.clearAllMocks(); state.launchBlock = 10;
  state.creator = [{ tx: `0x${"1".repeat(64)}`, at: 1900n, ethTotal: 2n * 10n ** 18n, ethToOps: 10n ** 18n, bounty: 0n }];
  state.deals = [{ tx: `0x${"2".repeat(64)}`, at: 1900n, usdgIn: 100000000n, gageBought: 50n }];
  state.block.mockImplementation(async ({ blockNumber }) => ({ timestamp: blockNumber === 10n ? 1000n : 2000n }));
  state.read.mockImplementation(async ({ functionName }) => functionName === "ethValueUSDG" ? 2500000000n : functionName === "decimals" ? 6 : "0x0000000000000000000000000000000000000009");
  state.receipt.mockResolvedValue({ status: "success", logs: [] });
});

describe("buyback fee API snapshot", () => {
  it("anchors conversion and time to the indexed block and excludes partial/future seconds", async () => {
    state.deals.push({ tx: "ignored", at: 2000n, usdgIn: 999000000n, gageBought: 1n });
    const result = await buybackTotals(1800n);
    expect(result?.fees).toEqual({ totalUSDG: "2600000000", creatorETH: "1000000000000000000", dealUSDG: "100000000", usdgDecimals: 6, launchAt: 1000, asOf: 2000, blockNumber: "100", chainId: 4663 });
    expect(state.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: "ethValueUSDG", blockNumber: 100n }));
  });
  it("leaves fee sharing unavailable on old deployments while retaining token totals", async () => {
    state.launchBlock = undefined;
    expect(await buybackTotals(0n)).toMatchObject({ gageAllTime: "173", fees: null });
  });
  it("never substitutes zero for a failed price read", async () => {
    state.read.mockImplementation(async ({ functionName }) => {
      if (functionName === "ethValueUSDG") throw new Error("RPC unavailable");
      return functionName === "decimals" ? 6 : "0x0000000000000000000000000000000000000009";
    });
    expect(await buybackTotals(0n)).toMatchObject({ gageAllTime: "173", fees: null });
  });
});
