import { describe, expect, it, vi } from "vitest";
import type { EarnStrategy } from "../../../shared/earn";
import { createReserveRateSource, reserveRateFromSamples, sampleReserveRate, type ReserveRateClient, type ReserveSample } from "../src/lib/earn-reserve-rate";

const RESERVE = "0x00000000000000000000000000000000000000dd";
const UNIT = 10n ** 18n;
const DAY = 86_400n;

/** A chain with 4 blocks a second whose reserve conversion grows 0.1% every week (about 5.34% a year, simple). */
function chain(options: { growthPerWeekBps?: bigint; oldestBlock?: bigint; failBelow?: bigint } = {}) {
  const growth = options.growthPerWeekBps ?? 10n;
  const timestamp = (block: bigint) => 1_700_000_000n + block / 4n;
  const client: ReserveRateClient = {
    getBlock: vi.fn(async ({ blockNumber }) => {
      if (options.oldestBlock !== undefined && blockNumber < options.oldestBlock) throw new Error("block not found");
      return { timestamp: timestamp(blockNumber) };
    }),
    readContract: vi.fn(async ({ blockNumber, args }) => {
      if (options.failBelow !== undefined && blockNumber < options.failBelow) throw new Error("missing trie node");
      const weeks = timestamp(blockNumber) - 1_700_000_000n;
      return args[0] + args[0] * growth * weeks / (10_000n * 7n * DAY);
    }),
  };
  return client;
}

describe("Earn reserve rate sample", () => {
  it("annualises the conversion growth over about a week before the snapshot block", async () => {
    const client = chain();
    const sample = await sampleReserveRate(client, RESERVE, UNIT, 10_000_000n);
    expect(sample).not.toBeNull();
    expect(sample!.toBlock).toBe("10000000");
    expect(sample!.windowSeconds).toBe(7 * 86_400);
    expect(BigInt(sample!.fromBlock)).toBe(10_000_000n - 7n * DAY * 4n);
    // 0.1% a week → 10 bps × 365/7 = 521 bps (integer division inside the sample).
    expect(sample!.yearlyBps).toBeGreaterThanOrEqual(519);
    expect(sample!.yearlyBps).toBeLessThanOrEqual(522);
    expect(vi.mocked(client.readContract)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.getBlock)).toHaveBeenCalledTimes(3);
  });

  it("returns null when the older state cannot be served, the window is under a day, or the chain is too young", async () => {
    expect(await sampleReserveRate(chain({ failBelow: 9_999_999n }), RESERVE, UNIT, 10_000_000n)).toBeNull();
    expect(await sampleReserveRate(chain({ oldestBlock: 9_990_000n }), RESERVE, UNIT, 10_000_000n)).toBeNull();
    // A chain two hours old: the sample would fall inside the minimum window.
    expect(await sampleReserveRate(chain(), RESERVE, UNIT, 4n * 7200n)).toBeNull();
    expect(await sampleReserveRate(chain(), RESERVE, UNIT, 1n)).toBeNull();
    expect(await sampleReserveRate(chain(), RESERVE, 0n, 10_000_000n)).toBeNull();
  });

  it("reports a falling conversion as a negative rate and a flat one as zero", async () => {
    expect((await sampleReserveRate(chain({ growthPerWeekBps: -10n }), RESERVE, UNIT, 10_000_000n))!.yearlyBps).toBeLessThan(0);
    expect((await sampleReserveRate(chain({ growthPerWeekBps: 0n }), RESERVE, UNIT, 10_000_000n))!.yearlyBps).toBe(0);
  });

  it("caches one sample per reserve for the TTL and shares it between concurrent callers", async () => {
    const client = chain();
    let now = 0;
    const source = createReserveRateSource(client, { ttlMs: 1000, now: () => now });
    const snapshot = { reserve: RESERVE, reserveDecimals: 18, blockNumber: "10000000" } as unknown as EarnStrategy;
    const [first, second] = await Promise.all([source(snapshot), source(snapshot)]);
    expect(first).toEqual(second);
    expect(vi.mocked(client.readContract)).toHaveBeenCalledTimes(2);
    now = 999;
    await source({ ...snapshot, blockNumber: "10000400" });
    expect(vi.mocked(client.readContract)).toHaveBeenCalledTimes(2);
    now = 1000;
    const refreshed = await source({ ...snapshot, blockNumber: "10000400" });
    expect(vi.mocked(client.readContract)).toHaveBeenCalledTimes(4);
    expect(refreshed!.toBlock).toBe("10000400");
  });
});

describe("Earn reserve rate from stored samples", () => {
  /** Hourly samples growing 0.1% a week, oldest first. */
  const series = (hours: number, start = 1_700_000_000n): ReserveSample[] => Array.from({ length: hours + 1 }, (_, i) => {
    const asOf = start + BigInt(i) * 3600n;
    return { block: BigInt(1000 + i * 36000), asOf, assets: UNIT + UNIT * 10n * BigInt(i) * 3600n / (10_000n * 7n * DAY) };
  });
  it("reads the newest sample against the one about a week older, and reports the window it covered", () => {
    const rate = reserveRateFromSamples(series(24 * 9));
    expect(rate!.windowSeconds).toBe(7 * 86_400);
    expect(rate!.yearlyBps).toBeGreaterThanOrEqual(519);
    expect(rate!.yearlyBps).toBeLessThanOrEqual(522);
    expect(rate!.toBlock).toBe(String(1000 + 24 * 9 * 36000));
    const young = reserveRateFromSamples(series(9));
    expect(young!.windowSeconds).toBe(9 * 3600);
    expect(young!.yearlyBps).toBeGreaterThanOrEqual(515);
    expect(reserveRateFromSamples(series(5))).toBeNull();
    expect(reserveRateFromSamples([])).toBeNull();
    expect(reserveRateFromSamples(series(24).reverse())!.windowSeconds).toBe(24 * 3600);
  });
  it("needs no RPC once the samples span the window, tries the archive for a young series, and keeps what the samples cover otherwise", async () => {
    const snapshot = { reserve: RESERVE, reserveDecimals: 18, blockNumber: "10000000" } as unknown as EarnStrategy;
    const full = chain();
    const fromSamples = await createReserveRateSource(full, { samples: async () => series(24 * 8) })(snapshot);
    expect(fromSamples!.windowSeconds).toBe(7 * 86_400);
    expect(vi.mocked(full.readContract)).not.toHaveBeenCalled();
    const archive = chain();
    const preferred = await createReserveRateSource(archive, { samples: async () => series(9) })(snapshot);
    expect(preferred!.windowSeconds).toBe(7 * 86_400);
    expect(vi.mocked(archive.readContract)).toHaveBeenCalledTimes(2);
    const pruned = chain({ failBelow: 9_999_999n });
    const fallback = await createReserveRateSource(pruned, { samples: async () => series(9) })(snapshot);
    expect(fallback!.windowSeconds).toBe(9 * 3600);
    expect(await createReserveRateSource(pruned, { samples: async () => { throw new Error("db"); } })(snapshot)).toBeNull();
  });
});
