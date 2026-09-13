/**
 * The weekly backstop (D64), dry-run by default. Whatever part of an epoch's deal budget is still unreserved when the
 * epoch ends rolls over as one lump into LPRewards, where it is capturable. Inside the last BACKSTOP_WINDOW_SECONDS
 * of an epoch this job reads `Emissions.remaining(epoch, 7 days) + remaining(epoch, 21 days)` and, above
 * BACKSTOP_MIN_SGAGE, plans one V1 deal per bucket that still has a remainder: the keeper wallet lists it (ERC-20
 * collateral at the registry minimum, asking price == cap), funds it with itself as the lender, registers it with
 * DealRewards, withdraws the borrower credit, reclaims (paying the cap back to itself) and withdraws the collateral.
 * The net cost is the vault fee, which goes to the GAGE floor; the reservation lands in the wallet's drips, which
 * the deposit job claims into the streamer. The fee is sized so `fee × rate / USDG_UNIT >= remainder` and the 80%
 * price cap also clears the remainder; the contract then reserves exactly the remainder.
 *
 * Two contract facts shape the schedule. `DealRewards.register` uses `epochOf(fundedAt)`, so a deal funded after the
 * boundary counts for the new epoch: new deals are only created before the boundary, and the six-hour registration
 * grace after it only finishes registrations of deals funded in time. And `register` grants one drip per
 * (account, dripId) with `dripId = keccak256("deal", dealId, party)`: with the same wallet on both sides the second
 * grant reverts `DripExists` unless one share is zero, so the plan refuses unless `lenderShareBps` is 0 or 10000.
 *
 * Without `BACKSTOP_ENABLED=true` and a `KEEPER_KEY` the job only logs its plan (`backstop_plan`) with every amount.
 */
import { formatUnits, parseEventLogs, type Address } from "viem";
import { DealState, dealRewardsAbi, dealVaultAbi, erc20Abi } from "../abi.js";
import { parseDecimal } from "../config.js";
import { need, nowSeconds, type JobContext } from "../context.js";
import type { Outcome } from "../sender.js";
import type { BackstopRecord } from "../state.js";
import type { EpochRates, RegistryConfig } from "../views.js";

const DAY = 86_400;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const REGISTER_RETRY_MS = 60 * 60 * 1000;
/** Steps one `advance` may take in a row: fund, register, withdraw, reclaim, withdraw, withdraw. */
const MAX_STEPS = 8;

export type Bucket = 7 | 21;
export const BUCKETS: readonly Bucket[] = [7, 21];

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export interface SizeInput {
  /** sGAGE still unreserved in the bucket. */
  remaining: bigint;
  /** sGAGE per USDG_UNIT of fee for the bucket. */
  rate: bigint;
  /** USDG raw units per 1e18 sGAGE. */
  priceUSDGPerSGAGE: bigint;
  usdgUnit: bigint;
  maxRewardShareBps: number;
  feeBps: number;
}

export interface Sizing {
  /** Fee the vault deducts, USDG raw units. */
  fee: bigint;
  /** Asking price == cap, USDG raw units. */
  price: bigint;
  /** What `register` reserves: min(fee × rate, 80% cap, remaining). */
  reservation: bigint;
}

/**
 * Pure. The smallest asking price whose vault fee reserves the whole remainder: the fee must clear both
 * `fee × rate / USDG_UNIT >= remaining` and `fee × 1e18 × maxShare / price >= remaining` (DealRewards._reward).
 */
