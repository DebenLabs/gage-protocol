import type { Pool } from "../deployment.js";
import type { Fraction } from "../math/price.js";

export type ReportedReserves = { amount0: number; amount1: number; createdAt: number | null; checkedAt: number };
export type ReserveLookup = (chainId: number, pool: Pool) => Promise<ReportedReserves | null>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const canonical = (s: string) => s.toLowerCase().replace(/^0x0{24}([a-f0-9]{40})$/, "0x$1");
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e21;

/** Reported token quantities, never the provider's USD price. Exact pair and both currencies must match. */
export function reserveLookup(fetcher: typeof fetch = fetch, now: () => number = Date.now): ReserveLookup {
  const cache = new Map<string, { expiresAt: number; value: Promise<ReportedReserves | null> }>();
  return async (chainId, pool) => {
    if (chainId !== 4663) return null;
    const key = `${pool.poolId}:${pool.currency0}:${pool.currency1}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    const entry = { expiresAt: Infinity, value: Promise.resolve<ReportedReserves | null>(null) };
    entry.value = (async () => {
      let result: ReportedReserves | null = null;
      try {
        const response = await fetcher(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${canonical(pool.poolId)}`, { signal: AbortSignal.timeout(5000) });
        const body: unknown = response.ok ? await response.json() : null;
        if (record(body) && Array.isArray(body.pairs)) {
          for (const p of body.pairs.slice(0, 100)) {
            if (!record(p) || p.chainId !== "robinhood" || typeof p.pairAddress !== "string" || canonical(p.pairAddress) !== canonical(pool.poolId)
              || !record(p.baseToken) || !record(p.quoteToken) || !record(p.liquidity)) continue;
            const base = String(p.baseToken.address).toLowerCase(), quote = String(p.quoteToken.address).toLowerCase();
            const forward = base === pool.currency0 && quote === pool.currency1;
            if (!forward && !(base === pool.currency1 && quote === pool.currency0)) continue;
            if (!amount(p.liquidity.base) || !amount(p.liquidity.quote)) continue;
            const createdAt = typeof p.pairCreatedAt === "number" && p.pairCreatedAt > 0 && p.pairCreatedAt <= now() ? Math.floor(p.pairCreatedAt / 1000) : null;
            result = { amount0: forward ? p.liquidity.base : p.liquidity.quote, amount1: forward ? p.liquidity.quote : p.liquidity.base, createdAt, checkedAt: Math.floor(now() / 1000) };
            break;
          }
        }
      } catch { /* An optional source cannot break an assessment or any transaction. */ }
      entry.expiresAt = now() + (result ? 300_000 : 30_000);
      return result;
    })();
    cache.set(key, entry);
    return entry.value;
  };
}

/** Provider quantities are approximate. Convert them with exact local raw-unit prices, never USD=USDG. */
export function valueReportedAmount(value: number, decimals: number, price: Fraction): bigint {
  if (!amount(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Invalid reported quantity");
  const [whole, fraction = ""] = value.toFixed(Math.min(decimals, 18)).split(".");
  const raw = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  return raw * price.num / price.den;
}
