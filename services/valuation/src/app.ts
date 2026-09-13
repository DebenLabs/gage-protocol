/**
 * HTTP surface (docs/api.md, valuation section): valuation, asset value, suggested range, reinvest / entry / payout
 * quotes, token facts, health. Every handler is a thin parse-and-call over the pure modules; errors are
 * `{ error: { code, message } }` with the status from errors.ts.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import type { ChainReader } from "./chain/reader.js";
import type { Config } from "./config.js";
import { findPool, hasV4, type Deployment } from "./deployment.js";
import { ApiError, badRequest } from "./errors.js";
import type { Explorer } from "./facts/explorer.js";
import { assembleFacts, type TokenFacts } from "./facts/facts.js";
import type { Sampler } from "./facts/sampler.js";
import type { SampleStore } from "./facts/store.js";
import type { Indexer } from "./indexer/client.js";
import { Pricer } from "./pricing/pricer.js";
import { quoteEntry } from "./quote/entry.js";
import { parsePayoutTarget, quotePayout } from "./quote/payout.js";
import { DEFAULT_SLIPPAGE_BPS, quoteReinvest, resolveReinvestPools } from "./quote/reinvest.js";
import { suggestRange } from "./range/suggest.js";
import { parseAddressParam, parseBigintParam, parseIntParam, parseTermParam } from "./util/format.js";
import { valueAsset } from "./valuation/asset.js";
import { valueDeal, valuePosition } from "./valuation/deal.js";
import { quoteLPZap } from "./quote/lpZap.js";
import type { ZapStatus } from "./zap/status.js";
import type { ZapSimulator } from "./zap/simulate.js";
import { mountRatings } from "./ratings/routes.js";
import type { RatingStore } from "./ratings/store.js";
import type { StockLookup } from "./ratings/stocks.js";
import type { ReserveLookup } from "./ratings/reserves.js";

export interface AppDeps {
  ratingStore?: RatingStore;
  ratingStockLookup?: StockLookup;
  ratingReserveLookup?: ReserveLookup;
  zapContexts?: Record<string, {reader: ChainReader; v3Reader?: ChainReader; deployment: Deployment; zapStatus: (reader: ChainReader) => Promise<ZapStatus>}>;
  zapStatus?: (reader: ChainReader) => Promise<ZapStatus>;
  zapSimulator?: ZapSimulator;
  reader: ChainReader;
  pricer: Pricer;
  deployment: Deployment;
  explorer: Explorer;
  indexer: Indexer;
  store: SampleStore;
  sampler: Sampler | null;
  config: Pick<Config, "knownLockers" | "rangeSigmaMultiplier" | "factsTtlMs">;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

interface FactsEntry {
  at: number;
  value: Promise<TokenFacts>;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // The web app runs on another origin (localhost:3000 in dev); allow browsers to read the JSON.
  app.use("*", cors({ origin: (o) => o ?? "*", allowHeaders: ["Content-Type", "x-gage-signature", "x-gage-message"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }));
  mountRatings(app, deps);
  const log = deps.log ?? ((msg: string, extra?: Record<string, unknown>): void => console.log(msg, extra ?? ""));
  const nowMs = deps.now ?? (() => Date.now());
  const factsCache = new Map<Address, FactsEntry>();
  const requestPricing = async (source = deps.reader, deployment = deps.deployment): Promise<{ reader: ChainReader; pricer: Pricer }> => {
    const chainId = await source.chainId();
    if (chainId !== deployment.chainId) {
      throw new ApiError("WRONG_CHAIN", `RPC chain ${chainId} does not match deployment chain ${deployment.chainId}`);
    }
    const reader = await source.snapshot();
    return { reader, pricer: new Pricer(reader, deployment) };
  };
  const zapContext = (engine: string | undefined) => {
    if (!engine) return deps;
    const selected = deps.zapContexts?.[parseAddressParam(engine,"engine").toLowerCase()];
    if (!selected) throw new ApiError("NOT_FOUND","This V2 engine is not published on this service");
    return selected;
  };

  const facts = async (token: Address): Promise<TokenFacts> => {
    const chainId = await deps.reader.chainId();
    if (chainId !== deps.deployment.chainId) {
      throw new ApiError("WRONG_CHAIN", `RPC chain ${chainId} does not match deployment chain ${deps.deployment.chainId}`);
    }
    const hit = factsCache.get(token);
    if (hit !== undefined && nowMs() - hit.at < deps.config.factsTtlMs) return hit.value;
    const value = requestPricing().then(({ reader, pricer }) => assembleFacts(
      { reader, pricer, deployment: deps.deployment, explorer: deps.explorer, indexer: deps.indexer, store: deps.store, knownLockers: deps.config.knownLockers as Address[] }, token
    )).catch((e: unknown) => {
      factsCache.delete(token);
      throw e;
    });
    factsCache.set(token, { at: nowMs(), value });
    return value;
  };

  app.get("/deployment", (c) => c.json({ chainId: deps.deployment.chainId, dealVault: deps.deployment.dealVault,
    registry: deps.deployment.registry, tokens: deps.deployment.tokens, seedTimelock: deps.deployment.seedTimelock, pons: deps.deployment.pons ?? null }));

  app.get("/health", async (c) => {
    const [chainId, block, indexer] = await Promise.all([deps.reader.chainId(), deps.reader.blockNumber(), deps.indexer.health()]);
    const v4 = hasV4(deps.deployment);
    const ok = chainId === deps.deployment.chainId;
    const body = {
      ok,
      chainId,
      block: Number(block),
      deployment: { chainId: deps.deployment.chainId, v4, pools: Object.keys(deps.deployment.pools), positionManager: deps.deployment.positionManager !== null },
      indexer: indexer.value === null ? { ok: false, reason: indexer.reason } : { ok: indexer.value.ok, indexedBlock: indexer.value.indexedBlock },
      sampler: deps.sampler === null ? null : deps.sampler.lastRun,
      samples: deps.store.counts(),
      ...(ok ? {} : { reason: `RPC chain ${chainId} does not match deployment chain ${deps.deployment.chainId}` })
    };
    return ok ? c.json(body) : c.json(body, 503);
  });

  app.get("/deals/:id/valuation", async (c) => {
    const id = parseBigintParam(c.req.param("id"), "deal id", { min: 1n, required: true });
    const pricing = await requestPricing();
    return c.json(await valueDeal(pricing, id!));
  });

  app.get("/assets/:token/value", async (c) => {
    const token = parseAddressParam(c.req.param("token"), "token");
    const pricing = await requestPricing();
    return c.json(await valueAsset(pricing, token));
  });

  app.get("/positions/:tokenId/value", async (c) => {
    const id = parseBigintParam(c.req.param("tokenId"), "position id", { min: 1n, required: true });
    const pricing = await requestPricing();
    const meta = await pricing.reader.tokenMeta(pricing.pricer.usdg);
    return c.json(await valuePosition(pricing, 0n, id!, 0n, meta.decimals));
  });

  app.get("/assets/:token/facts", async (c) => {
    const token = parseAddressParam(c.req.param("token"), "token");
    if (c.req.query("refresh") === "1") factsCache.delete(token);
    return c.json(await facts(token));
  });

  app.get("/range/suggest", async (c) => {
    const poolName = c.req.query("pool") ?? "gageSgage";
    const pool = findPool(deps.deployment, poolName);
    if (pool === null) {
      const code = hasV4(deps.deployment) && Object.keys(deps.deployment.pools).length > 0 ? "NOT_FOUND" : "NO_POOL";
      throw new ApiError(code, `pool ${poolName} is not in the deployment${code === "NO_POOL" ? " yet" : ""}`);
    }
    const termSeconds = parseTermParam(c.req.query("term"));
    const positionValue = parseBigintParam(c.req.query("positionValue"), "positionValue");
    const { pricer } = await requestPricing();
    const state = await pricer.poolState(pool);
    return c.json(await suggestRange({ indexer: deps.indexer, store: deps.store, sigmaMultiplier: deps.config.rangeSigmaMultiplier }, pool, state, termSeconds, positionValue));
  });

  app.get("/zap/pools", async (c) => {
    const context = zapContext(c.req.query("engine"));
    if (!context.zapStatus) return c.json({ enabled: false, reason: "LP creation is not available on this deployment yet.",
      chainId: deps.deployment.chainId, vault: deps.deployment.dealVault, router: null, quoter: null, weth: null, feeBps: 0, terms: [], items: [], routingPools: [] });
    const { reader } = await requestPricing(context.reader, context.deployment);
    return c.json(await context.zapStatus(reader));
  });

  app.get("/quote/lp-zap", async (c) => {
    const context = zapContext(c.req.query("engine"));
    if (!context.zapStatus || !deps.zapSimulator) throw new ApiError("UNSUPPORTED", "LP creation is not available on this deployment yet.");
    const payAsset = c.req.query("payAsset");
    if (payAsset !== "USDG" && payAsset !== "WETH") throw badRequest("payAsset must be USDG or WETH");
    const amount = parseBigintParam(c.req.query("amount"), "amount", { min: 1n, required: true })!;
    const term = parseIntParam(c.req.query("term"), "term", { required: true })!;
    const slippageBps = parseIntParam(c.req.query("slippageBps"), "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;
    const { reader, pricer } = await requestPricing(context.reader, context.deployment);
    const blockNumber = await reader.blockNumber();
    const quote = await quoteLPZap(pricer,
      { indexer: deps.indexer, store: deps.store, sigmaMultiplier: deps.config.rangeSigmaMultiplier }, await context.zapStatus(reader),
      { pool: c.req.query("pool") ?? "", payAsset, amount, term, slippageBps },
      (quoter, params) => deps.zapSimulator!(quoter, params, blockNumber));
    if (BigInt(quote.block) !== blockNumber) throw new ApiError("RPC_ERROR", "LP quote simulation did not use the request block");
    return c.json(quote);
  });

  app.get("/quote/reinvest", async (c) => {
    const amount = parseBigintParam(c.req.query("amount"), "amount", { min: 1n, required: true })!;
    const tickLower = parseIntParam(c.req.query("tickLower"), "tickLower", { required: true })!;
    const tickUpper = parseIntParam(c.req.query("tickUpper"), "tickUpper", { required: true })!;
    const routeRaw = (c.req.query("route") ?? "match").toLowerCase();
    if (routeRaw !== "match" && routeRaw !== "zap") throw badRequest("route must be match or zap");
    const inputRaw = (c.req.query("inputAsset") ?? "sGAGE").toUpperCase();
    if (inputRaw !== "SGAGE" && inputRaw !== "GAGE" && inputRaw !== "ETH" && inputRaw !== "USDG") throw badRequest("inputAsset must be GAGE, sGAGE, ETH or USDG");
    const inputAsset = inputRaw === "SGAGE" ? "sGAGE" : inputRaw;
    const payRaw = (c.req.query("payAsset") ?? "USDG").toUpperCase();
    if (payRaw !== "ETH" && payRaw !== "USDG") throw badRequest("payAsset must be ETH or USDG");
    const slippageBps = parseIntParam(c.req.query("slippageBps"), "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;
    const pools = resolveReinvestPools(deps.deployment);
    const { pricer } = await requestPricing();
    return c.json(await quoteReinvest({ pricer, pools }, { amount, tickLower, tickUpper, inputAsset, route: routeRaw, payAsset: payRaw, slippageBps }));
  });

  app.get("/quote/entry", async (c) => {
    const eth = parseBigintParam(c.req.query("eth"), "eth", { min: 1n, required: true })!;
    const slippageBps = parseIntParam(c.req.query("slippageBps"), "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;
    const { pricer } = await requestPricing();
    return c.json(await quoteEntry(pricer, deps.deployment, eth, slippageBps));
  });

  app.get("/quote/payout", async (c) => {
    const usdg = parseBigintParam(c.req.query("usdg"), "usdg", { min: 1n, required: true })!;
    const to = parsePayoutTarget(c.req.query("to"), deps.deployment);
    const slippageBps = parseIntParam(c.req.query("slippageBps"), "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;
    const { reader, pricer } = await requestPricing();
    return c.json(await quotePayout({ pricer, reader, deployment: deps.deployment }, usdg, to, slippageBps));
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));
  app.onError((e, c) => {
    if (e instanceof ApiError) {
      // 4xx and NO_POOL-class answers are expected; only log server-side faults
      if (e.status >= 500 && e.code !== "NO_POOL" && e.code !== "NO_ROUTE" && e.code !== "NO_LIQUIDITY") log("request_failed", { path: c.req.path, code: e.code, message: e.message });
      return c.json(e.toJSON(), e.status as 400);
    }
    log("request_crashed", { path: c.req.path, error: e.message });
    return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
  });
  return app;
}
