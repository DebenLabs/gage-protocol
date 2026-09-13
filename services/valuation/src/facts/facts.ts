/**
 * GET /assets/:token/facts: the spec 7.4 screening record and the lender's facts panel. Every input is best-effort
 * and every gap is written into `basis.notes`, so the panel shows what is known and says what is not.
 *
 * `eligible` is the 7.4 conjunction: a pool with an allowlisted Stock Token, pool age of 7 days or more, a 7-day
 * median market cap of 1,000,000 USDG or more, and the contract checks either passing or having their findings
 * recorded here. A measured transfer tax is the one check that blocks on its own, because `list` rejects the
 * token through the balance-delta check anyway. Liquidity lock, holder shares and drawdown are shown, not gates.
 */
import type { Address, Hex } from "viem";
import type { ChainReader, Lane } from "../chain/reader.js";
import { NATIVE, poolsWith, type Deployment, type Pool } from "../deployment.js";
import { ApiError } from "../errors.js";
import type { Indexer } from "../indexer/client.js";
import { absBig } from "../math/fullMath.js";
import { applyPrice, type Fraction } from "../math/price.js";
import { maxDrawdown, medianBig, type PricePoint } from "../math/stats.js";
import { Pricer, type PoolState } from "../pricing/pricer.js";
import { nowSeconds } from "../util/format.js";
import { priceToDecimal } from "../valuation/deal.js";
import { BEACON_SLOT, IMPLEMENTATION_SLOT, runChecks, type Checks } from "./checks.js";
import type { Explorer, Holder } from "./explorer.js";
import { BURN_ADDRESSES, assessLock } from "./lock.js";
import { mcapMedian7d, type SampleStore } from "./store.js";

export const MEME_MCAP_FLOOR_USDG = 1_000_000n;
export const MEME_POOL_AGE_DAYS = 7;
export const MEME_CAP_SHARE_BPS = 7000;
export const STOCK_CAP_SHARE_BPS = 9000;
/** Per-deal and per-asset caps as a share of pool depth (spec 7.4 rule 5). */
export const MEME_PER_DEAL_DEPTH_BPS = 100;
export const MEME_PER_ASSET_DEPTH_BPS = 500;

export interface RuleResult {
  rule: string;
  status: "pass" | "fail" | "unknown";
  detail: string;
}

export interface TokenFacts {
  token: Address;
  symbol: string;
  decimals: number;
  lane: Lane | null;
  allowed: boolean;
  mcapUSDG: string | null;
  mcapMedian7d: string | null;
  pool: string | null;
  poolId: Hex | null;
  pairToken: Address | null;
  pairSymbol: string | null;
  poolCreatedAt: number | null;
  poolAgeDays: number | null;
  depthUSDG: string | null;
  liquidityLocked: boolean;
  lockedUntil: number | null;
  lockedShare: number | null;
  topTenShare: number | null;
  creatorShare: number | null;
  creatorWallet: Address | null;
  volume7d: string | null;
  drawdown30d: number | null;
  priceUSDG: string | null;
  checks: Checks;
  eligible: boolean;
  rules: RuleResult[];
  listingNote: string;
  admissionNote?: string | null;
  /** Registry sizing hints under 7.4 rule 5, in raw token units, from the pool depth at spot. */
  suggestedCaps: { perDealRaw: string; perAssetRaw: string } | null;
  checkedAt: number;
  basis: { notes: string[]; medianSamples: number; medianSpanDays: number; explorer: "ok" | "partial" | "offline"; indexer: "ok" | "offline" | "unused" };
}

export interface FactsDeps {
  reader: ChainReader;
  pricer: Pricer;
  deployment: Deployment;
  explorer: Explorer;
  indexer: Indexer;
  store: SampleStore;
  knownLockers: readonly Address[];
}

