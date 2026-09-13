/** Rounded-down amounts for the immutable seed's [-887220,887220] range.
 * Bounds are TickMath.getSqrtPriceAtTick at those ticks, as used by CompoundingSeedTimelock.
 * Only liquidity guaranteed by the compound call is valued; unmatched fee balances are excluded.
 */
const LOWER = 4306310044n;
const UPPER = 1457652066949847389969617340386294118487833376468n;
const Q96 = 1n << 96n;
export function seedAmounts(liquidity: bigint, price: bigint): { amount0: bigint; amount1: bigint } {
  if (liquidity <= 0n || price <= 0n) return {amount0:0n,amount1:0n};
  const p = price < LOWER ? LOWER : price > UPPER ? UPPER : price;
  return {
    amount0: liquidity * Q96 * (UPPER - p) / UPPER / p,
    amount1: liquidity * (p - LOWER) / Q96,
  };
}
export function seedGageValue(liquidity: bigint, price: bigint, gageIs0: boolean): bigint {
  if (price <= 0n) return 0n;
  const {amount0,amount1}=seedAmounts(liquidity,price);
  return gageIs0 ? amount0 + amount1 * Q96 * Q96 / (price * price)
    : amount1 + amount0 * price * price / (Q96 * Q96);
}