export function sizeBackstop(i: SizeInput): Sizing | undefined {
  if (i.remaining <= 0n || i.rate <= 0n || i.priceUSDGPerSGAGE <= 0n || i.feeBps <= 0 || i.maxRewardShareBps <= 0) return undefined;
  const maxShare = BigInt(i.maxRewardShareBps);
  const feeRaw = ceilDiv(i.remaining * i.usdgUnit, i.rate);
  const feeCap = ceilDiv(i.remaining * i.priceUSDGPerSGAGE * BPS, maxShare * WAD);
  const feeNeeded = feeRaw > feeCap ? feeRaw : feeCap;
  const feeBps = BigInt(i.feeBps);
  const price = ceilDiv(feeNeeded * BPS, feeBps);
  const fee = (price * feeBps) / BPS;
  const raw = (fee * i.rate) / i.usdgUnit;
  const cap = (fee * WAD * maxShare) / BPS / i.priceUSDGPerSGAGE;
  const uncapped = raw < cap ? raw : cap;
  const reservation = uncapped < i.remaining ? uncapped : i.remaining;
  return { fee, price, reservation };
}

export interface BucketPlan {
  bucket: Bucket;
  term: number;
  remaining: bigint;
  rate: bigint;
  fee: bigint;
  price: bigint;
  reservation: bigint;
}

export interface PlanInput {
  epoch: bigint;
  remaining7: bigint;
  remaining21: bigint;
  rates: EpochRates;
  usdgUnit: bigint;
  maxRewardShareBps: number;
  /** Undefined when no collateral token is configured and the deployment has no `WETH`. */
  registry: RegistryConfig | undefined;
  collateral: { token: Address; amount: bigint; open: bigint } | undefined;
  /** BACKSTOP_MIN_SGAGE in raw units. */
  minSgage: bigint;
  /** Buckets a backstop deal of this epoch already covers. */
  covered: readonly Bucket[];
}

export interface BackstopPlan {
  epoch: bigint;
  total: bigint;
  aboveThreshold: boolean;
  deals: BucketPlan[];
  /** Anything here stops every deal. */
  blockers: string[];
  /** Per-bucket reasons a deal is not planned. */
  skipped: string[];
  /** Peak USDG the wallet needs: each deal pulls its price at `fund` and its cap at `reclaim` after the borrower credit
   *  (price - fee) came back, so price + fee per deal. */
  usdgNeeded: bigint;
  /** Collateral pulled at `list` for every planned deal, returned at `reclaim`. */
  collateralNeeded: bigint;
}

/** Pure. One deal per bucket with a remainder, none below the threshold, none while a blocker stands. */
export function planBackstop(i: PlanInput): BackstopPlan {
  const total = i.remaining7 + i.remaining21;
  const plan: BackstopPlan = { epoch: i.epoch, total, aboveThreshold: total > i.minSgage, deals: [], blockers: [], skipped: [], usdgNeeded: 0n, collateralNeeded: 0n };
  if (!plan.aboveThreshold) {
    plan.skipped.push("below_threshold");
    return plan;
  }
  if (!i.rates.set) plan.blockers.push("rates_not_set");
  if (i.rates.lenderShareBps !== 0 && i.rates.lenderShareBps !== 10_000) plan.blockers.push("self_deal_needs_single_party_share");
  if (i.collateral === undefined || i.registry === undefined) plan.blockers.push("collateral_unconfigured");
  else {
    if (i.registry.newDealsPaused) plan.blockers.push("new_deals_paused");
    if (i.registry.feeBps <= 0) plan.blockers.push("fee_bps_zero");
    if (!i.registry.allowed) plan.blockers.push("collateral_not_allowed");
    else if (i.collateral.amount < i.registry.minAmount || i.collateral.amount > i.registry.maxDealRaw) plan.blockers.push("collateral_amount_out_of_range");
  }
  for (const bucket of BUCKETS) {
    const remaining = bucket === 7 ? i.remaining7 : i.remaining21;
    const rate = bucket === 7 ? i.rates.rate7 : i.rates.rate21;
    const termAllowed = bucket === 7 ? i.registry?.term7Allowed : i.registry?.term21Allowed;
    if (remaining === 0n) { plan.skipped.push(`no_remainder:${bucket}`); continue; }
    if (i.covered.includes(bucket)) { plan.skipped.push(`already_backstopped:${bucket}`); continue; }
    if (termAllowed === false) { plan.skipped.push(`term_not_allowed:${bucket}`); continue; }
    if (rate === 0n) { plan.skipped.push(`rate_zero:${bucket}`); continue; }
    const size = sizeBackstop({ remaining, rate, priceUSDGPerSGAGE: i.rates.priceUSDGPerSGAGE, usdgUnit: i.usdgUnit,
      maxRewardShareBps: i.maxRewardShareBps, feeBps: i.registry?.feeBps ?? 0 });
    if (size === undefined) { plan.skipped.push(`unsizable:${bucket}`); continue; }
    plan.deals.push({ bucket, term: bucket * DAY, remaining, rate, ...size });
    plan.usdgNeeded += size.price + size.fee;
    plan.collateralNeeded += i.collateral?.amount ?? 0n;
  }
  if (i.collateral !== undefined && i.registry !== undefined && plan.deals.length > 0
    && i.collateral.open + plan.collateralNeeded > i.registry.maxOpenRaw) plan.blockers.push("collateral_open_cap");
  return plan;
}

