import { Q128, mulDiv, wrappingSub256 } from "./fullMath.js";

/**
 * Uncollected fees owed to a position: (feeGrowthInsideNow - feeGrowthInsideLast) * liquidity / 2^128, with the
 * subtraction wrapping the way v4-core Position.update does.
 */
export function uncollectedFees(feeGrowthInsideNowX128: bigint, feeGrowthInsideLastX128: bigint, liquidity: bigint): bigint {
  return mulDiv(wrappingSub256(feeGrowthInsideNowX128, feeGrowthInsideLastX128), liquidity, Q128);
}
