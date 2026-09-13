import { parseAbi, type Chain, type PublicClient, type Transport } from "viem";
import type { JobContext } from "../context.js";
import { floorFeeAbi } from "./floor-fees.js";
const abi = parseAbi([
  "function PROCESSOR() view returns(address)", "function USDG() view returns(address)",
  "function availableUSDG() view returns(uint256)", "function forward() returns(uint256)",
]);
const v2Abi = parseAbi([
  "function FEE_RECIPIENT() view returns(address)", "function USDG() view returns(address)",
  "function cashCredit(address) view returns(uint256)", "function withdrawUSDGFor(address)",
]);
export function shouldForwardLPFees(routerAvailable: bigint, pending: bigint, threshold: bigint, batchRemaining: bigint): boolean {
  return pending > 0n && (routerAvailable + pending >= threshold || batchRemaining > 0n);
}
/** Same keeper, wallet and conversion threshold as V1. No separate reward registrations or emissions. */
export async function forwardLPFees(ctx: JobContext, pub: PublicClient<Transport, Chain>): Promise<void> {
  const d = ctx.deployment(), list = d.lpFeeForwarders ?? [], native = d.v2FeeVaults ?? [];
  if (!list.length && !native.length) return;
  const router = d.addresses.DealFeeRouter, usdg = d.addresses.USDG, floor = d.addresses.CreatorFeeSplitter;
  if (!router || !usdg || !floor) throw new Error("LP fee forwarding needs the existing processor");
  const pending = await Promise.all(list.map(async address => {
    const [processor, token, balance] = await Promise.all([
      pub.readContract({address, abi, functionName:"PROCESSOR"}),
      pub.readContract({address, abi, functionName:"USDG"}),
      pub.readContract({address, abi, functionName:"availableUSDG"}),
    ]);
    if (processor.toLowerCase() !== router.toLowerCase() || token.toLowerCase() !== usdg.toLowerCase()) throw new Error("LP fee forwarder binding mismatch");
    return { address, balance, native: false };
  }));
  pending.push(...await Promise.all(native.map(async address => {
    const [processor, token, balance] = await Promise.all([
      pub.readContract({address, abi:v2Abi, functionName:"FEE_RECIPIENT"}),
      pub.readContract({address, abi:v2Abi, functionName:"USDG"}),
      pub.readContract({address, abi:v2Abi, functionName:"cashCredit", args:[router]}),
    ]);
    if (processor.toLowerCase() !== router.toLowerCase() || token.toLowerCase() !== usdg.toLowerCase()) throw new Error("V2 fee vault binding mismatch");
    return {address, balance, native:true};
  })));
  const [available, threshold, batch, ethPrice] = await Promise.all([
    pub.readContract({address:router, abi:floorFeeAbi, functionName:"availableUSDG"}),
    pub.readContract({address:router, abi:floorFeeAbi, functionName:"threshold"}),
    pub.readContract({address:router, abi:floorFeeAbi, functionName:"batchRemaining"}),
    pub.readContract({address:floor, abi:floorFeeAbi, functionName:"ethValueUSDG", args:[10n ** 18n]}),
  ]);
  if (ethPrice <= 0n) throw new Error("LP fee price unavailable");
  const total = pending.reduce((s, p) => s + p.balance, 0n);
  if (!shouldForwardLPFees(available, total, threshold, batch)) return;
  for (const p of pending) if (p.balance > 0n) {
    await ctx.sender.execute({...p.native
      ? {label:"V2.withdrawUSDGFor", address:p.address, abi:v2Abi, functionName:"withdrawUSDGFor", args:[router]}
      : {label:"LPFeeForwarder.forward",address:p.address,abi,functionName:"forward"},
      maxGasCostWei: p.balance * 10n ** 18n / ethPrice / 100n});
  }
}
