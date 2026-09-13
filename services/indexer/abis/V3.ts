import { parseAbi } from "viem";
export const v3ManagerAbi = parseAbi([
 "function factory() view returns(address)", "function WETH9() view returns(address)",
 "function balanceOf(address) view returns(uint256)", "function tokenOfOwnerByIndex(address,uint256) view returns(uint256)",
 "function ownerOf(uint256) view returns(address)",
 "function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
]);
export const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns(address)"]);
export const v3PoolAbi = parseAbi([
 "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
 "function liquidity() view returns(uint128)", "function fee() view returns(uint24)", "function tickSpacing() view returns(int24)",
 "function token0() view returns(address)", "function token1() view returns(address)", "function factory() view returns(address)",
 "function feeGrowthGlobal0X128() view returns(uint256)", "function feeGrowthGlobal1X128() view returns(uint256)",
 "function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)"
]);
