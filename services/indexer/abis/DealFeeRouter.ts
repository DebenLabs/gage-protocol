import { parseAbi } from "viem";
export const DealFeeRouterAbi = parseAbi(["event FloorFunded(address indexed caller,uint256 usdgIn,uint256 ethOut,uint256 gageBought,uint256 gageAdded)"]);
