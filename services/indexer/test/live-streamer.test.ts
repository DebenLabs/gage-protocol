import { describe, expect, it, vi } from "vitest";
import type { Reader } from "../src/lib/live-lp-earnings";
import { liveStreamerState } from "../src/lib/live-streamer";

const streamer = "0x00000000000000000000000000000000000000ab";
const emissions = "0x00000000000000000000000000000000000000ee";
function reader() {
  const getBlock = vi.fn().mockResolvedValue({ number: 100n, timestamp: 1788820894n });
  const multicall = vi.fn().mockResolvedValue([1000n, 3n, 4n]);
  return { getBlock, multicall };
}
const asClient = (r: ReturnType<typeof reader>) => r as unknown as Reader;

describe("live streamer state (D64)", () => {
  it("reads pending, assignedThrough and the current epoch in one multicall at one fresh block", async () => {
    const r = reader();
    const state = await liveStreamerState(asClient(r), streamer, emissions);
    expect(state).toEqual({ blockNumber: "100", asOf: 1788820894, pending: 1000n, assignedThrough: 3n, currentEpoch: 4n });
    expect(r.getBlock).toHaveBeenCalledWith({ blockTag: "latest", includeTransactions: false });
    expect(r.multicall).toHaveBeenCalledTimes(1);
    expect(r.multicall).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: 100n, allowFailure: false,
      contracts: [
        expect.objectContaining({ address: streamer, functionName: "pending" }),
        expect.objectContaining({ address: streamer, functionName: "assignedThrough" }),
        expect.objectContaining({ address: emissions, functionName: "currentEpoch" }),
      ],
    }));
  });

  it.each(["getBlock", "multicall"] as const)("returns a safe unavailable error on %s failure, never zero or provider credentials", async (method) => {
    const r = reader();
    r[method].mockRejectedValue(new Error("provider URL with private credential"));
    await expect(liveStreamerState(asClient(r), streamer, emissions)).rejects.toMatchObject({
      status: 503, code: "STREAMER_UNAVAILABLE", message: "Streamed rewards are temporarily unavailable. Please retry.",
    });
  });

  it("rejects a short batch or an unpinned block instead of defaulting to zero", async () => {
    const short = reader();
    short.multicall.mockResolvedValue([1000n]);
    await expect(liveStreamerState(asClient(short), streamer, emissions)).rejects.toMatchObject({ status: 503 });
    const unpinned = reader();
    unpinned.getBlock.mockResolvedValue({ number: null, timestamp: 1n });
    await expect(liveStreamerState(asClient(unpinned), streamer, emissions)).rejects.toMatchObject({ status: 503 });
    expect(unpinned.multicall).not.toHaveBeenCalled();
  });
});
