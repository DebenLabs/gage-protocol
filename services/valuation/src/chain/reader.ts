/**
 * Every chain read the service needs, behind one interface so tests can substitute a fake. Amounts are BigInt.
 */
import type { Address, Hex } from "viem";
import type { PoolKey } from "../deployment.js";

export type Kind = "ERC20" | "UNIV4_POSITION" | "UNIV3_POSITION";
export type DealState = "NONE" | "LISTED" | "FUNDED" | "RECLAIMED" | "CLAIMED" | "CANCELLED";
export type Lane = "STOCK" | "ETH" | "MEME";

export const KIND_NAMES: readonly Kind[] = ["ERC20", "UNIV4_POSITION", "UNIV3_POSITION"];
export const STATE_NAMES: readonly DealState[] = ["NONE", "LISTED", "FUNDED", "RECLAIMED", "CLAIMED", "CANCELLED"];
export const LANE_NAMES: readonly Lane[] = ["STOCK", "ETH", "MEME"];

export interface Deal {
  id: bigint;
  borrower: Address;
  kind: Kind;
  state: DealState;
  term: number;
  listingExpiry: number;
  token: Address;
  fundedAt: number;
  expiry: number;
  amountOrTokenId: bigint;
  cap: bigint;
  minPrice: bigint;
  lender: Address;
  price: bigint;
  /** Protocol fee credited at settlement (raw USDG). Trailing field added to the Deal struct after the first pass. */
  fee: bigint;
}

export interface ERC20Config {
  allowed: boolean;
  lane: Lane;
  minAmount: bigint;
  maxDealRaw: bigint;
  maxOpenRaw: bigint;
}

export interface TokenMeta {
  symbol: string;
  name: string;
  decimals: number;
}

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

export interface PositionInfo {
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  hasSubscriber: boolean;
  liquidity: bigint;
  owner: Address | null;
}

export interface PositionFeeState {
  tokensOwed0?: bigint;
  tokensOwed1?: bigint;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
}

export interface PoolPosition {
  tokenId: bigint;
  owner: Address | null;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

export interface TransferProbeResult {
  ok: boolean;
  sentDelta: bigint;
  receivedDelta: bigint;
}

export interface PonsCurveState {
  graduated: boolean;
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  sellableTokens: bigint;
  feeBps: number;
  block: bigint;
}

export interface ChainReader {
  /** Immutable view fixed to one current block for one economic request. */
  snapshot(): Promise<ChainReader>;
  ponsCurve(curve: Address): Promise<PonsCurveState>;
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  blockTimestamp(block: bigint): Promise<number>;
  getDeal(id: bigint): Promise<Deal | null>;
  getERC20Config(token: Address): Promise<ERC20Config>;
  /** Optional for legacy readers; missing reader retains the stock-only policy. */
  memePairMask?(): Promise<number>;
  tokenMeta(token: Address): Promise<TokenMeta>;
  totalSupply(token: Address, block?: bigint): Promise<bigint>;
  getCode(address: Address): Promise<Hex>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex>;
  /** `paused()` if the token has it; null when the call reverts or the selector is absent. */
  paused(token: Address): Promise<boolean | null>;
  slot0(poolId: Hex): Promise<Slot0 | null>;
  liquidity(poolId: Hex): Promise<bigint>;
  feeGrowthInside(poolId: Hex, tickLower: number, tickUpper: number): Promise<{ inside0: bigint; inside1: bigint }>;
  positionFeeState(poolId: Hex, owner: Address, tickLower: number, tickUpper: number, salt: Hex): Promise<PositionFeeState>;
  position(tokenId: bigint): Promise<PositionInfo | null>;
  /** Block and timestamp of the pool's Initialize event, null if not found. */
  poolInitialised(poolId: Hex): Promise<{ block: bigint; timestamp: number } | null>;
  /** Every PositionManager position ever added to the pool (from ModifyLiquidity salts), with current owner and liquidity. */
  poolPositions(poolId: Hex): Promise<PoolPosition[]>;
  /** Unix time a timelock-like contract releases (unlockTime(), releaseTime(), unlockAt(), end()); null if none answers sensibly. */
  unlockTime(owner: Address): Promise<number | null>;
  /** Simulate a transfer from `holder` with the probe injected at the holder's address; null if the node rejects state overrides. */
  probeTransfer(token: Address, holder: Address, to: Address, amount: bigint): Promise<TransferProbeResult | null>;
}
