import { publicClients } from "ponder:api";
import type { Address, Hex } from "viem";
import { v3ManagerAbi } from "../../abis/V3";
import { deployment } from "./views";
import { PositionManagerAbi } from "../../abis/PositionManager";
import { CHAIN_NAME } from "../lib/deployment";
import { decodePositionInfo, poolIdOf } from "../lib/position";
import { principalValue, type TvlPool } from "../lib/tvl";
import type { PriceGraph } from "../lib/stats";

/** Collateral NFTs are valued from their actual underlying principal, never their repayment caps.
 * Each batch shares one block; pool prices are the indexer's latest observations. Failures are unpriced.
 */
export async function nftPrincipalValues(
  nfts: readonly { token: Address; tokenId: bigint }[], pools: readonly TvlPool[], graph: PriceGraph, usdg: Address, countedPool?: Hex,
): Promise<Map<string, bigint | null>> {
  const values = new Map<string, bigint | null>();
  if (nfts.length === 0) return values;
  const unique = [...new Map(nfts.map(n => [`${n.token}:${n.tokenId}`, n])).entries()];
  const client = publicClients[CHAIN_NAME];
  let blockNumber: bigint;
  try { blockNumber = await client.getBlockNumber(); }
  catch { return new Map(unique.map(([key]) => [key, null])); }
  for (let i = 0; i < unique.length; i += 8) {
    await Promise.all(unique.slice(i, i + 8).map(async ([id, nft]) => {
      try {
        if (deployment.vaultVersion === 3) {
          const p = await client.readContract({ address: nft.token, abi: v3ManagerAbi, functionName: "positions", args: [nft.tokenId], blockNumber });
          const definition = deployment.pools.find(pool => pool.protocol === "v3" && pool.currency0 === p[2].toLowerCase() && pool.currency1 === p[3].toLowerCase() && pool.fee === p[4]);
          const pool = pools.find(pool => pool.poolId === definition?.poolId);
          values.set(id, pool ? principalValue(pool, { poolId: pool.poolId, tickLower: p[5], tickUpper: p[6], liquidity: p[7] }, graph, usdg) : null);
          return;
        }
        const [[key, info], liquidity] = await Promise.all([
          client.readContract({ address: nft.token, abi: PositionManagerAbi, functionName: "getPoolAndPositionInfo", args: [nft.tokenId], blockNumber }),
          client.readContract({ address: nft.token, abi: PositionManagerAbi, functionName: "getPositionLiquidity", args: [nft.tokenId], blockNumber }),
        ]);
        const poolId = poolIdOf(key);
        if (poolId === countedPool) { values.set(id, 0n); return; } // Already counted in pool principal.
        const pool = pools.find(p => p.poolId === poolId);
        values.set(id, pool && info !== 0n ? principalValue(pool, { poolId, ...decodePositionInfo(info), liquidity }, graph, usdg) : null);
      } catch { values.set(id, null); }
    }));
  }
  return values;
}