export interface PhaseInput {
  /** Unix seconds. */
  now: number;
  currentEpoch: bigint;
  weeks: bigint;
  /** `epochStart(currentEpoch + 1)` and `epochStart(currentEpoch)`, unix seconds. */
  nextBoundary: number;
  lastBoundary: number;
  windowSeconds: number;
  graceSeconds: number;
}

export type Phase = { phase: "fund"; epoch: bigint } | { phase: "grace"; epoch: bigint };

/**
 * Pure. "fund" inside the last window of the current epoch (new deals are funded and registered now); "grace" inside
 * REGISTRATION_GRACE after a boundary (only registrations of deals funded before it can still land).
 */
export function decideBackstopPhase(i: PhaseInput): Phase | undefined {
  if (i.currentEpoch >= i.weeks) return undefined;
  if (i.now >= i.nextBoundary - i.windowSeconds && i.now < i.nextBoundary) return { phase: "fund", epoch: i.currentEpoch };
  if (i.currentEpoch > 0n && i.now >= i.lastBoundary && i.now < i.lastBoundary + i.graceSeconds) return { phase: "grace", epoch: i.currentEpoch - 1n };
  return undefined;
}

interface Wiring {
  vault: Address;
  dealRewards: Address;
  usdg: Address;
  signer: Address;
  currentEpoch: bigint;
}

/** The tokenId a `list` transaction created: the receipt's `Listed` event for the wallet, else the simulated return. */
async function listedDealId(ctx: JobContext, out: Extract<Outcome, { status: "sent" }>, signer: Address): Promise<bigint | undefined> {
  const pub = ctx.publicClient;
  if (pub !== undefined) {
    try {
      const receipt = await pub.getTransactionReceipt({ hash: out.hash });
      const listed = parseEventLogs({ abi: dealVaultAbi, logs: receipt.logs, eventName: "Listed" });
      const mine = listed.find((l) => l.args.borrower.toLowerCase() === signer.toLowerCase());
      if (mine !== undefined) return mine.args.dealId;
    } catch {
      ctx.log.warn("backstop_receipt_unavailable", { hash: out.hash });
    }
  }
  return typeof out.result === "bigint" ? out.result : undefined;
}

