// M1 handlers: DealVault, CollateralRegistry, FeeSink, EntryRouter. Every table here is a pure function of the
// event stream; the only reads are the vault's immutables and ERC-20 metadata, both cached as immutable.
import { ponder } from "ponder:registry";
import type { Context, Event } from "ponder:registry";
import { assets, bids, deals, feeSinkState, pools, registryState, routers, vaultConstants } from "ponder:schema";
import type { Address } from "viem";

import { ERC20MetadataAbi } from "../abis/ERC20Metadata";
import { dealLane, feeRouteFromIndex, graceEnd, kindFromIndex, laneFromIndex } from "./lib/derive";
import { credit, creditNft, debit, removeNft } from "./lib/ledger";
import { termBucket } from "./lib/emissions";
import { bumpWeek } from "./lib/weeks";

const lower = (a: Address): Address => a.toLowerCase() as Address;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

type VaultConsts = typeof vaultConstants.$inferSelect;
type DealRow = typeof deals.$inferSelect;

/** GRACE, USDG, FEE_SINK and POSITION_MANAGER are immutables: read once at the first event, then served from the table. */
async function vaultConsts(context: Context): Promise<VaultConsts> {
  const cached = await context.db.find(vaultConstants, { id: "vault" });
  if (cached !== null) return cached;
  const { abi, address } = context.contracts.DealVault;
  const [grace, usdg, feeSink, positionManager] = await Promise.all([
    context.client.readContract({ abi, address, functionName: "GRACE", cache: "immutable" }),
    context.client.readContract({ abi, address, functionName: "USDG", cache: "immutable" }),
    context.client.readContract({ abi, address, functionName: "FEE_SINK", cache: "immutable" }),
    context.client.readContract({ abi, address, functionName: "POSITION_MANAGER", cache: "immutable" }),
  ]);
  const usdgDecimals = await context.client
    .readContract({ abi: ERC20MetadataAbi, address: usdg, functionName: "decimals", cache: "immutable" })
    .catch(() => 18);
  const row: VaultConsts = {
    id: "vault",
    grace: BigInt(grace),
    usdg: lower(usdg),
    usdgDecimals,
    feeSink: lower(feeSink),
    positionManager: lower(positionManager),
  };
  await context.db.insert(vaultConstants).values(row).onConflictDoNothing();
  return row;
}

/** cancel, reclaim and claim are the only paths that credit collateral out (spec I1). */
async function creditCollateral(context: Context, deal: DealRow, to: Address, at: bigint): Promise<void> {
  if (deal.kind === "ERC20") {
    await credit(context.db, to, deal.token, "ERC20", deal.amountOrTokenId, at);
    await context.db
      .update(assets, { token: deal.token })
      .set((row) => ({ openRaw: row.openRaw - deal.amountOrTokenId, updatedAt: at }));
  } else {
    await creditNft(context.db, to, deal.token, deal.amountOrTokenId, at);
  }
}

async function settle(
  context: Context,
  event: Event<"DealVault:Reclaimed" | "DealVault:Claimed" | "DealVault:Cancelled">,
  state: "RECLAIMED" | "CLAIMED" | "CANCELLED",
): Promise<DealRow> {
  const at = event.block.timestamp;
  const deal = await context.db.find(deals, { id: event.args.dealId });
  if (deal === null) throw new Error(`deal ${event.args.dealId} settled before it was listed`);
  await context.db
    .update(deals, { id: deal.id })
    .set({ state, settledAt: at, settledTx: event.transaction.hash });
  await bumpWeek(context.db, at, (row) =>
    state === "RECLAIMED"
      ? { reclaimed: row.reclaimed + 1 }
      : state === "CLAIMED"
        ? { claimed: row.claimed + 1 }
        : { cancelled: row.cancelled + 1 },
  );
  return deal;
}

// ----------------------------------------------------------------- DealVault

