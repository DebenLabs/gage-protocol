import { ponder, type Context } from "ponder:registry";
import { earnCoreStates, v2Events, v2Participants, v2Positions } from "ponder:schema";
import type { Address } from "viem";
import { GageV2VaultAbi } from "../abis/v2/GageV2Vault";
import { loadDeployment } from "./lib/deployment";
import { refreshEarnCoreLoan } from "./earn";

const deployment = loadDeployment();
const v2 = deployment.nativeV2;
const earn = deployment.earn;
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (value: string) => value.toLowerCase() as Address;
const serialize = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
const states = ["none", "funding", "active", "repaid", "defaulted", "cancelled"];

async function refresh(context: Context, engine: Address, id: bigint, block: bigint, extra: Address[] = []) {
  const config = v2?.engines.find(e => lower(e.engine) === lower(engine));
  if (!config) throw new Error("Unpublished V2 engine");
  const contract = {address: engine, abi: GageV2VaultAbi};
  const [loan, slots, ask, lenderAsks] = await Promise.all([
    context.client.readContract({...contract, functionName: "getLoan", args: [id]}),
    context.client.readContract({...contract, functionName: "lenders", args: [id]}),
    context.client.readContract({...contract, functionName: "getAsk", args: [id]}),
    config.lenderSales ? context.client.readContract({...contract, functionName: "getLenderAsks", args: [id]}) : undefined,
  ]);
  const owner = loan.state === 1 || loan.state === 2
    ? await context.client.readContract({...contract, functionName: "ownerOf", args: [id]}) : null;
  const key = `${deployment.chainId}:${lower(engine)}:${id}`;
  const snapshot = serialize({chainId: deployment.chainId, engine: lower(engine), id, loan, slots, ask, lenderAsks, owner, grace: config.grace, indexedBlock: block});
  const lenderAskDeadline = BigInt(Math.max(0, ...(lenderAsks ?? []).filter(a => a.price > 0n).map(a => a.deadline)));
  const row = {key, engine: lower(engine), loanId: id, state: states[loan.state]!, askPrice: ask.price, askDeadline: BigInt(ask.deadline), lenderAskDeadline, snapshot, indexedBlock: block};
  await context.db.insert(v2Positions).values(row).onConflictDoUpdate(row);
  for (const account of new Set([loan.originator, ...slots, ...(owner ? [owner] : []), ...extra].map(lower))) {
    if (account === ZERO) continue;
    await context.db.insert(v2Participants).values({key: `${key}:${account}`, positionKey: key, account}).onConflictDoNothing();
  }
}

if (v2) {
  for (const name of ["Listed", "UnitsFunded", "CommitmentWithdrawn", "Activated", "Closed", "AskPosted", "AskCancelled", "RightSold", "LenderAskPosted", "LenderAskCancelled", "LenderSold", "CollateralWithdrawn", "DefaultRecovered", "RecoveryWithdrawn"] as const) {
    ponder.on(`GageV2Vault:${name}`, async ({event, context}) => {
      const extra: Address[] = [];
      if ("seller" in event.args) extra.push(event.args.seller);
      if ("lender" in event.args) extra.push(event.args.lender);
      if ("buyer" in event.args) extra.push(event.args.buyer);
      const contract = lower(event.log.address);
      await context.db.insert(v2Events).values({key: `${deployment.chainId}:${event.transaction.hash}:${event.log.logIndex}`, contract,
        eventName: name, payload: serialize(event.args), block: event.block.number, timestamp: event.block.timestamp, tx: event.transaction.hash});
      await refresh(context, contract, event.args.id, event.block.number, extra);
      if (name === "Activated" || name === "Closed") await refreshEarnCoreLoan(context, contract, event.args.id, event.block.number, event.block.timestamp);
      // The Earn strategy's loans resolve on the core before its own settlement; record that at the exact block.
      if (name === "Closed" && earn && contract === lower(earn.core) && "state" in event.args) {
        const slots = await context.client.readContract({address: contract, abi: GageV2VaultAbi, functionName: "lenders", args: [event.args.id], blockNumber: event.block.number});
        const state = ["NONE", "FUNDING", "ACTIVE", "REPAID", "DEFAULTED", "CANCELLED"][event.args.state];
        if (state && (event.args.state === 5 || slots.some(slot => lower(slot) === lower(earn.HybridVault)))) {
          const row = {dealId: event.args.id, state, block: event.block.number};
          await context.db.insert(earnCoreStates).values(row).onConflictDoUpdate(row);
        }
      }
    });
  }
  ponder.on("GageV2Rewards:Claimed", async ({event, context}) => {
    const config = v2.engines.find(e => lower(e.rewards) === lower(event.log.address));
    if (!config) throw new Error("Unpublished V2 ledger");
    await refresh(context, config.engine, event.args.id, event.block.number, [event.args.account]);
  });
  for (const name of ["EngineSelected", "LoanOpened", "LoanClosed", "RewardsPaid", "RewardsRecycled"] as const) {
    ponder.on(`GageLegacyAdapter:${name}`, async ({event, context}) => {
      await context.db.insert(v2Events).values({key: `${deployment.chainId}:${event.transaction.hash}:${event.log.logIndex}`,
        contract: lower(event.log.address), eventName: name, payload: serialize(event.args), block: event.block.number,
        timestamp: event.block.timestamp, tx: event.transaction.hash});
    });
  }
}
