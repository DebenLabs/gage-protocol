/** Identity only: the issuer registry does not establish a company's credit rating or an exit price. */
export type StockIdentity = { kind: "stock"; symbol: string; active: boolean; checkedAt: number }
  | { kind: "other" } | { kind: "unavailable" };
export type StockLookup = (chainId: number, token: string) => Promise<StockIdentity>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Exact chain/address matches only. Share concurrent requests and never extend stale identity evidence. */
export function stockLookup(fetcher: typeof fetch = fetch, now: () => number = Date.now): StockLookup {
  let cached: { expiresAt: number; value: Promise<Map<string, StockIdentity> | null> } | undefined;
  return async (chainId, token) => {
    if (chainId !== 4663) return { kind: "other" };
    if (!cached || cached.expiresAt <= now()) {
      const entry = { expiresAt: Infinity, value: Promise.resolve<Map<string, StockIdentity> | null>(null) };
      entry.value = (async () => {
        try {
          const response = await fetcher("https://api.robinhood.com/rhj/assets", { signal: AbortSignal.timeout(4000) });
          if (!response.ok) throw new Error("Stock registry unavailable");
          const body: unknown = await response.json();
          if (!record(body) || !Array.isArray(body.assets) || !body.assets.length || body.assets.length > 10_000) throw new Error("Invalid stock registry");
          const assets = new Map<string, StockIdentity>();
          const checkedAt = Math.floor(now() / 1000);
          for (const a of body.assets) {
            if (!record(a) || typeof a.tokenSymbol !== "string" || !a.tokenSymbol || a.tokenSymbol.length > 40 || !Array.isArray(a.deployments)
              || !["ASSET_STATUS_ACTIVE", "ASSET_STATUS_INACTIVE"].includes(String(a.status))) continue;
            for (const d of a.deployments) {
              if (!record(d) || d.chainId !== 4663 || typeof d.contractAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(d.contractAddress)) continue;
              assets.set(d.contractAddress.toLowerCase(), { kind: "stock", symbol: a.tokenSymbol, active: a.status === "ASSET_STATUS_ACTIVE", checkedAt });
            }
          }
          if (!assets.size) throw new Error("Empty stock registry");
          entry.expiresAt = now() + 300_000;
          return assets;
        } catch {
          entry.expiresAt = now() + 15_000;
          return null;
        }
      })();
      cached = entry;
    }
    const assets = await cached.value;
    return assets ? assets.get(token.toLowerCase()) ?? { kind: "other" } : { kind: "unavailable" };
  };
}
