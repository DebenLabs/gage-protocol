// PositionManager NFT helpers: the packed PositionInfo word, the v4 pool id of a PoolKey, and the JSON shape of
// GET /wallet/:address/positions. Pure, so the derivations are testable without a chain.
import { encodeAbiParameters, keccak256 } from "viem";
import type { Address, Hex } from "viem";

import type { PoolDef } from "./deployment";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_POOL_ID: Hex = `0x${"0".repeat(64)}`;

/** The struct `getPoolAndPositionInfo` returns, addresses lowercase. */
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** `PoolId.toId(key)` in v4-core: keccak256(abi.encode(key)). */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const MASK_24 = 0xffffffn;
const TICK_LOWER_OFFSET = 8n;
const TICK_UPPER_OFFSET = 32n;

function int24(x: bigint): number {
  return Number(x >= 0x800000n ? x - 0x1000000n : x);
}

/**
 * Decodes v4-periphery's packed PositionInfo: `200 bits poolId | 24 bits tickUpper | 24 bits tickLower |
 * 8 bits hasSubscriber`, least significant first. A zero word is the empty info of a burned or unknown token.
 */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number; hasSubscriber: boolean } {
  return {
    tickLower: int24((info >> TICK_LOWER_OFFSET) & MASK_24),
    tickUpper: int24((info >> TICK_UPPER_OFFSET) & MASK_24),
    hasSubscriber: (info & 0xffn) !== 0n,
  };
}

/** Whether a PositionInfo word describes a live position (the PositionManager clears it on burn). */
export function isEmptyPositionInfo(info: bigint): boolean {
  return info === 0n;
}

export function poolNameOf(pools: readonly PoolDef[], poolId: Hex): string | null {
  return pools.find((p) => p.poolId === poolId)?.name ?? null;
}

export type NftPositionRowLike = {
  tokenId: bigint;
  poolId: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  tickLower: number;
  tickUpper: number;
};

export type WalletPositionJson = {
  tokenId: string;
  poolId: string;
  poolName: string | null;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  tickLower: number;
  tickUpper: number;
  /** Read from the PositionManager at the latest block, raw uint128 as a decimal string. */
  liquidity: string;
  /** The registry's pool allowlist (CollateralRegistry.PoolSet). */
  allowed: boolean;
  lane: "POSITION";
};

export function formatWalletPosition(
  p: NftPositionRowLike,
  liquidity: bigint,
  allowed: boolean,
  poolName: string | null,
): WalletPositionJson {
  return {
    tokenId: p.tokenId.toString(),
    poolId: p.poolId,
    poolName,
    currency0: p.currency0,
    currency1: p.currency1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: liquidity.toString(),
    allowed,
    lane: "POSITION",
  };
}
