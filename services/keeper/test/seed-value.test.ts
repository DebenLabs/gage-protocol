import {expect,it} from "vitest";
import {seedAmounts,seedGageValue} from "../src/seed-value.js";
const Q96=1n<<96n;
it("values balanced seed fees in either token ordering with rounding down",()=>{
  expect(seedAmounts(1000n,Q96)).toEqual({amount0:999n,amount1:999n});
  expect(seedGageValue(1000n,Q96,true)).toBe(1998n);
  expect(seedGageValue(1000n,Q96,false)).toBe(1998n);
});
it("values skewed prices in GAGE units rather than assuming equal raw token amounts",()=>{
  const {amount0,amount1}=seedAmounts(10n**24n,2n*Q96);
  expect(seedGageValue(10n**24n,2n*Q96,true)).toBe(amount0+amount1/4n);
  expect(seedGageValue(10n**24n,2n*Q96,false)).toBe(amount1+amount0*4n);
});
it("keeps out-of-range positions one-sided and never values invalid liquidity",()=>{
  expect(seedAmounts(10n**24n,1n).amount1).toBe(0n);
  expect(seedAmounts(10n**24n,(1n<<160n)-1n).amount0).toBe(0n);
  expect(seedGageValue(0n,Q96,true)).toBe(0n);
  expect(seedGageValue(10n**18n,0n,true)).toBe(0n);
});
