import { parseAbi } from "viem";

/** Minimal permissionless Earn worker surface (D82 pooled shares), checked against compiler artifacts by abi.test.ts. */
export const earnAbi = parseAbi([
  "function settle(uint256[] ids)", "function markOverdue(uint256[] ids)", "function harvestCash()", "function harvestRewards(uint256[] ids)",
  "function serveRequests(uint256 maxRequests,uint256 maxAssets)", "function investReserve(uint256 assets,uint256 minShares) returns (uint256 shares)",
  "function fund(uint256 id,uint256 maxReserveShares)",
  "error InvalidAmount()", "error ApprovalExpired()", "error LimitExceeded()", "error InsufficientLiquidity()", "error RequestsPending()",
  "error Slippage()", "error IneligibleDeal(uint256 id)", "error PausedError()", "error UnknownDeal()", "error TransferAmountMismatch()",
]);
/** The engine's sGAGE ledger: released lender rewards the strategy may harvest per loan. */
export const earnCoreRewardsAbi = parseAbi([
  "function claimable(uint256 id,address account) view returns (uint256)",
]);
/** The Gage V2 engine: anyone may release an expired funding window, which turns the strategy's units into cash credit. */
export const earnCoreAbi = parseAbi([
  "function cancelFunding(uint256 id)", "function cashCredit(address account) view returns (uint256)",
  "error WrongState()", "error NotAuthorized()",
]);
export const earnReadAbi = parseAbi([
  "function previewWithdraw(uint256 assets) view returns (uint256)", "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)", "function maxWithdraw(address owner) view returns (uint256)",
  "function cashCredit(address account) view returns (uint256)", "function claimable(uint256 id,address account) view returns (uint256)",
]);
