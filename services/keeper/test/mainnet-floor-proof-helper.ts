// Called only by scripts/launch-fork-check.mjs. Uses the worker's own module graph and clients.
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeSender } from "../src/sender.js";
import { runSeed } from "../src/jobs/launch.js";
import { runFloorFees } from "../src/jobs/floor-fees.js";
import type { JobContext } from "../src/context.js";
import type { Deployment } from "../src/deployment.js";
import type { Logger } from "../src/log.js";

interface ProofInput {
  key: Hex; deployment: Deployment; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}
async function context(input: ProofInput) {
  const rpc = "http://127.0.0.1:18547";
  const chain = defineChain({ id: 4663, name: "Local mainnet fork", nativeCurrency: {name:"ETH",symbol:"ETH",decimals:18}, rpcUrls: {default:{http:[rpc]}} });
  const publicClient = createPublicClient({chain, transport:http(rpc), pollingInterval:100});
  if(await publicClient.getChainId()!==4663 || !(await publicClient.request({method:"web3_clientVersion"})).toLowerCase().includes("anvil")) throw Error("Local Anvil required");
  const account = privateKeyToAccount(input.key);
  const walletClient = createWalletClient({chain, account, transport:http(rpc)});
  const client = new Proxy(publicClient, {get:(target, prop)=>prop==="estimateFeesPerGas"?()=>Promise.resolve(input.fees):Reflect.get(target,prop) as unknown});
  const logs: {event:string;data:unknown}[]=[];
  const record = (event:string,data:unknown) => {logs.push({event,data});};
  const logger = {child:()=>logger,info:record,warn:record,error:record,debug:record} as Logger;
  const sender=makeSender({publicClient:client,walletClient,account,dryRun:false,minGasWei:10n**16n,log:logger});
  const ctx={config:{maxClipUsdg:"1000"},deployment:()=>input.deployment,usdgDecimals:()=>Promise.resolve(6),sender,log:logger} as JobContext;
  return {ctx,client,account,logs,sender};
}

export async function runMainnetKeeperProof(input: ProofInput) {
  const {ctx,client,sender,logs}=await context(input);
  await runFloorFees(ctx,client);
  return {fees:input.fees,stats:sender.stats,logs};
}
export async function runMainnetSeedProof(input: ProofInput) {
  const {ctx,client,account,sender,logs}=await context(input);
  await runSeed(ctx,client,account);
  return {fees:input.fees,stats:sender.stats,logs};
}