ponder.on("DealVault:Listed", async ({ event, context }) => {
  const { dealId, borrower, kind, token, amountOrTokenId, cap, term, listingExpiry, minPrice } = event.args;
  const at = event.block.timestamp;
  const kindName = kindFromIndex(kind);
  const tokenAddress = lower(token);
  const asset = kindName === "ERC20" ? await context.db.find(assets, { token: tokenAddress }) : null;

  await context.db.insert(deals).values({
    id: dealId,
    borrower: lower(borrower),
    kind: kindName,
    token: tokenAddress,
    amountOrTokenId,
    cap,
    term,
    listingExpiry: BigInt(listingExpiry),
    minPrice,
    state: "LISTED",
    lane: dealLane(kindName, asset?.lane),
    openBidCount: 0,
    listedAt: at,
    listedBlock: event.block.number,
    listedTx: event.transaction.hash,
  });

  if (asset !== null) {
    await context.db
      .update(assets, { token: tokenAddress })
      .set((row) => ({ openRaw: row.openRaw + amountOrTokenId, updatedAt: at }));
  }
  await bumpWeek(context.db, at, (row) => ({ listed: row.listed + 1 }));
  // Warm the immutables so Funded never has to wait on the RPC.
  await vaultConsts(context);
});

ponder.on("DealVault:BidPlaced", async ({ event, context }) => {
  const { bidId, dealId, lender, price, expiry } = event.args;
  const at = event.block.timestamp;
  await context.db.insert(bids).values({
    id: bidId,
    dealId,
    lender: lower(lender),
    price,
    expiry: BigInt(expiry),
    state: "OPEN",
    placedAt: at,
    tx: event.transaction.hash,
  });
  await context.db.update(deals, { id: dealId }).set((row) => ({ openBidCount: row.openBidCount + 1 }));
  await bumpWeek(context.db, at, (row) => ({ bidsPlaced: row.bidsPlaced + 1 }));
});

ponder.on("DealVault:BidWithdrawn", async ({ event, context }) => {
  const at = event.block.timestamp;
  const bid = await context.db.find(bids, { id: event.args.bidId });
  if (bid === null) throw new Error(`bid ${event.args.bidId} withdrawn before it was placed`);
  const consts = await vaultConsts(context);

  await context.db.update(bids, { id: bid.id }).set({ state: "WITHDRAWN", closedAt: at });
  await context.db.update(deals, { id: bid.dealId }).set((row) => ({ openBidCount: row.openBidCount - 1 }));
  await credit(context.db, bid.lender, consts.usdg, "USDG", bid.price, at);
});

ponder.on("DealVault:Funded", async ({ event, context }) => {
  const { dealId, bidId, lender, price, fee, fundedAt, expiry } = event.args;
  const at = event.block.timestamp;
  const consts = await vaultConsts(context);

  const deal = await context.db.update(deals, { id: dealId }).set((row) => ({
    state: "FUNDED",
    lender: lower(lender),
    price,
    fee,
    fundedAt: BigInt(fundedAt),
    expiry: BigInt(expiry),
    graceEnd: graceEnd(BigInt(expiry), consts.grace),
    acceptedBidId: bidId,
    openBidCount: row.openBidCount - 1,
    fundedTx: event.transaction.hash,
  }));
  await context.db.update(bids, { id: bidId }).set({ state: "ACCEPTED", closedAt: at });

  // Atomic accept (spec I4): fee to FeeSink's balance (D4), the rest to the borrower.
  await credit(context.db, consts.feeSink, consts.usdg, "USDG", fee, at);
  await credit(context.db, deal.borrower, consts.usdg, "USDG", price - fee, at);

  const bucket = termBucket(deal.term);
  await bumpWeek(context.db, at, (row) => ({
    funded: row.funded + 1,
    funded7: row.funded7 + (bucket === 7 ? 1 : 0),
    funded21: row.funded21 + (bucket === 21 ? 1 : 0),
    fundedUSDG: row.fundedUSDG + price,
    feesUSDG: row.feesUSDG + fee,
  }));
});