async function ensureAllowance(ctx: JobContext, token: Address, owner: Address, spender: Address, amount: bigint, label: string): Promise<boolean> {
  const allowance = await ctx.views.erc20Allowance(token, owner, spender);
  if (allowance >= amount) return true;
  const out = await ctx.sender.execute({ label, address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  return out.status === "sent" || out.status === "dry";
}

/**
 * Moves one tracked deal forward by reading its on-chain state: LISTED -> fund (or cancel once its epoch is gone),
 * FUNDED -> register, withdraw the borrower credit, reclaim; RECLAIMED/CANCELLED -> withdraw USDG and collateral,
 * then done. Stops at the first step that is not confirmed.
 */
async function advance(ctx: JobContext, w: Wiring, r: BackstopRecord): Promise<void> {
  const dealId = BigInt(r.dealId);
  const token = r.token as Address;
  const log = ctx.log.child({ backstopDeal: r.dealId, bucket: r.bucket, epoch: r.epoch });
  const send = (label: string, functionName: string, args: readonly unknown[] = []): Promise<Outcome> =>
    ctx.sender.execute({ label, address: w.vault, abi: dealVaultAbi, functionName, args });
  const ok = (o: Outcome): boolean => o.status === "sent";
  const settle = async (): Promise<boolean> => {
    if ((await ctx.views.vaultBalanceUSDG(w.vault, w.signer)) > 0n && !ok(await send("DealVault.withdrawUSDG", "withdrawUSDG"))) return false;
    if ((await ctx.views.vaultBalanceERC20(w.vault, w.signer, token)) > 0n && !ok(await send("DealVault.withdrawERC20", "withdrawERC20", [token]))) return false;
    return true;
  };
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const deal = await ctx.views.deal(w.vault, dealId);
    if (deal.state === DealState.LISTED) {
      if (BigInt(r.epoch) < w.currentEpoch) {
        log.warn("backstop_listing_stale", { reason: "epoch ended before funding; cancelling" });
        if (!ok(await send("DealVault.cancel", "cancel", [dealId]))) return;
        continue;
      }
      // fund pulls the price now and reclaim pulls the cap later: one allowance for both.
      if (!(await ensureAllowance(ctx, w.usdg, w.signer, w.vault, deal.cap + deal.cap, "USDG.approve"))) return;
      if (!ok(await send("DealVault.fund", "fund", [dealId, w.signer]))) return;
      log.info("backstop_funded", { price: deal.cap });
      continue;
    }
    if (deal.state === DealState.FUNDED) {
      const [registered] = await ctx.views.registered(w.dealRewards, [dealId]);
      if (registered !== true) {
        const out = await ctx.sender.execute({ label: "DealRewards.register", address: w.dealRewards, abi: dealRewardsAbi, functionName: "register", args: [dealId] });
        if (out.status === "reverted" && out.revert.name !== "AlreadyRegistered") {
          r.retryAfter = ctx.now() + REGISTER_RETRY_MS;
          log.warn("backstop_register_reverted", { error: out.revert.name, retryInMs: REGISTER_RETRY_MS });
          return;
        }
        if (!ok(out) && !(out.status === "reverted")) return;
        log.info("backstop_registered", { fee: deal.fee, expectedReservation: r.reservation });
        if (!ctx.state.registered.includes(r.dealId)) ctx.state.registered.push(r.dealId);
        continue;
      }
      if ((await ctx.views.vaultBalanceUSDG(w.vault, w.signer)) > 0n && !ok(await send("DealVault.withdrawUSDG", "withdrawUSDG"))) return;
      if (!(await ensureAllowance(ctx, w.usdg, w.signer, w.vault, deal.cap, "USDG.approve"))) return;
      if (!ok(await send("DealVault.reclaim", "reclaim", [dealId]))) return;
      log.info("backstop_reclaimed", { cap: deal.cap });
      continue;
    }
    // RECLAIMED, CLAIMED, CANCELLED (or NONE, which cannot be ours): pull what is owed and close the record.
    if (!(await settle())) return;
    r.done = true;
    log.info("backstop_done", { state: deal.state });
    return;
  }
}

export async function runBackstop(ctx: JobContext): Promise<void> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "backstop", ["LPStreamer", "DealVault", "CollateralRegistry", "Emissions", "DealRewards", "USDG"]);
  if (addrs === undefined) return;
  const [, vault, registry, emissions, dealRewards, usdg] = addrs as [Address, Address, Address, Address, Address, Address];
  const signer = ctx.signerAddress;
  const armed = ctx.config.backstopEnabled && ctx.config.hasKey && signer !== undefined;

  const s = await ctx.views.emissionsState(emissions);
  if (s.launchAt === 0n) {
    ctx.log.info("backstop_not_launched", { emissions });
    return;
  }
  const now = nowSeconds(ctx);
  const lastBoundary = Number(s.launchAt + s.currentEpoch * s.epochSeconds);
  const nextBoundary = Number(s.launchAt + (s.currentEpoch + 1n) * s.epochSeconds);

  // 1. Finish what earlier runs started, whatever the phase.
  const open = Object.values(ctx.state.backstop).filter((r) => !r.done);
  if (open.length > 0) {
    if (!armed || signer === undefined) ctx.log.warn("backstop_open_deals_paused", { deals: open.map((r) => r.dealId), reason: "backstop disabled or no wallet" });
    else {
      for (const r of open) {
        if ((r.retryAfter ?? 0) > ctx.now()) continue;
        await advance(ctx, { vault, dealRewards, usdg, signer, currentEpoch: s.currentEpoch }, r);
      }
    }
  }

  // 2. Where in the week are we?
  const phase = decideBackstopPhase({ now, currentEpoch: s.currentEpoch, weeks: s.weeks, nextBoundary, lastBoundary,
    windowSeconds: ctx.config.backstopWindowSeconds, graceSeconds: Math.floor(ctx.config.registrationGraceMs / 1000) });
  if (phase === undefined) {
    ctx.log.info("backstop_idle", { currentEpoch: s.currentEpoch, secondsToWindow: nextBoundary - ctx.config.backstopWindowSeconds - now });
    return;
  }
  const remaining = await ctx.views.epochRemaining(emissions, phase.epoch);
  const total = remaining.remaining7 + remaining.remaining21;
  if (phase.phase === "grace") {
    ctx.log.info("backstop_grace", { epoch: phase.epoch, remaining7: remaining.remaining7, remaining21: remaining.remaining21, total,
      note: "funding closed for this epoch (register uses epochOf(fundedAt)); only registrations of funded backstop deals can still land" });
    return;
  }

  // 3. The plan, always logged with every amount.
  const [rates, constants, usdgDecimals] = await Promise.all([
    ctx.views.effectiveRates(dealRewards, phase.epoch), ctx.views.dealRewardsConstants(dealRewards), ctx.usdgDecimals()]);
  const token = ctx.config.backstopCollateralToken ?? d.addresses.WETH;
  const registryConfig = token === undefined ? undefined : await ctx.views.registryConfig(registry, token);
  const amount = ctx.config.backstopCollateralAmount ?? registryConfig?.minAmount;
  const collateral = token !== undefined && amount !== undefined ? { token, amount, open: await ctx.views.openRaw(vault, token) } : undefined;
  const covered = Object.values(ctx.state.backstop).filter((r) => r.epoch === phase.epoch.toString()).map((r) => r.bucket);
  const plan = planBackstop({ epoch: phase.epoch, remaining7: remaining.remaining7, remaining21: remaining.remaining21, rates,
    usdgUnit: constants.usdgUnit, maxRewardShareBps: constants.maxRewardShareBps, registry: registryConfig, collateral,
    minSgage: parseDecimal(ctx.config.backstopMinSgage, 18), covered });
  const usdgHuman = (v: bigint): string => formatUnits(v, usdgDecimals);
  const sgageHuman = (v: bigint): string => formatUnits(v, 18);
  ctx.log.info("backstop_plan", {
    mode: !armed ? "plan_only" : ctx.config.dryRun ? "simulation" : "live",
    epoch: phase.epoch, secondsToBoundary: nextBoundary - now,
    remaining: { term7: sgageHuman(remaining.remaining7), term21: sgageHuman(remaining.remaining21), total: sgageHuman(total), threshold: ctx.config.backstopMinSgage },
    rates: { rate7: rates.rate7, rate21: rates.rate21, priceUSDGPerSGAGE: rates.priceUSDGPerSGAGE, lenderShareBps: rates.lenderShareBps, set: rates.set },
    collateral: collateral === undefined ? null : { token: collateral.token, amount: collateral.amount, open: collateral.open,
      minAmount: registryConfig?.minAmount, maxDealRaw: registryConfig?.maxDealRaw, maxOpenRaw: registryConfig?.maxOpenRaw, allowed: registryConfig?.allowed },
    feeBps: registryConfig?.feeBps ?? null,
    deals: plan.deals.map((p) => ({ bucket: p.bucket, term: p.term, remaining: sgageHuman(p.remaining), rate: p.rate,
      priceUSDG: usdgHuman(p.price), feeUSDG: usdgHuman(p.fee), expectedReservation: sgageHuman(p.reservation), raw: { price: p.price, fee: p.fee, reservation: p.reservation } })),
    usdgNeeded: usdgHuman(plan.usdgNeeded), collateralNeeded: plan.collateralNeeded,
    blockers: plan.blockers, skipped: plan.skipped,
  });
  if (!plan.aboveThreshold || plan.deals.length === 0 || plan.blockers.length > 0) return;
  if (!armed || signer === undefined || collateral === undefined) {
    ctx.log.info("backstop_plan_only", { reason: !ctx.config.backstopEnabled ? "BACKSTOP_ENABLED is not true" : "no KEEPER_KEY" });
    return;
  }

  // 4. The wallet must hold what the whole plan pulls before the first transaction goes out.
  const [usdgBalance, collateralBalance] = await Promise.all([ctx.views.erc20Balance(usdg, signer), ctx.views.erc20Balance(collateral.token, signer)]);
  if (usdgBalance < plan.usdgNeeded || collateralBalance < plan.collateralNeeded) {
    ctx.log.warn("backstop_underfunded", { keeper: signer, usdg: { have: usdgHuman(usdgBalance), need: usdgHuman(plan.usdgNeeded) },
      collateral: { token: collateral.token, have: collateralBalance, need: plan.collateralNeeded } });
    return;
  }

  // 5. One deal per bucket: list, then advance through fund, register, reclaim and the withdrawals.
  for (const p of plan.deals) {
    if (!(await ensureAllowance(ctx, collateral.token, signer, vault, collateral.amount, "Collateral.approve"))) return;
    const out = await ctx.sender.execute({
      label: "DealVault.list", address: vault, abi: dealVaultAbi, functionName: "list",
      args: [{ kind: 0, token: collateral.token, amountOrTokenId: collateral.amount }, p.price, p.term, 0, p.price],
    });
    if (out.status === "dry") {
      ctx.log.info("backstop_dry_run", { bucket: p.bucket, note: "list simulated only; fund, register and reclaim need the listed deal" });
      continue;
    }
    if (out.status !== "sent") {
      ctx.log.warn("backstop_list_failed", { bucket: p.bucket, status: out.status });
      return;
    }
    const dealId = await listedDealId(ctx, out, signer);
    if (dealId === undefined) {
      ctx.log.error("backstop_deal_id_unknown", { hash: out.hash, bucket: p.bucket, note: "collateral is listed; cancel or fund by hand" });
      return;
    }
    const record: BackstopRecord = { dealId: dealId.toString(), epoch: phase.epoch.toString(), bucket: p.bucket, term: p.term,
      token: collateral.token, amount: collateral.amount.toString(), price: p.price.toString(), fee: p.fee.toString(),
      reservation: p.reservation.toString(), createdAt: ctx.now(), done: false };
    ctx.state.backstop[record.dealId] = record;
    if (!ctx.state.backstopDeals.includes(record.dealId)) ctx.state.backstopDeals.push(record.dealId);
    ctx.log.info("backstop_listed", { dealId: record.dealId, bucket: p.bucket, priceUSDG: usdgHuman(p.price), feeUSDG: usdgHuman(p.fee) });
    await advance(ctx, { vault, dealRewards, usdg, signer, currentEpoch: s.currentEpoch }, record);
  }
}
