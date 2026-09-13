import {describe,it,expect,vi} from 'vitest';
import type {Address} from 'viem';
import {v3WalletPositions} from '../src/lib/v3-wallet-positions';
import {parseDeployment} from '../src/lib/deployment';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const wallet=a(50),manager=a(5),factory=a(6),pool=a(7),weth=a(10),pons=a(11);
const raw={chainId:4663,vaultVersion:3,DealVault:a(1),CollateralRegistry:a(2),FeeSink:a(3),EntryRouter:a(4),USDG:a(9),PositionManager:manager,V3Factory:factory,WETH:weth,pools:{ponsWeth:{protocol:'v3',poolAddress:pool,poolId:'0x'+pool.slice(2).padStart(64,'0'),currency0:weth,currency1:pons,fee:10000,tickSpacing:200,hooks:a(0)}}};
function setup(){
 const d=parseDeployment(JSON.stringify(raw),'fixture');
 const pos=(fee=10000,liquidity=100n)=>[0n,a(0),weth,pons,fee,-200,200,liquidity,0n,0n,0n,0n];
 const positions=new Map([[1n,pos()],[2n,pos(3000)],[3n,pos(10000,0n)]]);
 const read=vi.fn(async({functionName:fn,args,blockNumber}:{functionName:string,args?:unknown[],blockNumber?:bigint})=>{
  expect(blockNumber).toBe(100n);
  if(fn==='balanceOf')return 3n;if(fn==='factory')return factory;if(fn==='WETH9')return weth;if(fn==='memePairMask')return 4;
  if(fn==='getPoolConfig')return{allowed:true,minLiquidity:1n};if(fn==='getPool')return pool;
  if(fn==='getERC20Config')return{allowed:true,lane:args![0]===weth?1:2};
  if(fn==='tokenOfOwnerByIndex')return BigInt(args![1] as bigint)+1n;
  if(fn==='positions')return positions.get(args![0] as bigint);if(fn==='ownerOf')return wallet;
  throw Error(fn);
 });
 const multi=vi.fn(async({contracts,blockNumber}:{contracts:Record<string,unknown>[],blockNumber:bigint})=>Promise.all(contracts.map(c=>read({...c,blockNumber} as Parameters<typeof read>[0]))));
 const c={getBlockNumber:vi.fn(async()=>100n),readContract:read,multicall:multi};
 return{d,c:c as unknown as Parameters<typeof v3WalletPositions>[0],read,multi};
}
describe('canonical v3 wallet enumeration',()=>{
 it('reads only owned IDs at one block, keeps the approved pool and excludes wrong fees/zero liquidity',async()=>{
  const {d,c,read,multi}=setup();const result=await v3WalletPositions(c,d,wallet);
  expect(result).toHaveLength(1);expect(result[0]).toMatchObject({tokenId:'1',protocol:'v3',positionManager:manager,poolAddress:pool,allowed:true});
  expect(read.mock.calls.filter(([x])=>x.functionName==='tokenOfOwnerByIndex').map(([x])=>x.args)).toEqual([[wallet,0n],[wallet,1n],[wallet,2n]]);
  expect(c.getBlockNumber).toHaveBeenCalledWith({cacheTime:0});
  expect(multi).toHaveBeenCalledTimes(5);
  for(const [args] of multi.mock.calls) expect(args).toMatchObject({blockNumber:100n,allowFailure:false});
 });
 it('returns an empty wallet without requesting pool configuration or NFT details',async()=>{
  const {d,c,read,multi}=setup();const original=read.getMockImplementation()!;
  read.mockImplementation(async args=>args.functionName==='balanceOf'?0n:original(args));
  expect(await v3WalletPositions(c,d,wallet)).toEqual([]);
  expect(multi).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.map(([args])=>args.functionName)).toEqual(['balanceOf','factory','WETH9','memePairMask']);
 });
 it('enumerates the first NFT batch while pool configuration is pending',async()=>{
  const {d,c,read}=setup();const original=read.getMockImplementation()!;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  read.mockImplementation(async args=>{
   if(args.functionName==='getPoolConfig') {await gate;return{allowed:false,minLiquidity:1n};}
   return original(args);
  });
  const result=v3WalletPositions(c,d,wallet);
  try {
   await vi.waitFor(()=>expect(read.mock.calls.some(([args])=>args.functionName==='tokenOfOwnerByIndex')).toBe(true));
  } finally {release();}
  expect(await result).toMatchObject([{tokenId:'1',allowed:false}]);
 });
 it('preserves complete inventory across the first and subsequent batches',async()=>{
  const {d,c,read}=setup();const original=read.getMockImplementation()!;
  read.mockImplementation(async args=>{
   if(args.functionName==='balanceOf')return 33n;
   if(args.functionName==='positions')return original({...args,args:[1n]});
   return original(args);
  });
  const result=await v3WalletPositions(c,d,wallet);
  expect(result.map(position=>position.tokenId)).toEqual(Array.from({length:33},(_,i)=>String(i+1)));
  expect(read.mock.calls.filter(([args])=>args.functionName==='tokenOfOwnerByIndex')).toHaveLength(33);
 });
 it('fails closed on inconsistent ownership instead of returning an empty or partial inventory',async()=>{
  const {d,c,read}=setup();const original=read.getMockImplementation()!;read.mockImplementation(async args=>args.functionName==='ownerOf'?a(99):original(args));
  await expect(v3WalletPositions(c,d,wallet)).rejects.toMatchObject({code:'OWNERSHIP_UNAVAILABLE'});
 });
 it('rejects a mismatched manager factory',async()=>{
  const {d,c,read}=setup();const original=read.getMockImplementation()!;read.mockImplementation(async args=>args.functionName==='factory'?a(99):original(args));
  await expect(v3WalletPositions(c,d,wallet)).rejects.toMatchObject({code:'V3_CONFIG'});
 });
 it('retains owned inventory after legacy delisting while marking it ineligible for that legacy engine',async()=>{
  const {d,c,read}=setup();const original=read.getMockImplementation()!;read.mockImplementation(async args=>args.functionName==='getPoolConfig'?{allowed:false,minLiquidity:1n}:original(args));
  expect(await v3WalletPositions(c,d,wallet)).toMatchObject([{tokenId:'1',allowed:false,positionManager:manager}]);
 });
 it('rejects a forged pool ID in configuration',()=>{
  expect(()=>parseDeployment(JSON.stringify({...raw,pools:{ponsWeth:{...raw.pools.ponsWeth,poolId:'0x'+'aa'.repeat(32)}}}),'fixture')).toThrow();
 });
});
