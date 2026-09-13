import type { Address } from "viem";
import { ApiError } from "./errors";

/** Explorer discovery supplies candidates only; ownerOf, pool ID and liquidity are always read on chain. */
export async function explorerNftIds(base: string, wallet: Address, manager: Address, fetcher: typeof fetch = fetch): Promise<string[]> {
  const ids = new Set<string>(), cursors = new Set<string>();
  let query = new URLSearchParams({type:"ERC-721"});
  const deadline = Date.now() + 15_000;
  for (let page = 0; page < 20; page++) {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new ApiError(503,"NFT_DISCOVERY_UNAVAILABLE","NFT discovery timed out; retry shortly.");
    const response = await fetcher(`${base.replace(/\/$/,"")}/addresses/${wallet}/nft?${query}`, {signal:AbortSignal.timeout(ms)});
    if (!response.ok) throw new ApiError(503,"NFT_DISCOVERY_UNAVAILABLE","NFT discovery is unavailable; retry shortly.");
    const body = await response.json() as {items?: {id?: string; token?: {address_hash?: string}}[]; next_page_params?: Record<string,unknown> | null};
    if (!Array.isArray(body.items)) throw new ApiError(503,"NFT_DISCOVERY_UNAVAILABLE","Invalid NFT discovery response.");
    for (const item of body.items) if (item.token?.address_hash?.toLowerCase() === manager.toLowerCase()) {
      if (!item.id || !/^[1-9][0-9]*$/.test(item.id) || BigInt(item.id) >= 1n << 256n) throw new ApiError(503,"NFT_DISCOVERY_UNAVAILABLE","Invalid NFT identifier.");
      ids.add(item.id);
    }
    if (!body.next_page_params) return [...ids];
    query = new URLSearchParams({type:"ERC-721"});
    for (const [k,v] of Object.entries(body.next_page_params)) {
      if (typeof v !== "string" && typeof v !== "number") throw new ApiError(503,"NFT_DISCOVERY_UNAVAILABLE","Invalid NFT page cursor.");
      query.set(k,String(v));
    }
    const cursor=query.toString();
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  throw new ApiError(503,"NFT_DISCOVERY_UNAVAILABLE","NFT discovery is incomplete; retry shortly.");
}
