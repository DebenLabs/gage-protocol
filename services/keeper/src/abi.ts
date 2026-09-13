/**
 * Minimal ABIs, written as human-readable signatures and parsed by viem. They mirror
 * `contracts/src/interfaces/IDealVault.sol`, `FeeSink.sol` and `contracts/src/interfaces/token/*.sol`
 * (final for M6) plus the two Uniswap v4 periphery views the checkpoint job needs.
 * `test/abi.test.ts` checks every selector here against `contracts/out` when a forge build is present.
 */
import { parseAbi } from "viem";

export const dealVaultAbi = parseAbi([
  "struct Deal { address borrower; uint8 kind; uint8 state; uint32 term; uint40 listingExpiry; address token; uint40 fundedAt; uint40 expiry; uint256 amountOrTokenId; uint128 cap; uint128 minPrice; address lender; uint128 price; uint128 fee; }",
  "struct Collateral { uint8 kind; address token; uint256 amountOrTokenId; }",
  "function getDeal(uint256 dealId) view returns (Deal)",
  "function dealCount() view returns (uint256)",
  "function balanceUSDG(address account) view returns (uint256)",
  "function balanceERC20(address account, address token) view returns (uint256)",
  "function openRaw(address token) view returns (uint256)",
  "function GRACE() view returns (uint48)",
  "function list(Collateral c, uint128 cap, uint32 term, uint40 listingExpiry, uint128 minPrice) returns (uint256 dealId)",
  "function fund(uint256 dealId, address lender) returns (uint256 bidId)",
  "function cancel(uint256 dealId)",
  "function reclaim(uint256 dealId)",
  "function withdrawUSDG()",
  "function withdrawERC20(address token)",
  "event Listed(uint256 indexed dealId, address indexed borrower, uint8 kind, address token, uint256 amountOrTokenId, uint128 cap, uint32 term, uint40 listingExpiry, uint128 minPrice)",
  "event Funded(uint256 indexed dealId, uint256 indexed bidId, address indexed lender, uint128 price, uint128 fee, uint40 fundedAt, uint40 expiry)",
  "error NewDealsPaused()",
  "error TermNotAllowed(uint32 term)",
  "error DealNotListed(uint256 dealId)",
  "error DealNotFunded(uint256 dealId)",
  "error NothingToWithdraw()",
]);

/** DealState enum from Types.sol. */
export const DealState = { NONE: 0, LISTED: 1, FUNDED: 2, RECLAIMED: 3, CLAIMED: 4, CANCELLED: 5 } as const;

export const feeSinkAbi = parseAbi([
  "function collect() returns (uint256 amount)",
  "function sweep() returns (uint256 amount)",
  "function route() view returns (uint8)",
  "function buyback() view returns (address)",
  "function vault() view returns (address)",
  "function treasury() view returns (address)",
  "error VaultNotSet()",
  "error BuybackNotSet()",
  "error NothingToSweep()",
]);

export const FeeRoute = { TREASURY: 0, BUYBACK: 1 } as const;

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const dealRewardsAbi = parseAbi([
  "struct EpochRates { uint128 rate7; uint128 rate21; uint128 priceUSDGPerSGAGE; uint16 lenderShareBps; bool set; }",
  "function register(uint256 dealId)",
  "function registered(uint256 dealId) view returns (bool)",
  "function dripIdOf(uint256 dealId, address party) pure returns (bytes32)",
  "function owner() view returns (address)",
  "function EMISSIONS() view returns (address)",
  "function epochRates(uint256 epoch) view returns (EpochRates)",
  "function USDG_UNIT() pure returns (uint256)",
  "function MAX_REWARD_SHARE_BPS() pure returns (uint16)",
  "function effectiveRates(uint256 epoch) view returns (EpochRates)",
  "function setEpochRates(uint256 epoch, uint128 rate7, uint128 rate21, uint128 priceUSDGPerSGAGE, uint16 lenderShareBps)",
  "error AlreadyRegistered(uint256 dealId)",
  "error DealNotFunded(uint256 dealId)",
  "error RatesForPastEpoch(uint256 epoch)",
  "error InvalidRates()",
]);

export const emissionsAbi = parseAbi([
  "function WEEKS() pure returns (uint256)",
  "function EPOCH() pure returns (uint256)",
  "function RESERVE() pure returns (uint256)",
  "function totalOut() view returns (uint256)",
  "function launchAt() view returns (uint40)",
  "function currentEpoch() view returns (uint256)",
  "function epochStart(uint256 epoch) view returns (uint40)",
  "function scheduleOver() view returns (bool)",
  "function liquidityBudget(uint256 epoch) view returns (uint256)",
  "function dealBudget(uint256 epoch, uint32 term) view returns (uint256)",
  "function remaining(uint256 epoch, uint32 term) view returns (uint256)",
  "function released(uint256 epoch) view returns (bool)",
  "function rolledOver(uint256 epoch) view returns (bool)",
  "function release(uint256 epoch)",
  "function rollover(uint256 epoch)",
  "function finalize()",
  "error NotLaunched()",
  "error EpochNotStarted(uint256 epoch)",
  "error EpochNotEnded(uint256 epoch)",
  "error EpochOutOfRange(uint256 epoch)",
  "error EpochAlreadyReleased(uint256 epoch)",
  "error EpochNotReleased(uint256 epoch)",
  "error EpochAlreadyRolledOver(uint256 epoch)",
  "error ScheduleNotOver()",
  "error TermNotRewarded(uint32 term)",
]);

