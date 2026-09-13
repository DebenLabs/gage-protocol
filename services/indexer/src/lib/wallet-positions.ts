import type { Address, Hex } from "viem";
import { decodePositionInfo, formatWalletPosition, isEmptyPositionInfo, poolIdOf, poolNameOf, type PoolKey, type WalletPositionJson } from "./position";
import type { PoolDef } from "./deployment";

export interface WalletPositionReader {
  blockNumber(): Promise<bigint>;
  owners(ids: readonly bigint[], block: bigint): Promise<(Address | null)[]>;
  position(id: bigint, block: bigint): Promise<{ key: PoolKey; info: bigint; liquidity: bigint }>;
  allowed(poolId: Hex, block: bigint): Promise<boolean>;
}
/** Inventory identifies candidates only. Every returned NFT is owned by this wallet at one pinned block. */
export async function walletPositions(wallet: Address, inventory: readonly string[], indexedIds: readonly bigint[], reader: WalletPositionReader, pools: readonly PoolDef[]): Promise<WalletPositionJson[]> {
  const ids = [...new Set([...inventory, ...indexedIds.map(String)])].map(BigInt).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  if (ids.length === 0) return [];
  const block = await reader.blockNumber();
  const owners = await reader.owners(ids, block);
  if (owners.length !== ids.length) throw new Error("Incomplete ownership response");
  const owned = ids.filter((_,i) => owners[i]?.toLowerCase() === wallet.toLowerCase());
  const allowed = new Map<Hex, Promise<boolean>>();
  const result: WalletPositionJson[] = [];
  // Bound live reads for wallets with many NFTs; batches stay small and fail rather than silently omit data.
  for (let offset = 0; offset < owned.length; offset += 8) {
    const batch = await Promise.all(owned.slice(offset, offset+8).map(async tokenId => {
      const {key,info,liquidity} = await reader.position(tokenId, block);
      if (isEmptyPositionInfo(info)) return null;
      const poolId = poolIdOf(key);
      if (!allowed.has(poolId)) allowed.set(poolId, reader.allowed(poolId, block));
      return formatWalletPosition({tokenId,poolId,...key,...decodePositionInfo(info)}, liquidity, await allowed.get(poolId)!, poolNameOf(pools,poolId));
    }));
    result.push(...batch.filter((p): p is WalletPositionJson => p !== null));
  }
  return result;
}
