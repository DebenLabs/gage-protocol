import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reader } from "../src/lib/live-lp-earnings";

const STREAMER = "0x00000000000000000000000000000000000000ab";
const EMISSIONS = "0x00000000000000000000000000000000000000ee";
const DEPOSITOR = "0x00000000000000000000000000000000000000c1";
const TX = `0x${"1".repeat(64)}`;

const state = vi.hoisted(() => ({
  streamer: undefined as string | undefined,
  emissions: undefined as string | undefined,
  rows: { epochs: [] as unknown[], deposits: [] as unknown[], collected: [] as unknown[] },
  getBlock: vi.fn(),
  multicall: vi.fn(),
}));

// `await db.select().from(table).orderBy(...).limit(n)` resolves to the mocked table's rows.
vi.mock("ponder:api", () => {
  const builder = (rows: unknown[]) => {
    const b = {
      orderBy: () => b,
      limit: () => b,
      then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    };
    return b;
  };
  return { db: { select: () => ({ from: (table: { name: keyof typeof state.rows }) => builder(state.rows[table.name]) }) } };
});
vi.mock("ponder:schema", () => ({
  lpStreamerEpochs: { name: "epochs", epoch: "epoch" },
  lpStreamerDeposits: { name: "deposits", at: "at", id: "id" },
  lpStreamerCollected: { name: "collected" },
}));
vi.mock("../src/api/views", () => ({
  deployment: { chainId: 4663, token: { get LPStreamer() { return state.streamer; }, get Emissions() { return state.emissions; } } },
}));

import { streamerSummary } from "../src/api/streamer";

const reader = () => ({ getBlock: state.getBlock, multicall: state.multicall }) as unknown as Reader;

beforeEach(() => {
  vi.clearAllMocks();
  state.streamer = STREAMER;
  state.emissions = EMISSIONS;
  state.rows = {
    epochs: [{ epoch: 3n, pot: 10n ** 18n, rate: 5n * 10n ** 26n, fixedAt: 90n, tx: TX }],
    deposits: [{ id: "d1", from: DEPOSITOR, amount: 7n, forEpoch: 4n, at: 99n, tx: TX }],
    collected: [
      { tokenId: 1n, collectedTotal: 5n, collectCount: 1, collectedAt: 95n, lastDripId: `0x${"1".repeat(64)}` },
      { tokenId: 2n, collectedTotal: 6n, collectCount: 2, collectedAt: 96n, lastDripId: `0x${"2".repeat(64)}` },
    ],
  };
  state.getBlock.mockResolvedValue({ number: 100n, timestamp: 1788820894n });
  state.multicall.mockResolvedValue([1000n, 3n, 4n]);
});

describe("GET /streamer (D64)", () => {
  it("is 404 STREAMER_ABSENT without an LPStreamer key, before any chain read", async () => {
    state.streamer = undefined;
    await expect(streamerSummary(reader)).rejects.toMatchObject({ status: 404, code: "STREAMER_ABSENT" });
    expect(state.getBlock).not.toHaveBeenCalled();
  });

  it("joins the indexed pots, deposits and collections with live figures read at one pinned block", async () => {
    await expect(streamerSummary(reader)).resolves.toEqual({
      address: STREAMER,
      currentEpoch: 4,
      assignedThrough: 3,
      pending: "1000",
      epochs: [{ epoch: 3, pot: "1000000000000000000", rate: "500000000000000000000000000" }],
      deposits: [{ from: DEPOSITOR, amount: "7", forEpoch: 4, at: 99, tx: TX }],
      collectedTotal: "11",
    });
    expect(state.multicall).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 100n, allowFailure: false }));
  });

  it("is 503 STREAMER_UNAVAILABLE on an RPC failure, never zero and never the provider's message", async () => {
    state.multicall.mockRejectedValue(new Error("provider URL with private credential"));
    const error = await streamerSummary(reader).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, code: "STREAMER_UNAVAILABLE" });
    expect(String((error as Error).message)).not.toContain("credential");
  });

  it("is 503 when the read client cannot be built or the Emissions key is missing", async () => {
    await expect(streamerSummary(() => { throw new Error("RPC_URL unset"); })).rejects.toMatchObject({ status: 503, code: "STREAMER_UNAVAILABLE" });
    state.emissions = undefined;
    await expect(streamerSummary(reader)).rejects.toMatchObject({ status: 503, code: "STREAMER_UNAVAILABLE" });
    expect(state.getBlock).not.toHaveBeenCalled();
  });
});
