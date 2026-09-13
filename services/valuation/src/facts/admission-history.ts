import history from "../history/pons-4663.json" with { type: "json" };
import tendies from "../history/tendies-4663.json" with { type: "json" };
import type { Deployment } from "../deployment.js";
import type { SampleStore } from "./store.js";
import { fractionToDecimal } from "../math/price.js";

// Both reviewed mainnet exports used micro-USDG per token; the hourly sampler writes whole USDG.
function wholeUSDG(raw: string): string {
  const [whole, fraction = ""] = raw.split(".");
  return fractionToDecimal({ num: BigInt(whole! + fraction), den: 10n ** BigInt(fraction.length + 6) }, 0);
}

/** Reviewed block-pinned samples; never fabricate history from today's price. */
export function seedAdmissionHistory(store: SampleStore, deployment: Deployment): void {
  const tendiesPool = Object.values(deployment.pools).find(p => p.poolId === tendies.poolId);
  if (deployment.chainId === tendies.chainId && deployment.usdg === tendies.usdg && tendiesPool?.protocol === "v3"
    && tendiesPool.currency0 === tendies.quoteToken && tendiesPool.currency1 === tendies.token) {
    for (const sample of tendies.samples) store.seedTokenSample(tendies.token, sample, { ...sample, priceUSDG: wholeUSDG(sample.priceUSDG) });
    store.prune(Math.floor(Date.now() / 1000));
    store.save();
  }
  if (deployment.chainId !== history.chainId) return;
  const pool = Object.values(deployment.pools).find(p => p.poolId.toLowerCase() === history.pool.poolId.toLowerCase());
  if (!pool || pool.currency0.toLowerCase() !== history.token || pool.currency1.toLowerCase() !== deployment.usdg.toLowerCase()) return;
  for (const sample of history.samples) store.seedTokenSample(history.token, sample, { ...sample, priceUSDG: wholeUSDG(sample.priceUSDG) });
  store.prune(Math.floor(Date.now() / 1000));
  store.save();
}
