/** Hourly sampler: pool prices and liquidity, plus price and market cap for every non-USDG pool currency. */
import type { Address } from "viem";
import type { ChainReader } from "../chain/reader.js";
import { NATIVE, type Deployment } from "../deployment.js";
import { applyPrice } from "../math/price.js";
import type { Pricer } from "../pricing/pricer.js";
import { priceToDecimal } from "../valuation/deal.js";
import type { SampleStore } from "./store.js";

export class Sampler {
  private timer: NodeJS.Timeout | null = null;
  lastRun: { at: number; ok: boolean; detail: string } | null = null;

  constructor(
    private readonly reader: ChainReader,
    private readonly pricer: Pricer,
    private readonly deployment: Deployment,
    private readonly store: SampleStore,
    private readonly intervalMs: number,
    private readonly log: (msg: string) => void = (m) => console.log(m)
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const at = Math.floor(Date.now() / 1000);
    const pools = Object.values(this.deployment.pools);
    if (pools.length === 0) {
      this.lastRun = { at, ok: true, detail: "no pools in the deployment" };
      return;
    }
    let sampled = 0;
    const errors: string[] = [];
    const tokens = new Set<Address>();
    for (const pool of pools) {
      try {
        const s = await this.pricer.poolState(pool);
        this.store.addPoolSample(pool.poolId, { at, block: Number(s.block), sqrtPriceX96: s.sqrtPriceX96.toString(), liquidity: s.liquidity.toString() });
        sampled += 1;
        for (const c of [pool.currency0, pool.currency1]) if (!this.pricer.aliases(this.pricer.usdg).includes(c)) tokens.add(c);
      } catch (e) {
        errors.push(`${pool.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const usdgDecimals = (await this.reader.tokenMeta(this.pricer.usdg)).decimals;
    for (const token of tokens) {
      try {
        const quote = await this.pricer.priceInUSDG(token);
        const meta = await this.reader.tokenMeta(token);
        const supply = token === NATIVE ? 0n : await this.reader.totalSupply(token);
        this.store.addTokenSample(token, { at, priceUSDG: priceToDecimal(quote.price, meta.decimals, usdgDecimals), mcapUSDG: applyPrice(supply, quote.price).toString() });
        sampled += 1;
      } catch (e) {
        errors.push(`${token}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.store.prune(at);
    try {
      this.store.save();
    } catch (e) {
      errors.push(`save: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.lastRun = { at, ok: errors.length === 0, detail: `${sampled} samples${errors.length > 0 ? "; " + errors.join("; ") : ""}` };
    this.log(`[sampler] ${this.lastRun.detail}`);
  }
}
