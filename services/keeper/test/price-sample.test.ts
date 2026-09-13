import {expect,it} from "vitest";
import {samplePrice} from "../src/jobs/price.js";
import {m6Deployment,mockCtx} from "./helpers.js";

it("records an upward-rounded bound for a sub-micro-USDG reward price",async()=>{
  const deployment=m6Deployment();
  const ctx=mockCtx({deployment,views:{slot0:(_view,id)=>Promise.resolve({sqrtPriceX96:id===deployment.pools.gageSgage!.poolId?(1n<<96n)*10n**10n:1n<<96n,tick:0,protocolFee:0,lpFee:0})}});
  expect(await samplePrice(ctx)).toBe(1n);
  expect(ctx.state.priceSamples).toHaveLength(1);
  expect(ctx.state.priceSamples[0]!.priceUSDGPerSGAGE).toBe("1");
  expect(ctx.lines.some(l=>l.msg==="price_sampled")).toBe(true);
});