ponder.on("DealVault:Reclaimed", async ({ event, context }) => {
  const at = event.block.timestamp;
  const deal = await settle(context, event, "RECLAIMED");
  const consts = await vaultConsts(context);
  if (deal.lender === null) throw new Error(`deal ${deal.id} reclaimed without a lender`);
  // Exactly `cap` to the lender (spec I6), the collateral back to the borrower.
  await credit(context.db, deal.lender, consts.usdg, "USDG", deal.cap, at);
  await creditCollateral(context, deal, deal.borrower, at);
});

ponder.on("DealVault:Claimed", async ({ event, context }) => {
  const at = event.block.timestamp;
  const deal = await settle(context, event, "CLAIMED");
  if (deal.lender === null) throw new Error(`deal ${deal.id} claimed without a lender`);
  await creditCollateral(context, deal, deal.lender, at);
});

ponder.on("DealVault:Cancelled", async ({ event, context }) => {
  const at = event.block.timestamp;
  const deal = await settle(context, event, "CANCELLED");
  await creditCollateral(context, deal, deal.borrower, at);
});

ponder.on("DealVault:Withdrawn", async ({ event, context }) => {
  const { account, asset, amount } = event.args;
  const consts = await vaultConsts(context);
  const assetAddress = lower(asset);
  if (consts.positionManager !== ZERO && assetAddress === consts.positionManager) {
    await removeNft(context.db, lower(account), assetAddress, amount);
    return;
  }
  await debit(context.db, lower(account), assetAddress, amount, event.block.timestamp);
});

// ----------------------------------------------------------------- CollateralRegistry

type TokenMetadata = { symbol: string; name: string; decimals: number };

/** Symbol, name and decimals never change; a token without them (bytes32 symbol, no decimals) gets placeholders. */
async function tokenMetadata(context: Context, token: Address): Promise<TokenMetadata> {
  const abi = ERC20MetadataAbi;
  const [symbol, name, decimals] = await Promise.all([
    context.client.readContract({ abi, address: token, functionName: "symbol", cache: "immutable" }).catch(() => "?"),
    context.client.readContract({ abi, address: token, functionName: "name", cache: "immutable" }).catch(() => "?"),
    context.client.readContract({ abi, address: token, functionName: "decimals", cache: "immutable" }).catch(() => 18),
  ]);
  return { symbol, name, decimals };
}

ponder.on("CollateralRegistry:ERC20Set", async ({ event, context }) => {
  const { token, allowed, lane, minAmount, maxDealRaw, maxOpenRaw } = event.args;
  const at = event.block.timestamp;
  const tokenAddress = lower(token);
  const config = { allowed, lane: laneFromIndex(lane), minAmount, maxDealRaw, maxOpenRaw, updatedAt: at };
  const existing = await context.db.find(assets, { token: tokenAddress });
  if (existing !== null) {
    await context.db.update(assets, { token: tokenAddress }).set(config);
    return;
  }
  const meta = await tokenMetadata(context, tokenAddress);
  await context.db.insert(assets).values({ token: tokenAddress, ...meta, ...config, openRaw: 0n });
});

ponder.on("CollateralRegistry:PoolSet", async ({ event, context }) => {
  const { poolId, allowed, minLiquidity } = event.args;
  const at = event.block.timestamp;
  await context.db
    .insert(pools)
    .values({ poolId: lower(poolId), allowed, minLiquidity, updatedAt: at })
    .onConflictDoUpdate({ allowed, minLiquidity, updatedAt: at });
});

type RegistryPatch = Partial<Omit<typeof registryState.$inferInsert, "id" | "updatedAt">>;

/** The registry's defaults at deployment: no fee, nothing paused, meme pairs = STOCK only (open decision 23). */
async function patchRegistry(context: Context, at: bigint, patch: RegistryPatch): Promise<void> {
  await context.db
    .insert(registryState)
    .values({
      id: "registry",
      feeBps: 0,
      newDealsPaused: false,
      inRangeRequired: false,
      terms: [],
      memePairMask: 1,
      updatedAt: at,
      ...patch,
    })
    .onConflictDoUpdate({ ...patch, updatedAt: at });
}

