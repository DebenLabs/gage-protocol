import type { Address, Hex } from "viem";
import { amountsForLiquidity } from "./pool";
import { PriceGraph, type PoolPrice } from "./stats";

export type TvlPool = PoolPrice & { poolId: Hex };
export type TvlPosition = { poolId: Hex; tickLower: number; tickUpper: number; liquidity: bigint };

/** Principal actually held in every range, including inactive/one-sided positions. Never virtual reserves. */
export function poolPrincipal(pool: TvlPool, positions: readonly TvlPosition[]) {
  let amount0 = 0n, amount1 = 0n;
  for (const position of positions) {
    if (position.poolId !== pool.poolId || position.liquidity === 0n) continue;
    if (position.liquidity < 0n || pool.sqrtPriceX96 <= 0n) throw new Error("Invalid indexed liquidity");
    const amounts = amountsForLiquidity(pool.sqrtPriceX96, position.tickLower, position.tickUpper, position.liquidity);
    amount0 += amounts.amount0;
    amount1 += amounts.amount1;
  }
  return { amount0, amount1 };
}

/** Missing prices stay missing. A borrower-selected repayment cap is never an asset valuation. */
export function principalValue(pool: TvlPool, position: TvlPosition, graph: PriceGraph, usdg: Address): bigint | null {
  const amounts = poolPrincipal(pool, [position]);
  const v0 = amounts.amount0 === 0n ? 0n : graph.value(amounts.amount0, pool.currency0, usdg);
  const v1 = amounts.amount1 === 0n ? 0n : graph.value(amounts.amount1, pool.currency1, usdg);
  return v0 === null || v1 === null ? null : v0 + v1;
}

/** Owner, range and salt together identify a v4 position; salt alone is not globally unique. */
export function liquidityPositionId(poolId: Hex, owner: Address, tickLower: number, tickUpper: number, salt: Hex): string {
  return `${poolId.toLowerCase()}:${owner.toLowerCase()}:${tickLower}:${tickUpper}:${salt.toLowerCase()}`;
}


type DealRow = {
  id: bigint; kind: string; token: Address; amountOrTokenId: bigint; listedAt: bigint; settledAt: bigint | null;
  state: string; price: bigint | null;
};
type BidRow = { price: bigint; placedAt: bigint; closedAt: bigint | null };
type Credit = { kind: string; asset: Address; account: Address; amount: bigint };
type PoolAt = TvlPool;
const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n);

export const liveAt = (d: DealRow, t: bigint): boolean => d.listedAt <= t && (d.settledAt === null || d.settledAt > t);
const escrowedAt = (b: BidRow, t: bigint): boolean => b.placedAt <= t && (b.closedAt === null || b.closedAt > t);

type Tvl = {
  collateral: bigint; bids: bigint; pool: bigint; withdrawable: bigint; outstandingLoans: bigint; unpriced: number;
  poolBalances: { token: string; amount: string }[]; byToken: Map<Address, bigint>; priced: Map<bigint, bigint>;
};

export function calculateTvl(
  allDeals: DealRow[], allBids: BidRow[], pools: PoolAt[], usdg: Address, t: bigint,
  positions: TvlPosition[], credits: Credit[], nftValues: Map<string, bigint | null>, feeSink: Address, ourPoolId?: Hex,
  wrappedNative?: Address,
): Tvl {
  const graph = new PriceGraph(pools, wrappedNative);
  const byToken = new Map<Address, bigint>();
  const priced = new Map<bigint, bigint>();
  const poolBalances: Tvl["poolBalances"] = [];
  let collateral = 0n, withdrawable = 0n, unpriced = 0;
  for (const d of allDeals) {
    if (!liveAt(d, t)) continue;
    const value = d.kind === "ERC20" ? graph.value(d.amountOrTokenId, d.token, usdg) : nftValues.get(`${d.token}:${d.amountOrTokenId}`) ?? null;
    if (value === null) { unpriced++; continue; }
    priced.set(d.id, value);
    collateral += value;
    byToken.set(d.token, (byToken.get(d.token) ?? 0n) + value);
  }
  for (const b of credits) {
    if (b.amount <= 0n || b.account === feeSink) continue;
    const value = b.kind === "NFT" ? nftValues.get(`${b.asset}:${b.amount}`) ?? null : graph.value(b.amount, b.asset, usdg);
    if (value === null) { unpriced++; continue; }
    withdrawable += value;
  }
  // The product's headline includes funded loan exposure as well as assets still held.
  // Count principal once per outstanding deal; never cumulative funding, repayment caps or settled loans.
  const outstandingLoans = sum(allDeals.filter(d => liveAt(d, t) && d.state === "FUNDED").map(d => d.price ?? 0n));
  const bidEscrow = sum(allBids.filter((b) => escrowedAt(b, t)).map((b) => b.price));
  let pool = 0n;
  if (ourPoolId !== undefined) {
    const ours = pools.find(p => p.poolId === ourPoolId);
    if (ours) {
      const amounts = poolPrincipal(ours, positions);
      for (const [token, amount] of [[ours.currency0, amounts.amount0], [ours.currency1, amounts.amount1]] as const) {
        poolBalances.push({ token, amount: amount.toString() });
        if (amount === 0n) continue;
        const value = graph.value(amount, token, usdg);
        if (value === null) unpriced++;
        else pool += value;
      }
    } else if (positions.some(p => p.liquidity > 0n)) unpriced++;
  }
  return { collateral, bids: bidEscrow, pool, withdrawable, outstandingLoans, unpriced, poolBalances, byToken, priced };
}
