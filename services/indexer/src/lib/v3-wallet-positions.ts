import { type Address, type PublicClient } from "viem";
import { v3ManagerAbi, v3FactoryAbi } from "../../abis/V3";
import { CollateralRegistryAbi } from "../../abis/CollateralRegistry";
import { ApiError } from "./errors";
import type { Deployment } from "./deployment";
import { formatWalletPosition } from "./position";

/** Owner enumeration and all eligibility reads share one block. No historical NFT inventory is needed. */
export async function v3WalletPositions(client: Pick<PublicClient,"getBlockNumber"|"multicall">, d: Pick<Deployment,"token"|"m1"|"pools"|"v3Factory">, wallet: Address) {
  const manager=d.token.PositionManager;
  if(!manager || !d.v3Factory) throw new ApiError(503,"V3_CONFIG","V3 position discovery is not configured.");
  const blockNumber=await client.getBlockNumber({cacheTime:0});
  const opts={multicallAddress:"0xcA11bde05977b3631167028862bE2a173976CA11" as const,blockNumber,allowFailure:false as const,batchSize:32000};
  const [count,factory,weth,mask]=await client.multicall({...opts,contracts:[
    {address:manager,abi:v3ManagerAbi,functionName:"balanceOf",args:[wallet]},
    {address:manager,abi:v3ManagerAbi,functionName:"factory"},
    {address:manager,abi:v3ManagerAbi,functionName:"WETH9"},
    {address:d.m1.CollateralRegistry,abi:CollateralRegistryAbi,functionName:"memePairMask"},
  ]});
  if(factory.toLowerCase()!==d.v3Factory) throw new ApiError(503,"V3_CONFIG","V3 factory mismatch.");
  if(count>10000n) throw new ApiError(503,"POSITION_LIMIT","This wallet has too many positions for one request. No partial inventory was returned.");
  if(count===0n) return [];
  const pools=d.pools.filter(p=>p.protocol==="v3");
  const readIds=(offset:bigint)=>{
    const indices=Array.from({length:Number(count-offset<32n?count-offset:32n)},(_,i)=>offset+BigInt(i));
    return client.multicall({...opts,contracts:indices.map(i=>({address:manager,abi:v3ManagerAbi,functionName:"tokenOfOwnerByIndex" as const,args:[wallet,i] as const}))});
  };
  // Registry checks and owner enumeration are independent at the pinned block.
  const [configs,firstIds]=await Promise.all([Promise.all(pools.map(async p=>{
    const [pool,a,b,actual]=await client.multicall({...opts,contracts:[
      {address:d.m1.CollateralRegistry,abi:CollateralRegistryAbi,functionName:"getPoolConfig",args:[p.poolId]},
      {address:d.m1.CollateralRegistry,abi:CollateralRegistryAbi,functionName:"getERC20Config",args:[p.currency0]},
      {address:d.m1.CollateralRegistry,abi:CollateralRegistryAbi,functionName:"getERC20Config",args:[p.currency1]},
      {address:factory,abi:v3FactoryAbi,functionName:"getPool",args:[p.currency0,p.currency1,p.fee]},
    ]});
    const weth0=p.currency0===weth.toLowerCase(), weth1=p.currency1===weth.toLowerCase();
    return {p,pool,allowed:pool.allowed && actual.toLowerCase()===p.poolAddress && Boolean(mask&4) && a.allowed && b.allowed && ((weth0&&a.lane===1&&b.lane===2)||(weth1&&b.lane===1&&a.lane===2))};
  })),readIds(0n)]);
  const result=[];
  for(let offset=0n;offset<count;offset+=32n) {
    const ids=offset===0n?firstIds:await readIds(offset);
    const [positions,owners]=await Promise.all([
      client.multicall({...opts,contracts:ids.map(id=>({address:manager,abi:v3ManagerAbi,functionName:"positions" as const,args:[id] as const}))}),
      client.multicall({...opts,contracts:ids.map(id=>({address:manager,abi:v3ManagerAbi,functionName:"ownerOf" as const,args:[id] as const}))}),
    ]);
    for(let i=0;i<ids.length;i++) {
      if(owners[i]?.toLowerCase()!==wallet.toLowerCase()) throw new ApiError(503,"OWNERSHIP_UNAVAILABLE","NFT ownership could not be verified.");
      const p=positions[i]!;
      const cfg=configs.find(x=>x.p.currency0===p[2].toLowerCase()&&x.p.currency1===p[3].toLowerCase()&&x.p.fee===p[4]);
      if(!cfg || p[7]===0n) continue;
      // Inventory survives a legacy admission cutoff. Each engine validates eligibility independently.
      const allowed=cfg.allowed && p[7]>cfg.pool.minLiquidity;
      result.push({...formatWalletPosition({...cfg.p,tokenId:ids[i]!,tickLower:p[5],tickUpper:p[6]},p[7],allowed,cfg.p.name),protocol:"v3" as const,positionManager:manager,poolAddress:cfg.p.poolAddress});
    }
  }
  return result;
}
