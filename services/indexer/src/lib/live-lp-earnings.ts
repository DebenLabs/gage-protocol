import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { LPRewardsAbi } from "../../abis/LPRewards";
import { LPStreamerAbi } from "../../abis/LPStreamer";
import { ApiError } from "./errors";

/** Uncollected balances at one block; `streamerEarned` is zero when the deployment has no `LPStreamer` (D64). */
export type PendingLPEarnings = { emissionsEarned: bigint; creatorFeeEarned: bigint; streamerEarned: bigint };
export type Reader = Pick<PublicClient, "getBlock" | "multicall">;

/** Multicall3, the same address on every chain. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Server only. A separate read endpoint does not change Ponder's indexing transport or history.
let client: ReturnType<typeof createPublicClient> | undefined;
export function lpReadClient(): Reader {
  const rpc = process.env.LP_READ_RPC_URL || process.env.RPC_URL;
  if (!rpc) throw unavailable();
  return client ??= createPublicClient({ transport: http(rpc, { timeout: 8_000, retryCount: 0 }) });
}

const unavailable = () => new ApiError(503, "LP_EARNINGS_UNAVAILABLE", "Pending LP rewards are temporarily unavailable. Please retry.");

const isPair = (v: unknown): v is readonly [bigint, bigint] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "bigint" && typeof v[1] === "bigint";

/**
 * Read pending rewards, never the indexer's lifetime Collected totals. All values share one fresh block: the
 * LPRewards `earned` pair for every position and, when the deployment has a streamer, its `earned` too, in the same
 * multicall, so a failure of either is one 503 and never a false zero.
 */
export async function liveLPEarnings(reader: Reader, rewards: Address, ids: bigint[], streamer?: Address) {
  try {
    // The latest block response supplies both the pin and timestamp, avoiding a separate head request.
    const block = await reader.getBlock({ blockTag: "latest", includeTransactions: false });
    const blockNumber = block.number;
    if (blockNumber === null) throw unavailable();
    const values: readonly unknown[] = await reader.multicall({
      multicallAddress: MULTICALL3,
      blockNumber,
      allowFailure: false,
      contracts: [
        ...ids.map((tokenId) => ({ address: rewards, abi: LPRewardsAbi, functionName: "earned" as const, args: [tokenId] as const })),
        ...(streamer === undefined
          ? []
          : ids.map((tokenId) => ({ address: streamer, abi: LPStreamerAbi, functionName: "earned" as const, args: [tokenId] as const }))),
      ],
    });
    return {
      earningsBlock: blockNumber.toString(),
      earningsAsOf: Number(block.timestamp),
      earned: new Map(ids.map((id, i) => {
        const pair = values[i];
        const streamed = streamer === undefined ? 0n : values[ids.length + i];
        if (!isPair(pair) || typeof streamed !== "bigint") throw unavailable();
        return [id, { emissionsEarned: pair[0], creatorFeeEarned: pair[1], streamerEarned: streamed } satisfies PendingLPEarnings];
      })),
    };
  } catch {
    // Provider errors can contain the private endpoint. Return a safe error, never false zero earnings.
    throw unavailable();
  }
}
