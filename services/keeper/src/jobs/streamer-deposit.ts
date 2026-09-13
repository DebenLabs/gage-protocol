/**
 * Hourly: feed the streamer (D64). The keeper wallet is both parties of every backstop deal it created, so the
 * reservations DealRewards granted land in its own drips (`keccak256(abi.encode("deal", dealId, party))`). This job
 * claims what those drips have unlocked, then deposits the wallet's whole sGAGE balance into `LPStreamer.deposit`
 * once it is at least STREAMER_DEPOSIT_MIN_SGAGE; the deposit is the next epoch's pot. `deposit` reverts `ScheduleOver`
 * once the next epoch would be the last one of the table, so the job stops itself first.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { dripAbi, erc20Abi, lpStreamerAbi } from "../abi.js";
import { parseDecimal } from "../config.js";
import { need, type JobContext } from "../context.js";

/** `DealRewards.dripIdOf(dealId, party)`: keccak256(abi.encode("deal", dealId, party)). Pure. */
export function dripIdOf(dealId: bigint, party: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }], ["deal", dealId, party]));
}

export interface DepositDecisionInput {
  currentEpoch: bigint;
  weeks: bigint;
  /** The wallet's sGAGE balance, raw units. */
  balance: bigint;
  /** STREAMER_DEPOSIT_MIN_SGAGE in raw units. */
  minimum: bigint;
}

export type DepositDecision =
  | { action: "deposit"; amount: bigint; forEpoch: bigint }
  | { action: "skip"; reason: "schedule_over" | "below_minimum" };

/** Pure. The contract refuses a deposit for epoch `WEEKS` or later; below the minimum the balance waits. */
export function decideDeposit(i: DepositDecisionInput): DepositDecision {
  if (i.currentEpoch + 1n >= i.weeks) return { action: "skip", reason: "schedule_over" };
  if (i.balance < i.minimum || i.balance === 0n) return { action: "skip", reason: "below_minimum" };
  return { action: "deposit", amount: i.balance, forEpoch: i.currentEpoch + 1n };
}

export async function runStreamerDeposit(ctx: JobContext): Promise<void> {
  const d = ctx.deployment();
  const addrs = need(ctx, d, "streamerDeposit", ["LPStreamer", "Emissions", "sGAGE"]);
  if (addrs === undefined) return;
  const [streamer, emissions, sgage] = addrs as [Address, Address, Address];
  const signer = ctx.signerAddress;
  if (signer === undefined) {
    ctx.log.info("job_skipped", { job: "streamerDeposit", reason: "no_wallet" });
    return;
  }
  const s = await ctx.views.emissionsState(emissions);
  if (s.launchAt === 0n) {
    ctx.log.info("streamer_deposit_not_launched", { emissions });
    return;
  }
  if (s.currentEpoch + 1n >= s.weeks) {
    ctx.log.info("streamer_deposit_skipped", { reason: "schedule_over", currentEpoch: s.currentEpoch, weeks: s.weeks });
    return;
  }

  // 1. Claim what the backstop deals' drips have unlocked for the wallet.
  const drip = d.addresses.Drip;
  const dealIds = ctx.state.backstopDeals.map(BigInt);
  if (drip !== undefined && dealIds.length > 0) {
    const ids = dealIds.map((id) => dripIdOf(id, signer));
    const claimable = await ctx.views.dripClaimable(drip, signer, ids);
    const due = ids.filter((_, i) => (claimable[i] ?? 0n) > 0n);
    const total = claimable.reduce((a, b) => a + b, 0n);
    ctx.log.info("streamer_drips", { deals: dealIds.length, claimable: total, due: due.length });
    if (due.length > 0) {
      const out = await ctx.sender.execute({ label: "Drip.claimMany", address: drip, abi: dripAbi, functionName: "claimMany", args: [due] });
      if (out.status === "refused") return;
    }
  }

  // 2. Deposit the whole balance once it is worth a transaction.
  const balance = await ctx.views.erc20Balance(sgage, signer);
  const decision = decideDeposit({ currentEpoch: s.currentEpoch, weeks: s.weeks, balance, minimum: parseDecimal(ctx.config.streamerDepositMinSgage, 18) });
  if (decision.action === "skip") {
    ctx.log.info("streamer_deposit_skipped", { reason: decision.reason, balance, minimum: ctx.config.streamerDepositMinSgage });
    return;
  }
  const allowance = await ctx.views.erc20Allowance(sgage, signer, streamer);
  if (allowance < decision.amount) {
    const approve = await ctx.sender.execute({ label: "sGAGE.approve", address: sgage, abi: erc20Abi, functionName: "approve", args: [streamer, decision.amount] });
    if (approve.status !== "sent" && approve.status !== "dry") return;
  }
  const out = await ctx.sender.execute({ label: "LPStreamer.deposit", address: streamer, abi: lpStreamerAbi, functionName: "deposit", args: [decision.amount] });
  ctx.log.info("streamer_deposit", { amount: decision.amount, forEpoch: decision.forEpoch, status: out.status });
  if (out.status === "sent") ctx.state.lastStreamerDeposit = { amount: decision.amount.toString(), forEpoch: decision.forEpoch.toString(), at: ctx.now() };
}
