import {describe,it,expect,vi} from 'vitest';
import type {Address,Hex} from 'viem';
import {parseDeployment,poolIdOf,NATIVE} from '../src/deployment.js';
import {ViemChainReader} from '../src/chain/viemReader.js';
import {Pricer} from '../src/pricing/pricer.js';
import {valueDeal} from '../src/valuation/deal.js';
import {A,FakeReader,fixtureDeploymentJson,sqrtPriceOf} from './helpers/fake.js';
const pool='0x0000000000000000000000000000000000000011' as Address;
const key={protocol:'v3' as const,poolAddress:pool,currency0:A.NVDAx,currency1:A.NVDOG,fee:10000,tickSpacing:200,hooks:NATIVE};
const pid=poolIdOf(key);
function deployment(){const base=fixtureDeploymentJson();return parseDeployment({...base,vaultVersion:3,V3Factory:A.pm,WETH:A.NVDAx,pools:{...(base.pools as object),v3:{...key,poolId:pid}}});}
describe('v3 valuation',()=>{
 it('includes tokens already owed plus fee growth, converts WETH through ETH/USDG, and applies the 50% suggestion',async()=>{
  const d=deployment(),r=new FakeReader();delete d.pools.nvdaUsdg;delete d.pools.nvdogNvda;
  r.configs.set(A.NVDAx,{allowed:true,lane:'ETH',minAmount:1n,maxDealRaw:1n,maxOpenRaw:1n});r.configs.set(A.NVDOG,{allowed:true,lane:'MEME',minAmount:1n,maxDealRaw:1n,maxOpenRaw:1n});
  r.metas.set(A.NVDAx,{symbol:'WETH',name:'Wrapped Ether',decimals:18});r.metas.set(A.NVDOG,{symbol:'PONS',name:'PONS',decimals:18});
  r.pools.set(pid,{sqrtPriceX96:sqrtPriceOf(1n,1n),liquidity:10n**20n,lpFee:10000});
  const deal=r.addPositionDeal(1n,7n,1000000n,key,-200,200,10n**18n);deal.kind='UNIV3_POSITION';
  r.feeGrowth.set(`${pid}:-200:200`,{inside0:1n<<128n,inside1:2n<<128n});
  vi.spyOn(r,'positionFeeState').mockResolvedValue({liquidity:10n**18n,feeGrowthInside0LastX128:0n,feeGrowthInside1LastX128:0n,tokensOwed0:9n,tokensOwed1:17n});
  const pricer=new Pricer(r,d),v=await valueDeal({reader:r,pricer},1n);
  expect(v.position!.uncollectedFees0).toBe((10n**18n+9n).toString());expect(v.position!.uncollectedFees1).toBe((2n*10n**18n+17n).toString());
  expect(v.asset.symbol).toBe('PONS');expect(v.position!.assetIsCurrency0).toBe(false);expect(Number(v.position!.quoteAsset.priceUSDG)).toBeCloseTo(3000);
  expect(v.position!.scenarioAssumption).toBe('WETH USDG price held constant; PONS price moves.');expect(v.suggestedCap.capUSDG).toBe((BigInt(v.valueUSDG)/2n).toString());expect(v.suggestedCap.shareBps).toBe(5000);
  expect(BigInt(v.scenarios.down80!)).toBeLessThan(BigInt(v.scenarios.down50));
  expect((await pricer.priceInUSDG(A.NVDOG)).pools).toContain('v3');
  await expect(pricer.bestRoute(A.NVDOG)).rejects.toMatchObject({code:'NO_ROUTE'});
 });
 it.each([{tick:0,want:70n},{tick:-201,want:(1n<<256n)-10n},{tick:200,want:10n}])('calculates fee growth inside both boundaries at tick $tick',async({tick,want})=>{
  const r=new ViemChainReader('http://127.0.0.1:1',deployment(),10000);
  vi.spyOn(r.client,'getBlockNumber').mockResolvedValue(777n);
  const calls=vi.spyOn(r.client,'readContract').mockImplementation(async(args)=>{
   expect(args.blockNumber).toBe(777n);
   if(args.functionName==='slot0')return[1n,tick,0,0,0,0,true];
   if(args.functionName.startsWith('feeGrowthGlobal'))return 100n;
   if(args.functionName==='ticks')return[1n,0n,args.args![0]===-200?10n:20n,args.args![0]===-200?10n:20n,0n,0n,0,true];
   throw Error(args.functionName);
  });
  expect(await r.feeGrowthInside(pid as Hex,-200,200)).toEqual({inside0:want,inside1:want});expect(calls).toHaveBeenCalledTimes(5);
 });
});