/** Format raw USDG as a whole-number string with thousands separators (display in the note only). */
export function formatUSDG(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  return whole.toLocaleString("en-US");
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** Choose the deepest pool allowed by the registry quote policy (stock=1, USDG=2, ETH=4). */
async function pickPool(deps: FactsDeps, token: Address): Promise<{ pool: Pool; state: PoolState; pairLane: Lane | null; pairAllowed: boolean; quoteAsset?: "STOCK" | "USDG" | "ETH" | undefined; quoteApproved?: boolean | undefined } | null> {
  const candidates = poolsWith(deps.deployment, token);
  const mask = await (deps.reader.memePairMask?.() ?? Promise.resolve(1)).catch(() => 0);
  let best: { pool: Pool; state: PoolState; pairLane: Lane | null; pairAllowed: boolean; quoteAsset?: "STOCK" | "USDG" | "ETH" | undefined; quoteApproved?: boolean | undefined; depth: bigint } | null = null;
  for (const pool of candidates) {
    const pair = Pricer.otherCurrency(pool, token);
    let state: PoolState;
    try {
      state = await deps.pricer.poolState(pool);
    } catch {
      continue;
    }
    let pairLane: Lane | null = null;
    let pairAllowed = false;
    if (pair !== NATIVE && !deps.pricer.aliases(deps.pricer.usdg).includes(pair)) {
      try {
        const cfg = await deps.reader.getERC20Config(pair);
        pairLane = cfg.lane;
        pairAllowed = cfg.allowed;
      } catch {
        // registry unreachable: treated as not allowlisted
      }
    }
    const quoteAsset = deps.pricer.aliases(deps.pricer.usdg).includes(pair) ? "USDG"
      : deps.pricer.aliases(NATIVE).includes(pair) ? "ETH" : pairLane === "STOCK" && pairAllowed ? "STOCK" : undefined;
    const quoteApproved = quoteAsset === "USDG" ? Boolean(mask & 2) : quoteAsset === "ETH" ? Boolean(mask & 4) : quoteAsset === "STOCK" ? Boolean(mask & 1) : false;
    let depth = 0n;
    try {
      depth = await deps.pricer.depthUSDG(state);
    } catch {
      // no USDG route for the pair: depth stays 0 and the pool ranks last
    }
    const stockPaired = quoteApproved;
    const bestStock = best !== null && best.quoteApproved === true;
    if (best === null || (stockPaired && !bestStock) || (stockPaired === bestStock && depth > best.depth)) {
      best = { pool, state, pairLane, pairAllowed, quoteAsset, quoteApproved, depth };
    }
  }
  return best === null ? null : { pool: best.pool, state: best.state, pairLane: best.pairLane, pairAllowed: best.pairAllowed, quoteAsset: best.quoteAsset, quoteApproved: best.quoteApproved };
}

export async function assembleFacts(deps: FactsDeps, token: Address): Promise<TokenFacts> {
  const notes: string[] = [];
  const now = nowSeconds();
  const [meta, usdgMeta] = await Promise.all([
    deps.reader.tokenMeta(token).catch(() => {
      throw new ApiError("NOT_FOUND", `${token} does not answer as an ERC-20`);
    }),
    deps.reader.tokenMeta(deps.pricer.usdg)
  ]);
  let lane: Lane | null = null;
  let allowed = false;
  try {
    const cfg = await deps.reader.getERC20Config(token);
    lane = cfg.lane;
    allowed = cfg.allowed;
  } catch (e) {
    notes.push(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // pool, price, depth
  const picked = await pickPool(deps, token);
  let price: Fraction | null = null;
  let depthUSDG: bigint | null = null;
  let poolCreatedAt: number | null = null;
  let poolCreatedBlock: bigint | null = null;
  if (picked === null) {
    notes.push("no initialised pool in the deployment pairs this token; market cap, depth and age are unknown");
  } else {
    try {
      price = (await deps.pricer.priceInUSDG(token)).price;
    } catch (e) {
      notes.push(`no USDG route for the price: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      depthUSDG = await deps.pricer.depthUSDG(picked.state);
    } catch (e) {
      notes.push(`pool depth in USDG unknown: ${e instanceof Error ? e.message : String(e)}`);
    }
    poolCreatedAt = picked.pool.createdAt;
    poolCreatedBlock = picked.pool.createdBlock === null ? null : BigInt(picked.pool.createdBlock);
    if (poolCreatedAt === null) {
      const init = await deps.reader.poolInitialised(picked.pool.poolId).catch(() => null);
      if (init !== null) {
        poolCreatedAt = init.timestamp;
        poolCreatedBlock = init.block;
      } else notes.push("pool creation time unknown (no createdAt in the deployment and no Initialize event found)");
    }
  }
  const poolAgeDays = poolCreatedAt === null ? null : Math.max(0, (now - poolCreatedAt) / 86_400);

  // market cap now and the 7-day median
  const supply = await deps.reader.totalSupply(token).catch(() => null);
  if (supply === null) notes.push("totalSupply() could not be read");
  const mcapNow = supply !== null && price !== null ? applyPrice(supply, price) : null;
  const median = mcapMedian7d(deps.store, token, now, medianBig);
  if (median.median === null) {
    notes.push(
      median.samples === 0
        ? "no market-cap samples yet; the 7-day median needs the hourly sampler to have run for seven days"
        : `market-cap samples span ${median.spanDays.toFixed(1)} days, below the seven the median needs`
    );
  }

  // holders
  let explorerStatus: TokenFacts["basis"]["explorer"] = "ok";
  const holdersRes = await deps.explorer.holders(token);
  const holders: Holder[] | null = holdersRes.value;
  if (holders === null) {
    explorerStatus = "offline";
    notes.push(`holder shares unknown: ${holdersRes.reason ?? "explorer returned nothing"}`);
  } else if (holdersRes.reason !== null) {
    explorerStatus = "partial";
    notes.push(`holder list is partial: ${holdersRes.reason}`);
  }
  const excluded = new Set<Address>([...BURN_ADDRESSES, token, ...(deps.deployment.poolManager === null ? [] : [deps.deployment.poolManager])]);
  let topTenShare: number | null = null;
  let creatorShare: number | null = null;
  let creatorWallet: Address | null = null;
  if (holders !== null && supply !== null && supply > 0n) {
    const ranked = holders.filter((h) => !excluded.has(h.address));
    const topTen = ranked.slice(0, 10).reduce((a, h) => a + h.value, 0n);
    topTenShare = Number((topTen * 10_000n) / supply) / 10_000;
    const creator = await deps.explorer.creatorWallet(token);
    if (creator.value !== null) {
      creatorWallet = creator.value.wallet;
      const held = holders.find((h) => h.address === creatorWallet)?.value ?? 0n;
      creatorShare = Number((held * 10_000n) / supply) / 10_000;
    } else {
      if (explorerStatus === "ok") explorerStatus = "partial";
      notes.push(`creator wallet unknown: ${creator.reason ?? "explorer returned nothing"}`);
    }
  }

  // liquidity lock
  const lockers = new Set<Address>([...deps.knownLockers, ...(deps.deployment.seedTimelock === null ? [] : [deps.deployment.seedTimelock])]);
  const positions = picked === null ? [] : await deps.reader.poolPositions(picked.pool.poolId).catch(() => []);
  const lock = await assessLock({ positions, lockers, unlockTimeOf: (o) => deps.reader.unlockTime(o).catch(() => null) });
  if (picked !== null && positions.length === 0) notes.push("no PositionManager positions found in the pool, so the lock heuristic has nothing to assess");

  // 7-day volume from the indexer's swaps, valued in USDG at spot
  let indexerStatus: TokenFacts["basis"]["indexer"] = "unused";
  let volume7d: bigint | null = null;
  if (picked !== null) {
    indexerStatus = "ok";
    const indexed = await deps.indexer.pool(picked.pool.name);
    if (indexed.value === null) {
      indexerStatus = "offline";
      notes.push(`7-day volume unknown: ${indexed.reason ?? "indexer returned nothing"}`);
    } else if (indexed.value.swaps.length === 0) {
      notes.push("7-day volume unknown: the indexer has no swap history for this pool");
      volume7d = null;
    } else if (price !== null) {
      const tokenIs0 = picked.pool.currency0 === token;
      const since = now - 7 * 86_400;
      const raw = indexed.value.swaps.filter((s) => s.at >= since).reduce((a, s) => a + absBig(tokenIs0 ? s.amount0 : s.amount1), 0n);
      volume7d = applyPrice(raw, price);
    }
  }

  // 30-day drawdown from the sampler's price history
  const samples = deps.store.tokenSamples(token, now - 30 * 86_400);
  const points: PricePoint[] = samples.map((s) => ({ at: s.at, price: Number(s.priceUSDG) }));
  const drawdown30d = maxDrawdown(points);
  if (drawdown30d === null) notes.push(`30-day drawdown unknown: ${samples.length} price sample${samples.length === 1 ? "" : "s"} in the window`);

  // contract checks
  const [bytecode, pausedCall, implSlot, beaconSlot, info] = await Promise.all([
    deps.reader.getCode(token),
    deps.reader.paused(token),
    deps.reader.getStorageAt(token, IMPLEMENTATION_SLOT).catch(() => null),
    deps.reader.getStorageAt(token, BEACON_SLOT).catch(() => null),
    deps.explorer.addressInfo(token)
  ]);
  const probeHolder = holders?.find((h) => !h.isContract && !excluded.has(h.address) && h.value > 0n) ?? holders?.find((h) => !excluded.has(h.address) && h.value > 0n) ?? null;
  const oneWhole = 10n ** BigInt(meta.decimals);
  const probeAmount = probeHolder === null ? 0n : probeHolder.value < oneWhole ? probeHolder.value : oneWhole;
  const probeTo = "0x000000000000000000000000000000000000beef" as Address;
  const probe = probeHolder === null ? null : await deps.reader.probeTransfer(token, probeHolder.address, probeTo, probeAmount);
  if (probeHolder === null) notes.push("no holder available for the transfer simulation");
  else if (probe === null) notes.push("the node rejected the state-override transfer simulation");
  const supplyAtLaunch = poolCreatedBlock === null || supply === null ? null : await deps.reader.totalSupply(token, poolCreatedBlock).catch(() => null);
  const checks = runChecks({
    bytecode,
    pausedCall,
    probe,
    probeAmount,
    probeHolder: probeHolder?.address ?? null,
    implementationSlot: implSlot,
    beaconSlot,
    explorer: info.value,
    supplyNow: supply ?? 0n,
    supplyAtLaunch
  });
  if (info.value === null) {
    if (explorerStatus === "ok") explorerStatus = "partial";
    notes.push(`explorer contract record unavailable: ${info.reason ?? "no answer"}`);
  } else if (!info.value.isVerified) notes.push("source is not verified on the explorer; checks are bytecode heuristics");

  // eligibility (spec 7.4)
  const rules = buildRules({ picked, poolAgeDays, medianMcap: median.median, medianSamples: median.samples, checks, usdgDecimals: usdgMeta.decimals });
  const eligible = rules.every((r) => r.status === "pass");
  const pairSymbol = picked === null ? null : Pricer.otherCurrency(picked.pool, token) === NATIVE ? "ETH" : (await deps.reader.tokenMeta(Pricer.otherCurrency(picked.pool, token)).catch(() => null))?.symbol ?? null;

  const suggestedCaps = depthUSDG === null || price === null || price.num === 0n ? null : capsFromDepth(depthUSDG, price);
  const disclosure = deps.deployment.collateralNotes?.[token.toLowerCase()];
  const admissionNote = allowed && disclosure?.poolId === picked?.pool.poolId ? disclosure?.note : undefined;
  if (admissionNote) notes.push(admissionNote);
  const listingNote = (admissionNote ? `${admissionNote} ` : "") + writeListingNote({
    symbol: meta.symbol,
    lane,
    picked,
    pairSymbol,
    poolAgeDays,
    depthUSDG,
    mcapNow,
    medianMcap: median.median,
    usdgDecimals: usdgMeta.decimals,
    checks,
    lock,
    topTenShare,
    creatorShare,
    drawdown30d,
    eligible,
    rules
  });

  return {
    token,
    symbol: meta.symbol,
    decimals: meta.decimals,
    lane,
    allowed,
    mcapUSDG: mcapNow === null ? null : mcapNow.toString(),
    mcapMedian7d: median.median === null ? null : median.median.toString(),
    pool: picked === null ? null : picked.pool.name,
    poolId: picked === null ? null : picked.pool.poolId,
    pairToken: picked === null ? null : Pricer.otherCurrency(picked.pool, token),
    pairSymbol,
    poolCreatedAt,
    poolAgeDays: poolAgeDays === null ? null : Math.round(poolAgeDays * 100) / 100,
    depthUSDG: depthUSDG === null ? null : depthUSDG.toString(),
    liquidityLocked: lock.liquidityLocked,
    lockedUntil: lock.lockedUntil,
    lockedShare: positions.length === 0 ? null : lock.lockedShare,
    topTenShare,
    creatorShare,
    creatorWallet,
    volume7d: volume7d === null ? null : volume7d.toString(),
    drawdown30d,
    priceUSDG: price === null ? null : priceToDecimal(price, meta.decimals, usdgMeta.decimals),
    checks,
    eligible,
    rules,
    listingNote,
    admissionNote: admissionNote ?? null,
    suggestedCaps,
    checkedAt: now,
    basis: { notes, medianSamples: median.samples, medianSpanDays: Math.round(median.spanDays * 100) / 100, explorer: explorerStatus, indexer: indexerStatus }
  };
}

/** 1% / 5% of the pool depth, converted from USDG raw to token raw at spot. */
export function capsFromDepth(depthUSDG: bigint, priceUSDGPerRaw: Fraction): { perDealRaw: string; perAssetRaw: string } {
  const tokenRawPerUSDG: Fraction = { num: priceUSDGPerRaw.den, den: priceUSDGPerRaw.num };
  const perDeal = applyPrice((depthUSDG * BigInt(MEME_PER_DEAL_DEPTH_BPS)) / 10_000n, tokenRawPerUSDG);
  const perAsset = applyPrice((depthUSDG * BigInt(MEME_PER_ASSET_DEPTH_BPS)) / 10_000n, tokenRawPerUSDG);
  return { perDealRaw: perDeal.toString(), perAssetRaw: perAsset.toString() };
}

interface RuleInputs {
  picked: { pool: Pool; pairLane: Lane | null; pairAllowed: boolean; quoteAsset?: "STOCK" | "USDG" | "ETH" | undefined; quoteApproved?: boolean | undefined } | null;
  poolAgeDays: number | null;
  medianMcap: bigint | null;
  medianSamples: number;
  checks: Checks;
  usdgDecimals: number;
}

export function buildRules(i: RuleInputs): RuleResult[] {
  const rules: RuleResult[] = [];
  if (i.picked === null) rules.push({ rule: "pool", status: "fail", detail: "no Uniswap v4 pool pairs the token with an allowlisted Stock Token" });
  else if (i.picked.quoteApproved ?? (i.picked.pairAllowed && i.picked.pairLane === "STOCK")) rules.push({ rule: "pool", status: "pass", detail: `${i.picked.pool.name} pairs the token with ${i.picked.quoteAsset ?? "an allowlisted Stock Token"}, enabled by the registry quote policy` });
  else rules.push({ rule: "pool", status: "fail", detail: `${i.picked.pool.name} does not meet the registry quote-asset policy` });

  if (i.poolAgeDays === null) rules.push({ rule: "poolAge", status: "unknown", detail: "pool creation time unknown" });
  else if (i.poolAgeDays >= MEME_POOL_AGE_DAYS) rules.push({ rule: "poolAge", status: "pass", detail: `pool is ${i.poolAgeDays.toFixed(1)} days old (minimum ${MEME_POOL_AGE_DAYS})` });
  else rules.push({ rule: "poolAge", status: "fail", detail: `pool is ${i.poolAgeDays.toFixed(1)} days old, below the ${MEME_POOL_AGE_DAYS}-day minimum` });

  const floor = MEME_MCAP_FLOOR_USDG * 10n ** BigInt(i.usdgDecimals);
  if (i.medianMcap === null) rules.push({ rule: "marketCap", status: "unknown", detail: `7-day median market cap not available yet (${i.medianSamples} samples)` });
  else if (i.medianMcap >= floor) rules.push({ rule: "marketCap", status: "pass", detail: `7-day median market cap ${formatUSDG(i.medianMcap, i.usdgDecimals)} USDG meets the 1,000,000 USDG floor` });
  else rules.push({ rule: "marketCap", status: "fail", detail: `7-day median market cap ${formatUSDG(i.medianMcap, i.usdgDecimals)} USDG is below the 1,000,000 USDG floor` });

  const failed = (Object.keys(i.checks) as Array<keyof Checks>).filter((k) => i.checks[k].status === "fail");
  const unknown = (Object.keys(i.checks) as Array<keyof Checks>).filter((k) => i.checks[k].status === "unknown");
  if (i.checks.transferTax.status === "fail") {
    rules.push({ rule: "contractChecks", status: "fail", detail: `transfer tax: ${i.checks.transferTax.detail}; list() rejects the token through its balance-delta check` });
  } else if (failed.length === 0 && unknown.length === 0) {
    rules.push({ rule: "contractChecks", status: "pass", detail: "mint after launch, pause, transfer tax, blocklist and proxy all pass" });
  } else {
    const parts = [...failed.map((k) => `${k} fails`), ...unknown.map((k) => `${k} unknown`)];
    rules.push({ rule: "contractChecks", status: "pass", detail: `findings recorded and shown: ${parts.join(", ")}` });
  }
  return rules;
}

interface NoteInputs {
  symbol: string;
  lane: Lane | null;
  picked: { pool: Pool } | null;
  pairSymbol: string | null;
  poolAgeDays: number | null;
  depthUSDG: bigint | null;
  mcapNow: bigint | null;
  medianMcap: bigint | null;
  usdgDecimals: number;
  checks: Checks;
  lock: { liquidityLocked: boolean; lockedUntil: number | null; detail: string };
  topTenShare: number | null;
  creatorShare: number | null;
  drawdown30d: number | null;
  eligible: boolean;
  rules: RuleResult[];
}

const CHECK_LABEL: Record<keyof Checks, string> = {
  mintAfterLaunch: "mint after launch",
  pause: "pause",
  transferTax: "transfer tax",
  blocklist: "blocklist",
  proxy: "proxy"
};

/** One paragraph a lender can read: what the pool is, what the numbers are, what the checks found, the verdict. */
export function writeListingNote(i: NoteInputs): string {
  const s: string[] = [];
  const d = i.usdgDecimals;
  if (i.picked === null) s.push(`${i.symbol} has no pool in the deployment that pairs it with an allowlisted Stock Token.`);
  else {
    const age = i.poolAgeDays === null ? "of unknown age" : `${i.poolAgeDays.toFixed(0)} days old`;
    const depth = i.depthUSDG === null ? "unknown depth" : `${formatUSDG(i.depthUSDG, d)} USDG of active depth`;
    s.push(`${i.symbol} pairs with ${i.pairSymbol ?? "its pair token"} in the ${i.picked.pool.name} pool, ${age}, with ${depth}.`);
  }
  if (i.mcapNow !== null || i.medianMcap !== null) {
    const nowText = i.mcapNow === null ? "unknown" : `${formatUSDG(i.mcapNow, d)} USDG`;
    const medText = i.medianMcap === null ? "not available until seven days of samples exist" : `${formatUSDG(i.medianMcap, d)} USDG`;
    s.push(`Market cap is ${nowText} now; the 7-day median is ${medText}.`);
  }
  const keys = Object.keys(i.checks) as Array<keyof Checks>;
  const failed = keys.filter((k) => i.checks[k].status === "fail");
  const unknown = keys.filter((k) => i.checks[k].status === "unknown");
  if (failed.length === 0 && unknown.length === 0) s.push("Contract checks pass: no mint after launch, no pause, no transfer tax, no blocklist, no proxy.");
  else {
    if (failed.length > 0) s.push(`Findings: ${failed.map((k) => `${CHECK_LABEL[k]} (${i.checks[k].detail})`).join("; ")}.`);
    if (unknown.length > 0) s.push(`Not determined: ${unknown.map((k) => `${CHECK_LABEL[k]} (${i.checks[k].detail})`).join("; ")}.`);
  }
  s.push(i.lock.liquidityLocked ? `Liquidity is locked${i.lock.lockedUntil === null ? "" : ` until ${new Date(i.lock.lockedUntil * 1000).toISOString().slice(0, 10)}`}: ${i.lock.detail}.` : `Liquidity is not locked: ${i.lock.detail}.`);
  const shares: string[] = [];
  if (i.topTenShare !== null) shares.push(`the top ten holders hold ${pct(i.topTenShare)}`);
  if (i.creatorShare !== null) shares.push(`the creator wallet holds ${pct(i.creatorShare)}`);
  if (shares.length > 0) s.push(`${shares.join(" and ")}.`.replace(/^./, (c) => c.toUpperCase()));
  if (i.drawdown30d !== null) s.push(`Largest 30-day fall so far: ${pct(i.drawdown30d)}.`);
  const failing = i.rules.filter((r) => r.status !== "pass");
  if (i.eligible) s.push("Meets the listing rules of spec 7.4.");
  else s.push(`Does not meet the listing rules of spec 7.4 yet: ${failing.map((r) => r.detail).join("; ")}.`);
  if (i.lane === "MEME" || i.lane === null) s.push("Memes can go to zero. If the borrower walks away, you hold it.");
  return s.join(" ");
}
