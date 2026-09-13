import { keccak256, parseAbi, type Account, type Chain, type PublicClient, type Transport } from "viem";
import { compoundQuote } from "../seed-policy.js";
import { seedGageValue } from "../seed-value.js";
import { priceOfIn } from "../math.js";
import { stateViewAbi } from "../abi.js";
import { floorFeeAbi } from "./floor-fees.js";
import type { JobContext } from "../context.js";

const curveAbi = parseAbi(["function graduated() view returns(bool)","function getReserves() view returns(uint256,uint256)"]);
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function createGraduatedPool(address token) returns(uint256)"
]);
const seedAbi = parseAbi([
  "function TREASURY() view returns(address)", "function POSM() view returns(address)",
  "function tokenId() view returns(uint256)", "function releaseAt() view returns(uint40)",
  "function released() view returns(bool)", "function previewCompound() view returns(uint160,uint128,uint128,uint256,uint256)",
  "function compound(uint160,uint128,uint256) returns(uint128)"
]);
const nftAbi = parseAbi(["function ownerOf(uint256) view returns(address)"]);
type Client = PublicClient<Transport, Chain>;

/** The public phase-2 call belongs in our maintenance loop; no Pons operator permission is needed. */
export async function runGraduation(ctx: JobContext, pub: Client): Promise<void> {
  const d = ctx.deployment(), p = d.pons, token = d.addresses.GAGE;
  if (!p || !token) return;
  if (!await pub.readContract({ address: p.curve, abi: curveAbi, functionName: "graduated" })) return;
  const info = await pub.readContract({ address: p.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (info.phase === 1) await ctx.sender.execute({ label: "Pons.createGraduatedPool", address: p.factory, abi: factoryAbi, functionName: "createGraduatedPool", args: [token] });
}

/** Uses the shared journal/sender, so compounding cannot race fee or epoch transactions. */
export async function runSeed(ctx: JobContext, pub: Client, account?: Account): Promise<void> {
  const d = ctx.deployment(), seed = d.seed, address = d.addresses.CompoundingSeedTimelock;
  if (!seed || !address) return;
  const code = await pub.getCode({ address });
  if (!code || keccak256(code).toLowerCase() !== seed.codeHash.toLowerCase()) throw new Error("seed-code-mismatch");
  const block = await pub.getBlock();
  const base = { address, abi: seedAbi, blockNumber: block.number } as const;
  const [owner, posm, tokenId, releaseAt, released] = await Promise.all([
    pub.readContract({ ...base, functionName: "TREASURY" }), pub.readContract({ ...base, functionName: "POSM" }),
    pub.readContract({ ...base, functionName: "tokenId" }), pub.readContract({ ...base, functionName: "releaseAt" }),
    pub.readContract({ ...base, functionName: "released" })
  ]);
  if (tokenId !== seed.tokenId || Number(releaseAt) !== seed.releaseAt || owner.toLowerCase() !== seed.owner.toLowerCase() || (account && account.address.toLowerCase() !== owner.toLowerCase())) throw new Error("seed-identity-mismatch");
  if (released || block.timestamp >= BigInt(releaseAt)) { ctx.log.info("seed_check", { result: "lock-ended" }); return; }
  if ((await pub.readContract({ address: posm, abi: nftAbi, functionName: "ownerOf", args: [tokenId] })).toLowerCase() !== address.toLowerCase()) throw new Error("seed-custody-mismatch");
  const [price, existing, additional] = await pub.readContract({ ...base, functionName: "previewCompound" });
  const quote = compoundQuote(price, existing, additional, 1n);
  if (!quote) { ctx.log.info("seed_check", { result: "below-threshold" }); return; }
  const pool=d.pools.gageSgage, gagePool=d.pools.gageEth;
  const gage=d.addresses.GAGE, stateView=d.addresses.StateView, floor=d.addresses.CreatorFeeSplitter;
  if(!pool || !gagePool || !gage || !stateView || !floor) throw new Error("seed-pricing-deployment-incomplete");
  const gageValue=seedGageValue(quote.minLiquidity,price,pool.currency0.toLowerCase()===gage.toLowerCase());
  let ethValue: bigint;
  if(d.pons && !await pub.readContract({address:d.pons.curve,abi:curveAbi,functionName:"graduated",blockNumber:block.number})) {
    const [eth,tokens]=await pub.readContract({address:d.pons.curve,abi:curveAbi,functionName:"getReserves",blockNumber:block.number});
    if(eth===0n || tokens===0n) {ctx.log.info("seed_check",{result:"price-unavailable"});return;}
    ethValue=gageValue*eth/tokens;
  } else {
    const [p]=await pub.readContract({address:stateView,abi:stateViewAbi,functionName:"getSlot0",args:[gagePool.poolId],blockNumber:block.number});
    if(p===0n) {ctx.log.info("seed_check",{result:"price-unavailable"});return;}
    const ratio=priceOfIn(gage,gagePool,p);ethValue=gageValue*ratio.num/ratio.den;
  }
  const [usdgPerETH,threshold]=await Promise.all([
    pub.readContract({address:floor,abi:floorFeeAbi,functionName:"ethValueUSDG",args:[10n**18n],blockNumber:block.number}),
    pub.readContract({address:floor,abi:floorFeeAbi,functionName:"threshold",blockNumber:block.number})
  ]);
  if(usdgPerETH<=0n) throw new Error("seed-price-unavailable");
  const valueUSDG=ethValue*usdgPerETH/10n**18n;
  if(valueUSDG<threshold) {ctx.log.info("seed_check",{result:"below-value-threshold",valueUSDG,threshold});return;}
  const outcome = await ctx.sender.execute({ label: "Seed.compound", address, abi: seedAbi, functionName: "compound", args: [quote.referencePrice, quote.minLiquidity, block.timestamp + 90n], maxGasCostWei: ethValue * 98n / 10000n });
  ctx.log.info("seed_check", { result: outcome.status });
}
