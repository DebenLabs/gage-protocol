import {expect,it} from "vitest";
import {keccak256,type Chain,type PublicClient,type Transport} from "viem";
import {runSeed} from "../src/jobs/launch.js";
import {seedGageValue} from "../src/seed-value.js";
import {A,m6Deployment,mockCtx} from "./helpers.js";
const Q96=1n<<96n;
function setup(additional:bigint,curve=false,initialized=true) {
  const d=m6Deployment();d.addresses.CompoundingSeedTimelock=A.hook;
  d.seed={tokenId:3n,releaseAt:100000,owner:A.vault,codeHash:keccak256("0x6000")};
  if(curve)d.pons={curve:A.buyback,factory:A.registry};
  const ctx=mockCtx({deployment:d});
  const pub={
    getCode:()=>Promise.resolve("0x6000"),getBlock:()=>Promise.resolve({number:1n,timestamp:1000n}),
    readContract:(r:{functionName:string})=>Promise.resolve({
      TREASURY:A.vault,POSM:A.positionManager,tokenId:3n,releaseAt:100000,released:false,ownerOf:A.hook,
      previewCompound:[Q96,10n**20n,additional,10n**30n,additional],
      getSlot0:[initialized?Q96:0n,0,0,0],ethValueUSDG:2500_000_000n,threshold:100_000_000n,
      graduated:false,getReserves:[10n**18n,10n**18n]
    }[r.functionName])
  } as unknown as PublicClient<Transport,Chain>;
  return {ctx,pub};
}
it("does not compound dust or count large unmatched balances toward the value trigger",async()=>{
  const {ctx,pub}=setup(10n**15n);await runSeed(ctx,pub);expect(ctx.sender.calls).toHaveLength(0);
});
it.each([false,true])("caps gas at 1 percent of conservatively valued pairable seed fees (curve=%s)",async curve=>{
  const added=10n**17n,{ctx,pub}=setup(added,curve);await runSeed(ctx,pub);
  expect(ctx.sender.calls).toHaveLength(1);
  const call=ctx.sender.calls[0]!;
  expect(call.functionName).toBe("compound");
  expect(call.maxGasCostWei).toBe(seedGageValue(added*995n/1000n,Q96,true)*98n/10000n);
});
it("waits through a swept, uninitialized GAGE pool",async()=>{
  const {ctx,pub}=setup(10n**17n,false,false);await runSeed(ctx,pub);expect(ctx.sender.calls).toHaveLength(0);
});
