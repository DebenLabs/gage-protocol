import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Address } from "viem";
import type { AppDeps } from "../app.js";
import { ApiError } from "../errors.js";
import { assembleFacts, type TokenFacts } from "../facts/facts.js";
import { poolIdOf, type Pool } from "../deployment.js";
import { Pricer } from "../pricing/pricer.js";
import { buildPositionModel, positionValueAt, sqrtPriceForAssetMove, valuePosition } from "../valuation/deal.js";
import { parseAddressParam } from "../util/format.js";
import { realisedVolatility } from "../math/stats.js";
import { assessMarket, conservativeDepth, coverageGrade, headroom, headroomGrade, horizonSigma, MODEL, slice, stressScenarios, stressShocks, stressVolatility, worse,
  type MarketRating, type StressVolatility } from "./model.js";
import { stockLookup } from "./stocks.js";
import { reserveLookup, valueReportedAmount } from "./reserves.js";

/** Two days, the grace both published engines use; an engine that publishes its own grace overrides it. */
const DEFAULT_GRACE = 172_800;

export function mountRatings(app: Hono, deps: AppDeps): void {
  const cache = new Map<string, { at: number; value: Promise<TokenFacts> }>();
  const now = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const lookupStock = deps.ratingStockLookup ?? stockLookup();
  const lookupReserves = deps.ratingReserveLookup ?? reserveLookup();
  app.get("/ratings/assessment", async c => {
    const q = c.req.query();
    if (c.req.url.length > 2048) throw new ApiError("BAD_REQUEST", "Rating request is too long");
    const fields = new Set(["engine", "token", "poolId", "collateral", "principal", "repayment", "term", "mode", "ask", "mask", "loanId", "endAt"]);
    if (Object.keys(q).some(key => !fields.has(key))) throw new ApiError("BAD_REQUEST", "Unknown rating field");
    const engine = q.engine ? parseAddressParam(q.engine, "engine") : deps.deployment.dealVault;
    const context = engine === deps.deployment.dealVault ? deps : deps.zapContexts?.[engine];
    if (!context) throw new ApiError("NOT_FOUND", "Rating engine is not published on this service");
    if (await context.reader.chainId() !== context.deployment.chainId) throw new ApiError("WRONG_CHAIN", "Rating source chain mismatch");
    let reader = await context.reader.snapshot();
    let pricingDeployment = context.deployment;
    const at = now();
    const raw = (key: string, required = false): bigint => {
      const s = q[key];
      if (!s && !required) return 0n;
      if (!s || !/^\d{1,78}$/.test(s) || BigInt(s) >= 2n ** 256n) throw new ApiError("BAD_REQUEST", `Invalid ${key}`);
      return BigInt(s);
    };
    const mode = q.mode ?? "market";
    if (!["market", "loan", "lender-sale", "borrower-right"].includes(mode)) throw new ApiError("BAD_REQUEST", "Invalid rating mode");
    if (Boolean(q.token) === Boolean(q.poolId)) throw new ApiError("BAD_REQUEST", "Provide one token or exact pool ID");
    const pool = q.poolId ? Object.values(context.deployment.pools).find(p => p.poolId.toLowerCase() === q.poolId?.toLowerCase()) : null;
    if (q.poolId && !pool) throw new ApiError("NOT_FOUND", "Exact pool is not published on this service");
    if (pool?.protocol === "v3" && context.deployment.nativeV3Manager && context.deployment.nativeV3Factory) {
      if (!("v3Reader" in context) || !context.v3Reader) throw new ApiError("NOT_FOUND", "V3 rating reader is unavailable");
      reader = await context.v3Reader.snapshot();
      pricingDeployment = { ...context.deployment, vaultVersion: 3, positionManager: context.deployment.nativeV3Manager, v3Factory: context.deployment.nativeV3Factory };
    }
    const pricer = new Pricer(reader, pricingDeployment);
    const pricing = { reader, pricer };
    const token = q.token ? parseAddressParam(q.token, "token") : null;
    const decimals = (await reader.tokenMeta(context.deployment.usdg)).decimals;
    const evidence: Record<string, unknown> = { block: (await reader.blockNumber()).toString() };
    const requireReportedDepth = context.deployment.chainId === 4663;
    const marketDepths = new Map<Address, string | null>();
    const marketVolatility = new Map<Address, StressVolatility>();
    const reported = async (selected: Pool | undefined) => {
      if (!selected) return null;
      try {
        const reserves = await lookupReserves(context.deployment.chainId, selected);
        if (!reserves || !Number.isFinite(reserves.checkedAt) || at - reserves.checkedAt > 600 || reserves.checkedAt > at + 30) return null;
        const [meta0, meta1, p0, p1] = await Promise.all([reader.tokenMeta(selected.currency0), reader.tokenMeta(selected.currency1), pricer.priceInUSDG(selected.currency0), pricer.priceInUSDG(selected.currency1)]);
        const value = valueReportedAmount(reserves.amount0, meta0.decimals, p0.price) + valueReportedAmount(reserves.amount1, meta1.decimals, p1.price);
        return { ...reserves, valueUSDG: value.toString(), source: "dexscreener-pool-quantities", poolId: selected.poolId };
      } catch { return null; }
    };
    const facts = async (asset: Address): Promise<TokenFacts> => {
      const key = `${engine}:${asset}`;
      const hit = cache.get(key);
      if (hit && at - hit.at < 300) return hit.value;
      if (cache.size >= 500) cache.delete(cache.keys().next().value!);
      const value = assembleFacts({ reader, pricer, deployment: context.deployment, explorer: deps.explorer, indexer: deps.indexer,
        store: deps.store, knownLockers: deps.config.knownLockers as Address[] }, asset).catch((error: unknown) => { cache.delete(key); throw error; });
      cache.set(key, { at, value });
      return value;
    };
    const market = async (asset: Address): Promise<MarketRating> => {
      if (asset === context.deployment.usdg) {
        marketVolatility.set(asset, { annualised: 0, source: "measured" });
        return { grade: "BBB", confidence: "low", factors: [], reasons: ["USDG is the accounting currency; peg, issuer and redemption risks remain."] };
      }
      const f = await facts(asset);
      const [identity, reserves] = await Promise.all([f.lane === "STOCK" ? lookupStock(context.deployment.chainId, asset) : Promise.resolve({ kind: "other" as const }),
        reported(Object.values(context.deployment.pools).find(p => p.poolId === f.poolId))]);
      // Realised volatility of the hourly local price needs 24 returns over two days; the sampler keeps 31 days.
      const samples = deps.store.tokenSamples(asset, at - 31 * 86400).filter(s => s.at <= at + 30);
      const volatility = realisedVolatility(samples.map(s => ({ at: s.at, price: Number(s.priceUSDG) })));
      const stress = stressVolatility(f.lane, volatility?.annualised ?? null);
      marketVolatility.set(asset, stress);
      const inputs = { profile: identity.kind === "stock" ? "stock" as const : "token" as const, lane: f.lane, price: f.priceUSDG, depth: f.depthUSDG, reportedDepth: reserves?.valueUSDG ?? null, requireReportedDepth, mcap: f.mcapMedian7d ?? f.mcapUSDG,
        ageDays: f.poolAgeDays ?? (reserves?.createdAt ? Math.max(0, (at - reserves.createdAt) / 86400) : null), volatility: volatility?.annualised ?? null, topTen: f.basis.explorer === "ok" ? f.topTenShare : null,
        at: f.checkedAt, decimals };
      evidence[asset] = { ...inputs, identity, reportedReserves: reserves, poolId: f.poolId, marketCapBasis: f.mcapMedian7d === null ? "current-token-supply" : "7-day-median-token-supply",
        volatilityBasis: volatility ? { samples: volatility.samples, spanDays: Math.round(volatility.spanSeconds / 864) / 100 } : null, stressVolatility: stress, drawdown30d: f.drawdown30d };
      marketDepths.set(asset, conservativeDepth(inputs.depth, inputs.reportedDepth, requireReportedDepth));
      const rating = assessMarket(inputs, at);
      if (identity.kind === "unavailable") return { ...rating, grade: "NR", confidence: "low", reasons: ["Stock-token identity evidence is unavailable. A token or company grade is not inferred from its ticker."] };
      if (identity.kind === "stock") {
        rating.factors.unshift({ name: "Asset type", value: `${identity.symbol} · stock / ETF token`, score: null, detail: "Exact chain and contract address matched to Robinhood's issuer registry." });
        if (!identity.active) return { ...rating, grade: "NR", reasons: [...rating.reasons, "The issuer marks this token inactive; current redemption and trading conditions need review."] };
      }
      return rating;
    };
    const components = await Promise.all((pool ? [pool.currency0, pool.currency1] : [token!]).map(market));
    let marketGrade = components.reduce((grade, rating) => worse(grade, rating.grade), components[0]!.grade);
    const reasons = [...new Set(components.flatMap(r => r.reasons))];
    const factors = components.flatMap((r, i) => r.factors.map(f => ({ ...f, name: pool ? `${i === 0 ? pool.currency0 : pool.currency1} · ${f.name}` : f.name })));
    let poolDepth: bigint | null = null;
    if (pool) {
      const virtualDepth = await pricer.depthUSDG(await pricer.poolState(pool));
      const reserves = await reported(pool);
      const assessedDepth = conservativeDepth(virtualDepth.toString(), reserves?.valueUSDG, requireReportedDepth);
      poolDepth = assessedDepth === null ? 0n : BigInt(assessedDepth);
      evidence.pool = { poolId: pool.poolId, depth: virtualDepth.toString(), reportedReserves: reserves, assessedDepth, createdAt: pool.createdAt };
      const poolRating = assessMarket({ profile: "pool", price: "1", depth: virtualDepth.toString(), reportedDepth: reserves?.valueUSDG ?? null, requireReportedDepth, mcap: null, ageDays: pool.createdAt === null ? null : (at - pool.createdAt) / 86400,
        volatility: null, topTen: null, at, decimals }, at);
      marketGrade = worse(marketGrade, poolRating.grade);
      reasons.push(...poolRating.reasons.filter(reason => !reasons.includes(reason)));
      factors.push({ ...poolRating.factors[0]!, name: "Exact pool liquidity screen" });
      reasons.push("LP composition changes with price and range; no diversification bonus is assumed.");
    }
    let grade = marketGrade;
    let scenarios: ReturnType<typeof stressScenarios> = [];
    let economics: { cost: string; repayment: string | null; currentValue: string; graceEnd: number | null } | null = null;
    if (mode !== "market") {
      const collateral = raw("collateral", true), principal = raw("principal", true), repayment = raw("repayment", true), term = Number(raw("term", true));
      if (collateral <= 0n || principal <= 0n || repayment < principal || term <= 0 || term > 366 * 86400) throw new ApiError("BAD_REQUEST", "Invalid rating terms");
      const mask = mode === "lender-sale" ? Number(raw("mask", true)) : 15;
      if (mask < 1 || mask > 15) throw new ApiError("BAD_REQUEST", "Invalid claim quarters");
      const ask = mode === "lender-sale" || mode === "borrower-right" ? raw("ask", true) : principal;
      if (ask <= 0n) throw new ApiError("BAD_REQUEST", "A positive purchase price is required");
      const cost = mode === "borrower-right" ? ask + repayment : ask;
      const claimRepayment = mode === "borrower-right" ? null : slice(repayment, mask);
      const endAt = Number(raw("endAt"));
      if (!Number.isSafeInteger(endAt)) throw new ApiError("BAD_REQUEST", "Invalid grace boundary");
      // Exposure lasts until lenders can finalize: term plus grace for a preview, the time left for a funded loan.
      const horizon = endAt > at ? Math.max(86_400, endAt - at) : term + (context.deployment.grace ?? DEFAULT_GRACE);
      const legs = pool ? [pool.currency0, pool.currency1] : [token!];
      const stressVol = legs.map(leg => marketVolatility.get(leg) ?? stressVolatility(null, null)).reduce((a, b) => b.annualised > a.annualised ? b : a);
      const sigma = horizonSigma(stressVol.annualised, horizon);
      const shocks = stressShocks(sigma);
      let values: Map<number, bigint>;
      if (pool) {
        if (!context.deployment.positionManager) throw new ApiError("NOT_FOUND", "Position manager unavailable");
        const position = await reader.position(collateral);
        if (!position || poolIdOf(position.poolKey) !== pool.poolId) throw new ApiError("BAD_REQUEST", "LP position does not belong to the selected pool");
        const valuation = await valuePosition(pricing, 0n, collateral, repayment, decimals);
        const built = await buildPositionModel(pricing, position, collateral);
        evidence.position = { manager: pricingDeployment.positionManager, tokenId: collateral.toString(), ...valuation };
        const whole = BigInt(valuation.valueUSDG);
        values = new Map(shocks.map(({ shock }) => {
          const bps = BigInt(Math.round(shock * 100));
          const single = positionValueAt(built.model, sqrtPriceForAssetMove(built.model, 10_000n - bps, 10_000n));
          // Keep USDG fixed as numeraire. For two risky assets also test a correlated fall of both legs.
          const joint = whole * (10_000n - bps) / 10_000n;
          const hasUsdg = pool.currency0 === context.deployment.usdg || pool.currency1 === context.deployment.usdg;
          return [Number(bps), slice(hasUsdg || single < joint ? single : joint, mask)];
        }));
        reasons.push("LP stress reprices the volatile leg through its range at the more volatile leg's stress, holding USDG fixed. Two risky assets also face a joint fall. Accrued fees are included; exit costs and incentives are excluded.");
      } else {
        const value = (await pricer.valueInUSDG(token!, slice(collateral, mask))).value;
        values = new Map(shocks.map(({ shock }) => { const bps = BigInt(Math.round(shock * 100)); return [Number(bps), value * (10_000n - bps) / 10_000n]; }));
      }
      scenarios = stressScenarios(bps => values.get(bps)!, cost, shocks);
      const current = values.get(0)!;
      // Principal loss is possible whichever contractual branch the borrower chooses: grade by the headroom before it.
      const sigmas = headroom(current, cost, sigma);
      grade = worse(marketGrade, headroomGrade(sigmas));
      if (claimRepayment !== null && claimRepayment < cost) grade = worse(grade, coverageGrade(claimRepayment, cost));
      const days = Math.round(horizon / 8_640) / 10;
      const fall = current > cost ? `${(100 - Number(cost * 10_000n / current) / 100).toFixed(1)}% fall` : "already uncovered";
      factors.push(
        { name: "Stress horizon", value: `${days} day${days === 1 ? "" : "s"}`, score: null, detail: endAt > at ? "Time left until lenders can finalize collateral entitlement." : "Loan term plus the engine's grace, after which lenders can finalize collateral entitlement." },
        { name: "Stress volatility", value: `${Math.round(stressVol.annualised * 100)}% annualised · ${stressVol.source}`, score: null, detail: "Annualised volatility the stress applies: measured from 30 days of hourly local prices, raised to the lane floor when a pool prints few moves, or the lane fallback while unmeasured. LPs use the more volatile leg." },
        { name: "Headroom before loss", value: sigmas === null ? null : `${Number.isFinite(sigmas) ? sigmas.toFixed(1) : sigmas > 0 ? "∞" : "0"}σ · ${fall}`, score: null, detail: "How far the collateral can fall before the buyer's cost is uncovered, in standard deviations of this collateral's volatility over the stress horizon. BBB ≥ 2.5σ, BB ≥ 2σ, B ≥ 1.5σ, CCC ≥ 1σ, CC ≥ 0.5σ." });
      const depth = poolDepth ?? BigInt(marketDepths.get(token!) ?? "0");
      if (depth <= 0n) grade = "NR";
      else {
        const shareBps = current * 10_000n / depth;
        factors.push({ name: "Collateral share of pool liquidity", value: `${(Number(shareBps) / 100).toFixed(2)}%`, score: null, detail: "Collateral value at stake divided by the assessed pool liquidity. Above 5% the grade is capped at CCC because exit capacity is uncertain." });
        if (shareBps > 500n) { grade = worse(grade, "CCC"); reasons.push("This collateral share exceeds 5% of the assessed pool liquidity; exit capacity is uncertain."); }
      }
      economics = { cost: cost.toString(), repayment: claimRepayment?.toString() ?? null, currentValue: current.toString(), graceEnd: endAt || null };
      if (mode === "borrower-right") { grade = marketGrade; reasons.push("This grade describes the collateral market. The right requires paying ask plus repayment while the loan is active. After grace, a lender can finalize at any time; gas and sale costs are additional."); }
      else reasons.push(`Loan grade: the worse of the market grade and the headroom before loss, measured in standard deviations of this collateral's volatility over ${days} days (BBB ≥ 2.5σ, BB ≥ 2σ, B ≥ 1.5σ, CCC ≥ 1σ, CC ≥ 0.5σ). The stress table shows one-, two- and three-sigma falls. Not a forecast.`);
      if (endAt && endAt <= at) {
        grade = mode === "borrower-right" ? "NR" : worse(grade, "CCC");
        reasons.push("Past grace: a lender can finalize collateral entitlement at any time. Repayment and lender sales remain possible while the loan is active; inspect current on-chain state.");
      }
      reasons.push("Borrower repayment history is unscored until verified outcomes are available. Collateral settlement alone is not a D.");
    } else if (pool) reasons.push("Pool baseline only: a particular LP range and loan size can have a lower grade.");
    const body = { model: MODEL, chainId: context.deployment.chainId, engine, at, expiresAt: at + 120, grade, marketGrade,
      confidence: pool || components.some(r => r.confidence === "low") ? "low" : "moderate",
      label: mode === "borrower-right" || mode === "market" ? "Market rating" : mode === "lender-sale" ? "Claim rating" : "Borrow rating",
      reasons, factors, scenarios, economics, evidence, input: q, usdgDecimals: decimals };
    const id = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    let recorded = false;
    try { recorded = deps.ratingStore?.assessment(id, at, body) ?? false; } catch { /* Evidence collection cannot break reads. */ }
    return c.json({ id, ...body, recorded });
  });
  app.use("/ratings/interactions", bodyLimit({ maxSize: 1024 }));
  app.post("/ratings/interactions", async c => {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object") throw new ApiError("BAD_REQUEST", "Invalid rating interaction");
    const b = body as Record<string, unknown>;
    if (typeof b.assessmentId !== "string" || !/^[a-f0-9]{64}$/.test(b.assessmentId) || typeof b.session !== "string" || !/^[a-f0-9-]{36}$/.test(b.session)
      || !["impression", "details", "intent"].includes(String(b.event)) || !["market", "borrow", "lend", "position", "lender-sale", "borrower-right", "curator", "portfolio"].includes(String(b.surface))) {
      throw new ApiError("BAD_REQUEST", "Invalid rating interaction");
    }
    let recorded = false;
    try { recorded = deps.ratingStore?.interaction(b.assessmentId, b.session, String(b.event), String(b.surface), now()) ?? false; } catch { /* Best effort only. */ }
    return c.json({ recorded });
  });
}
