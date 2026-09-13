/** GET /assets/:token/value: spot price of one whole token in USDG through the deepest pool route. */
import type { Address } from "viem";
import type { ChainReader } from "../chain/reader.js";
import type { Pricer } from "../pricing/pricer.js";
import { nowSeconds } from "../util/format.js";
import { priceToDecimal, type Source } from "./deal.js";

export interface AssetValue {
  token: Address;
  symbol: string;
  decimals: number;
  priceUSDG: string;
  /** USDG raw per token raw as an exact fraction, for clients that want to scale amounts without float error. */
  priceRaw: { num: string; den: string };
  source: Source;
  at: number;
}

export async function valueAsset(deps: { reader: ChainReader; pricer: Pricer }, token: Address): Promise<AssetValue> {
  const [quote, meta, usdgMeta] = await Promise.all([deps.pricer.priceInUSDG(token), deps.reader.tokenMeta(token), deps.reader.tokenMeta(deps.pricer.usdg)]);
  return {
    token,
    symbol: meta.symbol,
    decimals: meta.decimals,
    priceUSDG: priceToDecimal(quote.price, meta.decimals, usdgMeta.decimals),
    priceRaw: { num: quote.price.num.toString(), den: quote.price.den.toString() },
    source: { kind: quote.kind, pools: quote.pools, asOfBlock: Number(quote.block) },
    at: nowSeconds()
  };
}
