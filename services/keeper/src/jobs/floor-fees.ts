import { parseAbi, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { parseDecimal } from "../config.js";
import type { JobContext } from "../context.js";
import type { Call, Outcome } from "../sender.js";

export const floorFeeAbi = parseAbi([
  "function threshold() view returns(uint256)",
  "function batchRemaining() view returns(uint256)",
  "function availableUSDG() view returns(uint256)",
  "function ethValueUSDG(uint256) view returns(uint256)",
  "function claim() returns(uint256)",
  "function claimAndSplit(uint256) returns(uint256)",
  "function process(uint256) returns(uint256)",
  "error BelowThreshold(uint256 balance,uint256 threshold)",
  "error ClipTooLarge(uint256 requested,uint256 available)",
  "error TooLittleOut(uint256 got,uint256 minOut)",
  "error TooMuchIn(uint256 paid,uint256 maxIn)",
  "error PartialCurveFill()",
]);
type Client = PublicClient<Transport, Chain>;
const WAD = 10n ** 18n;

/** Opening a batch needs the trigger; previously opened batches may finish below it. */
export function feeBatchClip(balance: bigint, valueUSDG: bigint, threshold: bigint, remaining: bigint, maxClip: bigint): bigint {
  const eligible = valueUSDG >= threshold ? balance : remaining < balance ? remaining : balance;
  return eligible < maxClip ? eligible : maxClip;
}

/** Search between price impact and gas limits. Only successful simulations may send a transaction. */
export async function executeFloorClip(ctx: Pick<JobContext, "sender" | "log">, initial: bigint, minimum: bigint,
  build: (clip: bigint) => Call): Promise<Outcome | undefined> {
  let clip = initial, impactUpper: bigint | undefined, gasLower: bigint | undefined;
  let last: Outcome | undefined;
  for (let tries = 0; tries < 12 && clip >= minimum && clip > 0n; tries++) {
    const result = await ctx.sender.execute(build(clip));
    last = result;
    if (result.status === "reverted" && ["TooLittleOut", "PartialCurveFill"].includes(result.revert.name)) {
      impactUpper = clip;
      ctx.log.info("floor_clip_reduced", { clip, reason: result.revert.name });
      clip = gasLower === undefined ? clip / 2n : (gasLower + clip) / 2n;
    } else if (result.status === "refused" && result.reason === "uneconomic_gas" && impactUpper !== undefined) {
      // A larger clip can amortize the same gas while still fitting below the failing impact bound.
      gasLower = clip;
      clip = (clip + impactUpper) / 2n;
      ctx.log.info("floor_clip_refined", { clip, reason: "gas_and_impact" });
    } else return result;
    if (gasLower !== undefined && (clip <= gasLower || clip >= impactUpper)) break;
  }
  ctx.log.info("floor_fees_waiting", { reason: "gas_or_pool_depth" });
  return last;
}

/** Pull and convert atomically; read-only claim simulation does not spend gas on small fee balances. */
export async function runFloorFees(ctx: JobContext, pub: Client): Promise<void> {
  const d = ctx.deployment(), router = d.addresses.DealFeeRouter, floor = d.addresses.CreatorFeeSplitter;
  if (!router || !floor) throw new Error("floor-fee-deployment-incomplete");
  const read = (address: Address, functionName: "threshold" | "batchRemaining" | "availableUSDG") =>
    pub.readContract({ address, abi: floorFeeAbi, functionName });
  const [usdgPerETH, maxClipUSDG] = await Promise.all([
    pub.readContract({ address: floor, abi: floorFeeAbi, functionName: "ethValueUSDG", args: [WAD] }),
    ctx.usdgDecimals().then(n => parseDecimal(ctx.config.maxClipUsdg, n))
  ]);
  if (usdgPerETH <= 0n) throw new Error("floor-fee-price-unavailable");
  const [balance, threshold, remaining] = await Promise.all([read(router, "availableUSDG"), read(router, "threshold"), read(router, "batchRemaining")]);
  const clip = feeBatchClip(balance, balance, threshold, remaining, maxClipUSDG);
  ctx.log.info("deal_fee_batch", { availableUSDG: balance, threshold, remaining, clip });
  if (clip > 0n) await executeFloorClip(ctx, clip, 1_000_000n, amount => ({
    label: "DealFeeRouter.process", address: router, abi: floorFeeAbi, functionName: "process", args: [amount],
    // Conservative ETH value: allow for the USDG->ETH fee and its 1% impact bound, then a 1% gas budget.
    maxGasCostWei: amount * WAD * 98n / usdgPerETH / 10_000n
  }));
  const [held, trigger, batch, claim] = await Promise.all([
    pub.getBalance({ address: floor }), read(floor, "threshold"), read(floor, "batchRemaining"),
    pub.simulateContract({ address: floor, abi: floorFeeAbi, functionName: "claim" })
  ]);
  const available = held + claim.result;
  const grossClip = feeBatchClip(available, available * usdgPerETH / WAD, trigger, batch, maxClipUSDG * 2n * WAD / usdgPerETH);
  ctx.log.info("creator_fee_batch", { availableETH: available, valueUSDG: available * usdgPerETH / WAD, threshold: trigger, remaining: batch, clip: grossClip });
  if (grossClip > 0n) await executeFloorClip(ctx, grossClip, 2_000_000n * WAD / usdgPerETH, amount => ({
    label: "FeeFloor.claimAndSplit", address: floor, abi: floorFeeAbi, functionName: "claimAndSplit", args: [amount],
    // Only the floor half is converted. The other half belongs to operations.
    maxGasCostWei: (amount - amount / 2n) / 100n
  }));
}
