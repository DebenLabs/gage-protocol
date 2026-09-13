// `GET /price`: the GAGE price for the header ticker, in USDG per whole GAGE through the indexed pools (GAGE/ETH,
// then ETH/USDG on mainnet), with the last day as hourly points and the change over it. Cheap enough to poll from
// every page: one read of the pool table, then only the pools on GAGE's route and their day of swaps.
import { db } from "ponder:api";
import { poolState, swaps, vaultConstants } from "ponder:schema";
import { and, asc, eq, gt, inArray } from "ponder";

import { formatWad } from "../lib/pool";
import { DAY, HOUR, PriceGraph, changeBps, replayPrices, scaleDecimals } from "../lib/stats";
import { poolsAt } from "./stats";
import { deployment } from "./views";

/** GAGE, like sGAGE, has 18 decimals (the Pons launch token). */
const GAGE_DECIMALS = 18;

export type GagePriceJson = {
  /** USDG per whole GAGE as a decimal string; null while no pool route prices GAGE. */
  usdgPerGage: string | null;
  /** The change against the price a day ago, in basis points; null without a day of history. */
  change24hBps: number | null;
  /** Hourly points over the last day, oldest first, ending with the current price. */
  history24h: { t: number; price: string }[];
};

const NONE: GagePriceJson = { usdgPerGage: null, change24hBps: null, history24h: [] };

export async function buildGagePrice(now: bigint): Promise<GagePriceJson> {
  const gage = deployment.token.GAGE;
  if (gage === undefined) return NONE;
  const [poolRows, consts] = await Promise.all([
    db.select().from(poolState),
    db.select().from(vaultConstants).where(eq(vaultConstants.id, "vault")).then((r) => r[0]),
  ]);
  const usdg = consts?.usdg ?? deployment.m1.USDG;
  const usdgDecimals = consts?.usdgDecimals ?? 18;
  const weth = deployment.token.WETH;
  const graphNow = new PriceGraph(poolRows, weth);
  const route = graphNow.route(gage, usdg);
  const priceNow = graphNow.priceWad(gage, usdg);
  if (route === null || route.length === 0 || priceNow === null) return NONE;

  const dayAgo = now - DAY;
  const ids = route.map((p) => p.poolId);
  const [start, swapRows] = await Promise.all([
    poolsAt(route, dayAgo),
    db
      .select({ poolId: swaps.poolId, at: swaps.at, sqrtPriceX96: swaps.sqrtPriceX96 })
      .from(swaps)
      .where(and(inArray(swaps.poolId, ids), gt(swaps.at, dayAgo)))
      .orderBy(asc(swaps.at), asc(swaps.id)),
  ]);
  const times: bigint[] = [];
  for (let t = dayAgo; t < now; t += HOUR) times.push(t);
  times.push(now);
  const series = replayPrices(start, swapRows, times, (pools) => new PriceGraph(pools, weth).priceWad(gage, usdg));
  const display = (wad: bigint): string => formatWad(scaleDecimals(wad, GAGE_DECIMALS, usdgDecimals));
  const first = series[0];
  return {
    usdgPerGage: display(priceNow),
    change24hBps: first === undefined ? null : changeBps(priceNow, first.priceWad),
    history24h: series.map((pt) => ({ t: Number(pt.t), price: display(pt.priceWad) })),
  };
}
