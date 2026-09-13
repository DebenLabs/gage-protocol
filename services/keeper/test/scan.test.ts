import { describe, expect, it } from "vitest";
import { chunkRanges, scanLogs } from "../src/scan.js";

describe("chunkRanges", () => {
  it("splits inclusively", () => {
    expect(chunkRanges(0n, 9n, 4n)).toEqual([
      { fromBlock: 0n, toBlock: 3n },
      { fromBlock: 4n, toBlock: 7n },
      { fromBlock: 8n, toBlock: 9n },
    ]);
    expect(chunkRanges(5n, 4n, 4n)).toEqual([]);
  });
});

describe("scanLogs", () => {
  it("halves the chunk on failure and resumes", async () => {
    const seen: [bigint, bigint][] = [];
    const r = await scanLogs(0n, 3_999n, 4_000n, (range) => {
      seen.push([range.fromBlock, range.toBlock]);
      if (range.toBlock - range.fromBlock + 1n > 1_000n) return Promise.reject(new Error("range too large"));
      return Promise.resolve([Number(range.fromBlock)]);
    });
    expect(seen[0]).toEqual([0n, 3_999n]);
    expect(seen[1]).toEqual([0n, 1_999n]);
    expect(seen[2]).toEqual([0n, 999n]);
    expect(r.items).toEqual([0, 1_000, 2_000, 3_000]);
    expect(r.nextCursor).toBe(4_000n);
  });
  it("gives up below the floor", async () => {
    await expect(scanLogs(0n, 10n, 100n, () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
  });
  it("returns the cursor untouched on an empty range", async () => {
    expect(await scanLogs(10n, 5n, 100n, () => Promise.resolve([]))).toEqual({ items: [], nextCursor: 10n });
  });
});
