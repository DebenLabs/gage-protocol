// Pure derivations shared by the handlers and the API. Amounts are bigint raw units; timestamps are unix seconds.

export const BPS = 10_000n;

export const KIND_BY_INDEX = ["ERC20", "UNIV4_POSITION", "UNIV3_POSITION"] as const;
export type KindName = (typeof KIND_BY_INDEX)[number];

/** Solidity `Lane` enum order (Types.sol). */
export const LANE_BY_INDEX = ["STOCK", "ETH", "MEME"] as const;
export type AssetLane = (typeof LANE_BY_INDEX)[number];
export type DealLane = AssetLane | "POSITION";

export const FEE_ROUTE_BY_INDEX = ["TREASURY", "BUYBACK"] as const;
export type FeeRoute = (typeof FEE_ROUTE_BY_INDEX)[number];

export function kindFromIndex(i: number): KindName {
  const kind = KIND_BY_INDEX[i];
  if (kind === undefined) throw new Error(`unknown Kind ${i}`);
  return kind;
}

export function laneFromIndex(i: number): AssetLane {
  const lane = LANE_BY_INDEX[i];
  if (lane === undefined) throw new Error(`unknown Lane ${i}`);
  return lane;
}

export function feeRouteFromIndex(i: number): FeeRoute {
  const route = FEE_ROUTE_BY_INDEX[i];
  if (route === undefined) throw new Error(`unknown Route ${i}`);
  return route;
}

/**
 * The deal's lane for the app: POSITION for a v4 position, otherwise the registry lane of the collateral token.
 * A token without an `ERC20Set` row cannot be listed, so the STOCK fallback only guards a partial backfill.
 */
export function dealLane(kind: KindName, assetLane: DealLane | undefined): DealLane {
  if (kind !== "ERC20") return "POSITION";
  return assetLane ?? "STOCK";
}

/** Fixed cost for the term in basis points of the price: what the borrower pays above what they received. */
export function costBps(cap: bigint, price: bigint): bigint {
  if (price <= 0n) return 0n;
  return ((cap - price) * BPS) / price;
}

/** Deadlines are exclusive (D6): expired once `now >= deadline`. */
export function isExpired(deadline: bigint, now: bigint): boolean {
  return now >= deadline;
}

export function graceEnd(expiry: bigint, grace: bigint): bigint {
  return expiry + grace;
}

export type BidLike = { id: bigint; price: bigint; expiry: bigint; state: string };

/** Highest OPEN, unexpired bid; the earliest bid wins a tie so the answer is stable between blocks. */
export function bestBid<T extends BidLike>(bids: readonly T[], now: bigint): T | null {
  let best: T | null = null;
  for (const b of bids) {
    if (b.state !== "OPEN" || isExpired(b.expiry, now)) continue;
    if (best === null || b.price > best.price || (b.price === best.price && b.id < best.id)) best = b;
  }
  return best;
}

export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function clampZero(v: bigint): bigint {
  return v < 0n ? 0n : v;
}
