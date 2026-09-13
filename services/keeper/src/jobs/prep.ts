/**
 * Weekly owner proposal. Within EPOCH_PREP_LEAD of the next epoch boundary (checked hourly), or on `--prep-epoch`,
 * writes `out/epoch-<n>.json`: a proposal for `setEpochRates(n, rate7, rate21, priceUSDGPerSGAGE, lenderShareBps)`
 * built from the ending epoch's `Funded.fee` totals per term and the sampled pool price, so that each term's
 * budget lasts the week and the 80% rule holds. An unsigned file for owner review; never a transaction.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, type Address } from "viem";
import { dealRewardsAbi } from "../abi.js";
import { need, nowSeconds, type JobContext } from "../context.js";
import { extrapolate, proposeRates } from "../math.js";
import { TARGET_BPS, validatedPrice } from "../rate-policy.js";
import type { FundedRecord } from "../state.js";
import { samplePrice } from "./price.js";
import { syncFunded } from "./register.js";

const DAY = 86_400;

/** Pure. Sum of fees per term for deals funded in [start, end). Terms other than 7 and 21 days earn nothing. */
export function feesByTerm(
  funded: Readonly<Record<string, FundedRecord>>,
  start: number,
  end: number,
): { fees7: bigint; fees21: bigint; deals7: number; deals21: number; otherTerms: number } {
  let fees7 = 0n;
  let fees21 = 0n;
  let deals7 = 0;
  let deals21 = 0;
  let otherTerms = 0;
  for (const r of Object.values(funded)) {
    if (r.fundedAt < start || r.fundedAt >= end) continue;
    const term = r.expiry - r.fundedAt;
    if (term === 7 * DAY) {
      fees7 += BigInt(r.fee);
      deals7 += 1;
    } else if (term === 21 * DAY) {
      fees21 += BigInt(r.fee);
      deals21 += 1;
    } else otherTerms += 1;
  }
  return { fees7, fees21, deals7, deals21, otherTerms };
}

/** Pure. The epoch to prepare now, or undefined. */
export function decidePrep(i: {
  launchAt: bigint;
  currentEpoch: bigint;
  weeks: bigint;
  nextEpochStart: number;
  now: number;
  leadSeconds: number;
  written: readonly string[];
  force: boolean;
}): bigint | undefined {
  if (i.launchAt === 0n) return undefined;
  const target = i.currentEpoch + 1n;
  if (target >= i.weeks) return undefined;
  if (i.written.includes(target.toString()) && !i.force) return undefined;
  if (!i.force && i.nextEpochStart - i.now > i.leadSeconds) return undefined;
  return target;
}

export interface Proposal {
  epoch: string;
  generatedAt: string;
  chainId: number;
  dealRewards: Address;
  basis: Record<string, unknown>;
  proposal: { rate7: string; rate21: string; priceUSDGPerSGAGE: string; lenderShareBps: number };
  notes: string[];
  tx: { to: Address; data: `0x${string}`; cast: string };
}

