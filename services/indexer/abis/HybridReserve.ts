import { parseAbi } from "viem";
/** Morpho V2 reserve surface; pending fee shares are part of convertToAssets (previewRedeem). */
export const HybridReserveAbi = parseAbi([
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
  "function totalAssets() view returns (uint256)", "function virtualShares() view returns (uint256)",
  "function accrueInterestView() view returns (uint256 newTotalAssets,uint256 performanceFeeShares,uint256 managementFeeShares)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);