export const lpRewardsAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function checkpoint(uint256 tokenId)",
  "function checkpointMany(uint256[] tokenIds)",
  "function poolKey() view returns (PoolKey)",
  "function totalWeight() view returns (uint256)",
  "function seedTokenId() view returns (uint256)",
  "function positionState(uint256 tokenId) view returns ((uint256 weight,uint256 emissionsPerWeightPaid,uint256 lumpPerWeightPaid,uint256 emissionsEarned,uint256 lumpEarned,uint40 lastCheckpoint,uint32 collectNonce))",
  "event Checkpointed(uint256 indexed tokenId,uint256 weight,uint256 totalWeight,bool inRange)",
  "error WrongPool(uint256 tokenId)",
]);

/** ILPStreamer (D64): the second sGAGE stream for GAGE/sGAGE positions, read from LPRewards accrual. */
export const lpStreamerAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function checkpoint(uint256 tokenId)",
  "function checkpointMany(uint256[] tokenIds)",
  "function collect(uint256 tokenId) returns (uint256 amount)",
  "function earned(uint256 tokenId) view returns (uint256)",
  "function pending() view returns (uint256)",
  "function pot(uint256 epoch) view returns (uint256)",
  "function rate(uint256 epoch) view returns (uint256)",
  "function assignedThrough() view returns (uint256)",
  // A collect opens a 7-day drip on the streamer's own Drip (`LPStreamerDrip` in the deployment json).
  "function DRIP() view returns (address)",
  "function DRIP_LENGTH() view returns (uint32)",
  "function dripIdOf(uint256 tokenId, uint32 collectNonce) pure returns (bytes32)",
  "event Deposited(address indexed from, uint256 amount, uint256 indexed forEpoch)",
  "event PotFixed(uint256 indexed epoch, uint256 pot, uint256 rate)",
  "event Checkpointed(uint256 indexed tokenId, uint256 accrual, uint256 credit, uint256 epoch)",
  "event Collected(uint256 indexed tokenId, address indexed owner, uint256 amount, bytes32 dripId)",
  "error ScheduleOver()",
  "error NotOwner(uint256 tokenId, address caller)",
  "error NothingToCollect(uint256 tokenId)",
]);

/** IDrip: the deposit job claims the backstop's unlocked deal drips (keyed `keccak256(abi.encode("deal", dealId, party))`). */
export const dripAbi = parseAbi([
  "function claim(bytes32 dripId) returns (uint128 amount)",
  "function claimMany(bytes32[] dripIds) returns (uint128 amount)",
  "function claimable(address account, bytes32 dripId) view returns (uint128)",
  "function unlocked(address account, bytes32 dripId) view returns (uint128)",
  "error NoDrip(address account, bytes32 dripId)",
  "error NothingClaimable()",
]);

/** ICollateralRegistry: what the backstop deal has to satisfy before `list` and `fund` are attempted. */
export const collateralRegistryAbi = parseAbi([
  "struct ERC20Config { bool allowed; uint8 lane; uint256 minAmount; uint256 maxDealRaw; uint256 maxOpenRaw; }",
  "function getERC20Config(address token) view returns (ERC20Config)",
  "function isTermAllowed(uint32 term) view returns (bool)",
  "function feeBps() view returns (uint16)",
  "function newDealsPaused() view returns (bool)",
]);

export const buybackAbi = parseAbi([
  "function buyback(uint256 clipUSDG) returns (uint256 burned)",
  "function threshold() view returns (uint256)",
  "function MAX_IMPACT_BPS() pure returns (uint16)",
  "error BelowThreshold(uint256 balance, uint256 threshold)",
  "error ClipTooLarge(uint256 clip, uint256 maxClip)",
  "error TooLittleOut(uint256 got, uint256 minOut)",
  "error TooMuchIn(uint256 paid, uint256 maxIn)",
]);

export const creatorFeeSplitterAbi = parseAbi([
  "function claim() returns (uint256)",
  "function split() returns (uint256 sgageToLPs)",
  "function threshold() view returns (uint256)",
  "error BelowThreshold(uint256 balance, uint256 threshold)",
]);

/** Uniswap v4 PositionManager (ERC-721; salt == tokenId). PositionInfo is a packed uint256 we do not decode. */
export const positionManagerAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey, uint256)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function nextTokenId() view returns (uint256)",
]);

/** The one PoolManager event the swap watcher needs (Uniswap v4 core). */
export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