export async function buildProposal(ctx: JobContext, target: bigint): Promise<Proposal | undefined> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "prep", ["Emissions", "DealRewards", "DealVault"]);
  if (addrs === undefined) return undefined;
  const [emissions, dealRewards, vault] = addrs as [Address, Address, Address];

  await syncFunded(ctx, vault);
  const spot = await samplePrice(ctx);
  const now = nowSeconds(ctx);
  const windowSeconds = Math.floor(ctx.config.twapWindowMs / 1000);
  if (spot === undefined) {
    ctx.log.warn("prep_no_price", { reason: "no price samples and no pools to sample" });
    return undefined;
  }
  const twap = validatedPrice(ctx.state.priceSamples, now, spot, true);
  const price = twap.price;
  if (price <= 0n) {
    ctx.log.warn("prep_no_price", { reason: "price below supported precision" });
    return undefined;
  }

  const [constants, budgets, basisStart, basisEnd] = await Promise.all([
    ctx.views.dealRewardsConstants(dealRewards),
    ctx.views.dealBudgets(emissions, target),
    ctx.views.epochStart(emissions, target - 1n),
    ctx.views.epochStart(emissions, target),
  ]);
  const windowLen = Number(basisEnd - basisStart);
  const elapsed = Math.min(windowLen, Math.max(0, now - Number(basisStart)));
  const fees = feesByTerm(ctx.state.funded, Number(basisStart), Number(basisEnd));
  const fees7 = extrapolate(fees.fees7, elapsed, windowLen);
  const fees21 = extrapolate(fees.fees21, elapsed, windowLen);
  const rates = proposeRates({
    budget7: budgets.budget7,
    budget21: budgets.budget21,
    fees7,
    fees21,
    usdgUnit: constants.usdgUnit,
    priceUSDGPerSGAGE: price,
    maxRewardShareBps: Math.min(TARGET_BPS, constants.maxRewardShareBps),
  });
  const notes = [...rates.notes];
  if (twap.downsideDivergence) notes.push("spot is over 20% below TWAP: only reductions to the existing effective allocation may be signed");
  if (elapsed < windowLen) notes.push(`basis epoch incomplete: fees extrapolated from ${elapsed}s of ${windowLen}s`);
  if (fees.otherTerms > 0) notes.push(`${fees.otherTerms} deals with terms other than 7 or 21 days were ignored`);

  const args = [target, rates.rate7, rates.rate21, price, ctx.config.lenderShareBps] as const;
  const data = encodeFunctionData({ abi: dealRewardsAbi, functionName: "setEpochRates", args });
  return {
    epoch: target.toString(),
    generatedAt: new Date(ctx.now()).toISOString(),
    chainId: ctx.config.chainId,
    dealRewards,
    basis: {
      feesEpoch: (target - 1n).toString(),
      window: { start: Number(basisStart), end: Number(basisEnd), elapsedSeconds: elapsed, complete: elapsed >= windowLen },
      fundedDeals: { term7: fees.deals7, term21: fees.deals21, otherTerms: fees.otherTerms },
      feesSoFar: { term7: fees.fees7.toString(), term21: fees.fees21.toString() },
      feesFullWeek: { term7: fees7.toString(), term21: fees21.toString() },
      budgets: { term7: budgets.budget7.toString(), term21: budgets.budget21.toString() },
      usdgUnit: constants.usdgUnit.toString(),
      maxRewardShareBps: constants.maxRewardShareBps,
      targetRewardShareBps: TARGET_BPS,
      price: {
        priceUSDGPerSGAGE: price.toString(),
        source: twap.source,
        spot: twap.spot.toString(),
        twap: twap.twap.toString(),
        maxGapSeconds: twap.maxGapSeconds,
        downsideDivergence: twap.downsideDivergence,
        samples: twap.samples,
        coverageSeconds: twap.coverageSeconds,
        blockNumber: ctx.state.priceSamples.at(-1)?.blockNumber,
        windowSeconds,
      },
      rateCap: rates.rateCap.toString(),
      capped: { term7: rates.capped7, term21: rates.capped21 },
    },
    proposal: {
      rate7: rates.rate7.toString(),
      rate21: rates.rate21.toString(),
      priceUSDGPerSGAGE: price.toString(),
      lenderShareBps: ctx.config.lenderShareBps,
    },
    notes,
    tx: {
      to: dealRewards,
      data,
      cast: `cast send ${dealRewards} 'setEpochRates(uint256,uint128,uint128,uint128,uint16)' ${target} ${rates.rate7} ${rates.rate21} ${price} ${ctx.config.lenderShareBps} --rpc-url $RPC_URL --account <DEPLOYMENT_WALLET_KEYSTORE>`,
    },
  };
}

export function writeProposal(outDir: string, p: Proposal): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `epoch-${p.epoch}.json`);
  writeFileSync(path, JSON.stringify(p, null, 2));
  return path;
}

export async function runPrep(ctx: JobContext, force = false, epochOverride?: bigint): Promise<void> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "prep", ["Emissions", "DealRewards", "DealVault"]);
  if (addrs === undefined) return;
  const [emissions] = addrs as [Address];
  const s = await ctx.views.emissionsState(emissions);
  if (s.launchAt === 0n) {
    ctx.log.info("prep_not_launched", { emissions });
    return;
  }
  const nextEpochStart = Number(await ctx.views.epochStart(emissions, s.currentEpoch + 1n));
  const target =
    epochOverride ??
    decidePrep({
      launchAt: s.launchAt,
      currentEpoch: s.currentEpoch,
      weeks: s.weeks,
      nextEpochStart,
      now: nowSeconds(ctx),
      leadSeconds: Math.floor(ctx.config.epochPrepLeadMs / 1000),
      written: ctx.state.proposalsWritten,
      force,
    });
  if (target === undefined) {
    ctx.log.info("prep_not_due", { currentEpoch: s.currentEpoch, secondsToBoundary: nextEpochStart - nowSeconds(ctx) });
    return;
  }
  const proposal = await buildProposal(ctx, target);
  if (proposal === undefined) return;
  const path = writeProposal(ctx.config.outDir, proposal);
  if (!ctx.state.proposalsWritten.includes(proposal.epoch)) ctx.state.proposalsWritten.push(proposal.epoch);
  ctx.log.info("proposal_written", { path, epoch: proposal.epoch, ...proposal.proposal, notes: proposal.notes });
}
