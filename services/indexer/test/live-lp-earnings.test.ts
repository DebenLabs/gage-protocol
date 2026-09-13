import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { liveLPEarnings } from "../src/lib/live-lp-earnings";

const rewards = "0x57Ea11d7250C7Ee3127eFa9d0e2b114348C5ba19";
const streamer = "0x00000000000000000000000000000000000000ab";
function reader() {
  const getBlock = vi.fn().mockResolvedValue({ number: 100n, timestamp: 1788820894n });
  const multicall = vi.fn().mockResolvedValue([[306836n * 10n ** 18n, 0n], [77n, 12n]]);
  return { getBlock, multicall };
}
const asClient = (r: ReturnType<typeof reader>) => r as unknown as Pick<PublicClient, "getBlock" | "multicall">;

describe("live pending LP earnings", () => {
  it("reads every position's earned view at one fresh block, including earnings before any collection", async () => {
    const r = reader();
    const result = await liveLPEarnings(asClient(r), rewards, [2137331n, 2137332n]);
    expect(result.earningsAsOf).toBe(1788820894);
    expect(result.earningsBlock).toBe("100");
    expect(result.earned.get(2137331n)).toEqual({ emissionsEarned: 306836n * 10n ** 18n, creatorFeeEarned: 0n, streamerEarned: 0n });
    expect(result.earned.get(2137332n)).toEqual({ emissionsEarned: 77n, creatorFeeEarned: 12n, streamerEarned: 0n });
    expect(r.getBlock).toHaveBeenCalledWith({ blockTag: "latest", includeTransactions: false });
    expect(r.multicall).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: 100n, allowFailure: false,
      contracts: [2137331n, 2137332n].map(id => expect.objectContaining({ address: rewards, functionName: "earned", args: [id] })),
    }));
  });

  it("refreshes accrual and accepts zero after collection instead of retaining lifetime collected amounts", async () => {
    const r = reader();
    r.getBlock.mockResolvedValueOnce({ number: 100n, timestamp: 1788820894n })
      .mockResolvedValueOnce({ number: 101n, timestamp: 1788820895n })
      .mockResolvedValueOnce({ number: 102n, timestamp: 1788820896n });
    r.multicall.mockResolvedValueOnce([[100n, 10n]]).mockResolvedValueOnce([[150n, 10n]]).mockResolvedValueOnce([[0n, 0n]]);
    const samples = [];
    for (let i = 0; i < 3; i++) samples.push((await liveLPEarnings(asClient(r), rewards, [2137331n])).earned.get(2137331n));
    expect(samples).toEqual([
      { emissionsEarned: 100n, creatorFeeEarned: 10n, streamerEarned: 0n },
      { emissionsEarned: 150n, creatorFeeEarned: 10n, streamerEarned: 0n },
      { emissionsEarned: 0n, creatorFeeEarned: 0n, streamerEarned: 0n },
    ]);
    expect(r.multicall.mock.calls.map(([args]) => args.blockNumber)).toEqual([100n, 101n, 102n]);
  });

  it.each(["getBlock", "multicall"] as const)("returns a safe unavailable error on %s failure, never zero or provider credentials", async (method) => {
    const r = reader();
    r[method].mockRejectedValue(new Error("provider URL with private credential"));
    await expect(liveLPEarnings(asClient(r), rewards, [2137331n])).rejects.toMatchObject({
      status: 503, code: "LP_EARNINGS_UNAVAILABLE", message: "Pending LP rewards are temporarily unavailable. Please retry.",
    });
  });

  it("rejects a block without a number instead of reading unpinned earnings", async () => {
    const r = reader();
    r.getBlock.mockResolvedValue({ number: null, timestamp: 1788820894n });
    await expect(liveLPEarnings(asClient(r), rewards, [2137331n])).rejects.toMatchObject({ status: 503 });
    expect(r.multicall).not.toHaveBeenCalled();
  });

  it("rejects incomplete batches instead of defaulting a missing position to zero", async () => {
    const r = reader();
    r.multicall.mockResolvedValue([]);
    await expect(liveLPEarnings(asClient(r), rewards, [2137331n])).rejects.toMatchObject({ status: 503 });
  });

  it("reads the streamer's earned view for every position in the same multicall when the deployment has one (D64)", async () => {
    const r = reader();
    r.multicall.mockResolvedValue([[100n, 10n], [200n, 20n], 5n, 0n]);
    const result = await liveLPEarnings(asClient(r), rewards, [2137331n, 2137332n], streamer);
    expect(result.earned.get(2137331n)).toEqual({ emissionsEarned: 100n, creatorFeeEarned: 10n, streamerEarned: 5n });
    expect(result.earned.get(2137332n)).toEqual({ emissionsEarned: 200n, creatorFeeEarned: 20n, streamerEarned: 0n });
    expect(r.multicall).toHaveBeenCalledTimes(1);
    expect(r.multicall).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: 100n, allowFailure: false,
      contracts: [
        ...[2137331n, 2137332n].map((id) => expect.objectContaining({ address: rewards, functionName: "earned", args: [id] })),
        ...[2137331n, 2137332n].map((id) => expect.objectContaining({ address: streamer, functionName: "earned", args: [id] })),
      ],
    }));
  });

  it("rejects a batch missing the streamer's answer instead of a false zero", async () => {
    const r = reader();
    r.multicall.mockResolvedValue([[100n, 10n]]);
    await expect(liveLPEarnings(asClient(r), rewards, [2137331n], streamer)).rejects.toMatchObject({ status: 503, code: "LP_EARNINGS_UNAVAILABLE" });
  });
});
