import type { Address } from "viem";
import { EmissionsAbi } from "../../abis/Emissions";
import { LPStreamerAbi } from "../../abis/LPStreamer";
import { ApiError } from "./errors";
import { MULTICALL3, type Reader } from "./live-lp-earnings";

/** The streamer's live figures at one block (D64): the next pot so far, the last fixed epoch, the epoch now. */
export type LiveStreamerState = {
  blockNumber: string;
  asOf: number;
  pending: bigint;
  assignedThrough: bigint;
  currentEpoch: bigint;
};

export const streamerUnavailable = (): ApiError =>
  new ApiError(503, "STREAMER_UNAVAILABLE", "Streamed rewards are temporarily unavailable. Please retry.");

/** Reads `pending`, `assignedThrough` and `Emissions.currentEpoch` in one multicall pinned to one fresh block. */
export async function liveStreamerState(reader: Reader, streamer: Address, emissions: Address): Promise<LiveStreamerState> {
  try {
    const block = await reader.getBlock({ blockTag: "latest", includeTransactions: false });
    const blockNumber = block.number;
    if (blockNumber === null) throw streamerUnavailable();
    const values: readonly unknown[] = await reader.multicall({
      multicallAddress: MULTICALL3,
      blockNumber,
      allowFailure: false,
      contracts: [
        { address: streamer, abi: LPStreamerAbi, functionName: "pending" },
        { address: streamer, abi: LPStreamerAbi, functionName: "assignedThrough" },
        { address: emissions, abi: EmissionsAbi, functionName: "currentEpoch" },
      ],
    });
    const [pending, assignedThrough, currentEpoch] = values;
    if (typeof pending !== "bigint" || typeof assignedThrough !== "bigint" || typeof currentEpoch !== "bigint") {
      throw streamerUnavailable();
    }
    return { blockNumber: blockNumber.toString(), asOf: Number(block.timestamp), pending, assignedThrough, currentEpoch };
  } catch {
    // Provider errors can carry the private endpoint: a safe error, never a false zero.
    throw streamerUnavailable();
  }
}