ponder.on("CollateralRegistry:TermsSet", async ({ event, context }) => {
  await patchRegistry(context, event.block.timestamp, { terms: [...event.args.terms] });
});

ponder.on("CollateralRegistry:FeeSet", async ({ event, context }) => {
  await patchRegistry(context, event.block.timestamp, { feeBps: event.args.bps });
});

ponder.on("CollateralRegistry:InRangeRequiredSet", async ({ event, context }) => {
  await patchRegistry(context, event.block.timestamp, { inRangeRequired: event.args.required });
});

ponder.on("CollateralRegistry:NewDealsPausedSet", async ({ event, context }) => {
  await patchRegistry(context, event.block.timestamp, { newDealsPaused: event.args.paused });
});

ponder.on("CollateralRegistry:MemePairsSet", async ({ event, context }) => {
  await patchRegistry(context, event.block.timestamp, { memePairMask: event.args.mask });
});

ponder.on("CollateralRegistry:RouterSet", async ({ event, context }) => {
  const at = event.block.timestamp;
  const { router, allowed } = event.args;
  await context.db
    .insert(routers)
    .values({ address: lower(router), allowed, updatedAt: at })
    .onConflictDoUpdate({ allowed, updatedAt: at });
});

// ----------------------------------------------------------------- FeeSink

type FeeSinkRow = typeof feeSinkState.$inferSelect;
type FeeSinkPatch = Partial<Omit<typeof feeSinkState.$inferInsert, "id" | "updatedAt">>;

async function patchFeeSink(
  context: Context,
  at: bigint,
  patch: FeeSinkPatch,
  bump?: (row: FeeSinkRow) => FeeSinkPatch,
): Promise<void> {
  await context.db
    .insert(feeSinkState)
    .values({ id: "fee_sink", route: "TREASURY", collectedTotal: 0n, sweptTotal: 0n, updatedAt: at, ...patch })
    .onConflictDoUpdate((row) => ({ ...patch, ...(bump ? bump(row) : {}), updatedAt: at }));
}

ponder.on("FeeSink:VaultSet", async ({ event, context }) => {
  await patchFeeSink(context, event.block.timestamp, { vault: lower(event.args.vault) });
});

ponder.on("FeeSink:RouteSet", async ({ event, context }) => {
  await patchFeeSink(context, event.block.timestamp, { route: feeRouteFromIndex(event.args.route) });
});

ponder.on("FeeSink:TreasurySet", async ({ event, context }) => {
  await patchFeeSink(context, event.block.timestamp, { treasury: lower(event.args.treasury) });
});

ponder.on("FeeSink:BuybackSet", async ({ event, context }) => {
  await patchFeeSink(context, event.block.timestamp, { buyback: lower(event.args.buyback) });
});

ponder.on("FeeSink:Collected", async ({ event, context }) => {
  const { amount } = event.args;
  await patchFeeSink(context, event.block.timestamp, { collectedTotal: amount }, (row) => ({
    collectedTotal: row.collectedTotal + amount,
  }));
});

ponder.on("FeeSink:Swept", async ({ event, context }) => {
  const { amount } = event.args;
  await patchFeeSink(context, event.block.timestamp, { sweptTotal: amount }, (row) => ({
    sweptTotal: row.sweptTotal + amount,
  }));
});

// ----------------------------------------------------------------- EntryRouter

ponder.on("EntryRouter:BidWithETH", async ({ event, context }) => {
  const { bidId, ethIn, ethRefunded } = event.args;
  // The vault's BidPlaced lands earlier in the same transaction; record the ETH the lender actually spent.
  const bid = await context.db.find(bids, { id: bidId });
  if (bid === null) return;
  await context.db.update(bids, { id: bidId }).set({ ethIn: ethIn - ethRefunded });
});
