/** Explicitly enabled owner job. Positive renewal always follows a confirmed future zero. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, type Address } from "viem";
import { dealRewardsAbi, emissionsAbi } from "../abi.js";
import { nowSeconds, type JobContext } from "../context.js";
import { ALERT_BPS, MAX_POST_BPS, REFRESH_BPS, STOP_BPS, rewardValueBps, validatedPrice, type Rates } from "../rate-policy.js";
import { buildProposal, writeProposal, type Proposal } from "./prep.js";
import { samplePrice } from "./price.js";

const MAINNET_REWARDS = "0x5b95978dbe6193e9510aff8a8d78a92d84e6340d";
const MAINNET_EMISSIONS = "0x6784e12e3cf4a5bbd71406ad30ef693d819a976c";
const equal = (a: Rates, b: Rates) => a.set === b.set && a.rate7 === b.rate7 && a.rate21 === b.rate21 && a.priceUSDGPerSGAGE === b.priceUSDGPerSGAGE && a.lenderShareBps === b.lenderShareBps;
const positive = (r: Rates) => r.set && (r.rate7 > 0n || r.rate21 > 0n);
const bounded = (rate: bigint, price: bigint) => price > 0n ? (rate < 8n * 10n ** 23n / price ? rate : 8n * 10n ** 23n / price) : 0n;

export async function runRates(ctx: JobContext): Promise<void> {
  if (!ctx.config.ratesEnabled) return;
  try {
    await maintainRates(ctx);
    ctx.state.ratesHealth = { checkedAt: nowSeconds(ctx), status: "ok" };
  } catch (error) {
    // Only our fixed identifiers are public; RPC errors can contain private endpoint URLs.
    const reason = error instanceof Error && /^(rates|price)-[a-z-]+$/.test(error.message) ? error.message : "rates-operation-failed";
    ctx.state.ratesHealth = { checkedAt: nowSeconds(ctx), status: "blocked", reason };
    ctx.log.error("rates_blocked", { reason });
    throw Error(reason);
  }
}

async function maintainRates(ctx: JobContext): Promise<void> {
  if (!ctx.publicClient) throw Error("rates-configuration-missing");
  const pub = ctx.publicClient;
  const d = ctx.deployment();
  const rewards = d.addresses.DealRewards;
  const emissions = d.addresses.Emissions;
  if (!pub || !rewards || !emissions) throw Error("rates-configuration-missing");
  if (d.chainId !== ctx.config.chainId || await pub.getChainId() !== d.chainId) throw Error("rates-chain-mismatch");
  if (d.chainId === 4663 && (rewards.toLowerCase() !== MAINNET_REWARDS || emissions.toLowerCase() !== MAINNET_EMISSIONS)) throw Error("rates-contract-mismatch");
  const read = (epoch: bigint, effective = false) => pub.readContract({ address: rewards, abi: dealRewardsAbi, functionName: effective ? "effectiveRates" : "epochRates", args: [epoch] });
  const [owner, linked, unit, maximum, current, weeks] = await Promise.all([
    pub.readContract({ address: rewards, abi: dealRewardsAbi, functionName: "owner" }),
    pub.readContract({ address: rewards, abi: dealRewardsAbi, functionName: "EMISSIONS" }),
    pub.readContract({ address: rewards, abi: dealRewardsAbi, functionName: "USDG_UNIT" }),
    pub.readContract({ address: rewards, abi: dealRewardsAbi, functionName: "MAX_REWARD_SHARE_BPS" }),
    pub.readContract({ address: emissions, abi: emissionsAbi, functionName: "currentEpoch" }),
    pub.readContract({ address: emissions, abi: emissionsAbi, functionName: "WEEKS" }),
  ]);
  if (linked.toLowerCase() !== emissions.toLowerCase() || unit !== 1_000_000n || maximum !== 8000) throw Error("rates-binding-mismatch");
  if (!ctx.config.dryRun && owner.toLowerCase() !== ctx.signerAddress?.toLowerCase()) throw Error("rates-owner-mismatch");
  if (current >= weeks) return;
  const next = current + 1n;
  const start = BigInt(ctx.config.ratesStartEpoch);
  const lenderShareBps = ctx.config.lenderShareBps;
  if (next < start) return;
  // Detect explicit future positive postings that could bypass our scheduled stop.
  const future = await pub.multicall({ contracts: Array.from({ length: Number(weeks - current) }, (_, i) => ({ address: rewards, abi: dealRewardsAbi, functionName: "epochRates" as const, args: [current + BigInt(i)] as const })), allowFailure: false });
  if (future.some((r, i) => i > 1 && positive(r))) throw Error("rates-unexpected-future-posting");
  const spot = await samplePrice(ctx);
  if (!spot) throw Error("price-unavailable");
  const eligible = [current, next].filter(e => e >= start && e < weeks);
  const effective = new Map<bigint, Rates>();
  for (const epoch of eligible) effective.set(epoch, await read(epoch, true));
  for (const [epoch, rates] of effective) {
    const ratio = rewardValueBps(rates, spot);
    if (ratio >= ALERT_BPS) ctx.log.warn("rates_value_alert", { epoch, rewardValueBps: ratio });
  }
  let healthy = true;
  try { validatedPrice(ctx.state.priceSamples, nowSeconds(ctx), spot, true); }
  catch { healthy = false; }

  // All calldata and its hash are durable before execute() can sign.
  async function post(epoch: bigint, value: Rates, expected: Rates, proposal?: Proposal) {
    const data = encodeFunctionData({ abi: dealRewardsAbi, functionName: "setEpochRates", args: [epoch, value.rate7, value.rate21, value.priceUSDGPerSGAGE, value.lenderShareBps] });
    const packet = { chainId: d.chainId, contract: rewards, owner, epoch: String(epoch), value, expected, generatedAt: ctx.now(), data, proposal };
    const raw = JSON.stringify(packet, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2);
    const hash = createHash("sha256").update(raw).digest("hex");
    const dir = join(ctx.config.outDir, "rates"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${hash}.json`), raw + "\n");
    if (!equal(await read(epoch), expected)) throw Error("rates-config-changed");
    const freshEpoch = await pub.readContract({ address: emissions!, abi: emissionsAbi, functionName: "currentEpoch" });
    if (freshEpoch !== current || await pub.getChainId() !== d.chainId) throw Error("rates-epoch-changed");
    if (await pub.readContract({ address: rewards!, abi: dealRewardsAbi, functionName: "owner" }) !== owner) throw Error("rates-owner-changed");
    if (proposal) {
      if (stopEpoch < weeks) {
        const stop = await read(stopEpoch);
        if (!stop.set || positive(stop)) throw Error("rates-stop-changed");
      }
      if (ctx.now() - Date.parse(proposal.generatedAt) > 120_000) throw Error("rates-proposal-stale");
      const freshSpot = await samplePrice(ctx);
      if (!freshSpot || rewardValueBps(value, freshSpot) > MAX_POST_BPS) throw Error("rates-price-moved");
      validatedPrice(ctx.state.priceSamples, nowSeconds(ctx), freshSpot, true);
    }
    const outcome = await ctx.sender.execute({ label: "DealRewards.setEpochRates", address: rewards as Address, abi: dealRewardsAbi, functionName: "setEpochRates", args: [epoch, value.rate7, value.rate21, value.priceUSDGPerSGAGE, value.lenderShareBps] });
    writeFileSync(join(dir, `${hash}.result.json`), JSON.stringify(outcome, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2));
    if (outcome.status === "dry") return false;
    if (outcome.status !== "sent" || !equal(await read(epoch), value)) throw Error("rates-post-unconfirmed");
    ctx.log.info("rates_posted", { epoch, hash: outcome.hash, proposalHash: hash, ...value });
    return true;
  }

  if (!healthy) {
    // A fresh observation may justify stopping oversized rewards, never a positive posting.
    for (const [epoch, rates] of effective) if (rewardValueBps(rates, spot) >= STOP_BPS) {
      await post(epoch, { rate7: 0n, rate21: 0n, priceUSDGPerSGAGE: spot, lenderShareBps: rates.lenderShareBps, set: true }, await read(epoch));
    }
    throw Error("price-history-blocked");
  }
  const targets: bigint[] = [];
  for (const [epoch, rates] of effective) {
    const explicit = await read(epoch);
    const opens = Number(await pub.readContract({ address: emissions, abi: emissionsAbi, functionName: "epochStart", args: [epoch] }));
    const initial = epoch === start && !explicit.set;
    const renew = !positive(explicit) && opens - nowSeconds(ctx) <= 86_400;
    const excessive = rewardValueBps(rates, spot) >= REFRESH_BPS;
    if (initial || renew || excessive) targets.push(epoch);
  }
  // Preserve an already-approved next week when correcting the current week.
  const active = eligible.filter(e => positive(future[Number(e - current)]!));
  const furthest = [...active, ...targets].reduce((a, b) => a > b ? a : b, current);
  const stopEpoch = furthest + 1n;
  if ((active.length || targets.length) && stopEpoch < weeks) {
    const old = await read(stopEpoch);
    if (!old.set || positive(old)) {
      const confirmed = await post(stopEpoch, { rate7: 0n, rate21: 0n, priceUSDGPerSGAGE: spot, lenderShareBps, set: true }, old);
      if (!confirmed) return; // A simulated stop cannot authorize a real positive posting.
    }
  }
  for (const epoch of targets) {
    const before = await read(epoch);
    const existing = await read(epoch, true);
    const proposal = await buildProposal(ctx, epoch);
    if (!proposal) throw Error("rates-proposal-missing");
    const p = proposal.proposal;
    const value: Rates = { rate7: BigInt(p.rate7), rate21: BigInt(p.rate21), priceUSDGPerSGAGE: BigInt(p.priceUSDGPerSGAGE), lenderShareBps, set: true };
    // When spot is far below TWAP, only reducing an existing allocation is acceptable.
    const priceBasis = proposal.basis.price as { downsideDivergence?: boolean };
    if (priceBasis.downsideDivergence && (bounded(value.rate7, value.priceUSDGPerSGAGE) > bounded(existing.rate7, existing.priceUSDGPerSGAGE) || bounded(value.rate21, value.priceUSDGPerSGAGE) > bounded(existing.rate21, existing.priceUSDGPerSGAGE))) throw Error("rates-downside-increase-blocked");
    // A deliberately posted zero is the safe handoff point for a new weekly
    // borrower/lender split. Never rewrite a positive explicit or inherited
    // split implicitly.
    if (positive(existing) && existing.lenderShareBps !== lenderShareBps) throw Error("rates-split-changed");
    writeProposal(ctx.config.outDir, proposal);
    if (!equal(before, value)) await post(epoch, value, before, proposal);
  }
  ctx.log.info("rates_checked", { currentEpoch: current, spot, stopEpoch: stopEpoch < weeks ? stopEpoch : null, targets });
}
