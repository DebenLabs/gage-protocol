import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from "viem";
import { PositionManagerAbi } from "../../abis/PositionManager";
import { ERC721Abi } from "../../abis/ERC721";
import { CollateralRegistryAbi } from "../../abis/CollateralRegistry";
import { ApiError } from "./errors";
import type { WalletPositionReader } from "./wallet-positions";
export function onchainPositionReader(client: Pick<PublicClient,"getBlockNumber"|"readContract"|"multicall">, positionManager: Address, registry: Address): WalletPositionReader {
  return {
  blockNumber: () => client.getBlockNumber(),
  owners: async (ids,blockNumber) => {
    const results = await client.multicall({
    multicallAddress:"0xcA11bde05977b3631167028862bE2a173976CA11",batchSize:32000,blockNumber,
    contracts:ids.map(tokenId=>({address:positionManager,abi:ERC721Abi,functionName:"ownerOf" as const,args:[tokenId] as const})),
    });
    return results.map(r=>{
    if(r.status==="success") return r.result;
    // Burned/nonexistent NFTs revert. RPC or provider failures must not masquerade as an empty wallet.
    if(r.error instanceof BaseError && r.error.walk(e=>e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) return null;
    throw new ApiError(503,"OWNERSHIP_UNAVAILABLE","Unable to verify NFT ownership; please retry.");
    });
  },
  position: async (tokenId,blockNumber) => {
    const [[key,info],liquidity] = await Promise.all([
    client.readContract({address:positionManager,abi:PositionManagerAbi,functionName:"getPoolAndPositionInfo",args:[tokenId],blockNumber}),
    client.readContract({address:positionManager,abi:PositionManagerAbi,functionName:"getPositionLiquidity",args:[tokenId],blockNumber}),
    ]);
    return {key,info,liquidity};
  },
  allowed: async (poolId,blockNumber) => (await client.readContract({address:registry,abi:CollateralRegistryAbi,functionName:"getPoolConfig",args:[poolId],blockNumber})).allowed,
  };
}
