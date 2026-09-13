import { describe, expect, it, vi } from "vitest";
import { shouldForwardLPFees, forwardLPFees } from "../src/jobs/lp-fees.js";
import { mockCtx, m6Deployment, A } from "./helpers.js";
import type { Chain, PublicClient, Transport } from "viem";
describe("LP fee forwarding",()=>{
 it("aggregates V1 and V2 for the existing trigger, without dust conversions",()=>{
  expect(shouldForwardLPFees(90n,9n,100n,0n)).toBe(false);
  expect(shouldForwardLPFees(90n,10n,100n,0n)).toBe(true);
  expect(shouldForwardLPFees(0n,1n,100n,5n)).toBe(true);
  expect(shouldForwardLPFees(100n,0n,100n,0n)).toBe(false);
 });
 it("refuses forwarding when the immutable processor binding is wrong",async()=>{
  const ctx=mockCtx();const d=m6Deployment();
  d.lpFeeForwarders=[A.registry];d.addresses.DealFeeRouter=A.vault;d.addresses.CreatorFeeSplitter=A.registry;
  ctx.deployment=()=>d;
  const read=vi.fn((p:{functionName:string})=>Promise.resolve(p.functionName==='PROCESSOR'?A.registry:p.functionName==='USDG'?d.addresses.USDG:100n));
  await expect(forwardLPFees(ctx,{readContract:read} as unknown as PublicClient<Transport,Chain>)).rejects.toThrow('binding mismatch');
  expect(ctx.sender.calls).toHaveLength(0);
 });
 it("delivers native sale fee credit only to its bound floor processor",async()=>{
  const ctx=mockCtx();const d=m6Deployment();
  d.v2FeeVaults=[A.registry];d.addresses.DealFeeRouter=A.vault;d.addresses.CreatorFeeSplitter=A.registry;
  ctx.deployment=()=>d;
  const values:Record<string,unknown>={FEE_RECIPIENT:A.vault,USDG:d.addresses.USDG,cashCredit:10_000_000n,availableUSDG:90_000_000n,threshold:100_000_000n,batchRemaining:0n,ethValueUSDG:2_000_000_000n};
  const read=vi.fn((p:{functionName:string})=>Promise.resolve(values[p.functionName]));
  await forwardLPFees(ctx,{readContract:read} as unknown as PublicClient<Transport,Chain>);
  expect(ctx.sender.calls).toHaveLength(1);
  expect(ctx.sender.calls[0]).toMatchObject({address:A.registry,functionName:'withdrawUSDGFor',args:[A.vault]});
  values.FEE_RECIPIENT=A.registry;
  await expect(forwardLPFees(ctx,{readContract:read} as unknown as PublicClient<Transport,Chain>)).rejects.toThrow('binding mismatch');
  expect(ctx.sender.calls).toHaveLength(1);
 });
});
