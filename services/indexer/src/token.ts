// Token-layer handlers (M6). Wired to the interface events and registered only when the deployment json carries
// the contract, so this file is inert until M6 is deployed and needs no change when it is.
import { ponder } from "ponder:registry";
import type { Context } from "ponder:registry";
import {
  burns,
  dealFeeFloorDeposits,
  creatorFeeSplits,
  floorBands,
  dealRewards,
  deals,
  drips,
  emissionsState,
  epochs,
  grantLinks,
  lpEarned,
  lpNotices,
  lpPositions,
  lpStreamerCheckpoints,
  lpStreamerCollected,
  lpStreamerDeposits,
  lpStreamerEpochs,
  tvlPositions,
  nftPositions,
  poolState,
  reinvests,
  seedTimelock,
  swaps,
} from "ponder:schema";
import type { Address, Hex } from "viem";

import { PositionManagerAbi } from "../abis/PositionManager";
import { loadDeployment, poolByName } from "./lib/deployment";
import { epochBounds, splitWeekly, termBucket } from "./lib/emissions";
import { liquidityPositionId } from "./lib/tvl";
import { tickInRange } from "./lib/pool";
import { decodePositionInfo, isEmptyPositionInfo, poolIdOf, poolNameOf } from "./lib/position";
import { bumpWeek } from "./lib/weeks";

const lower = <T extends string>(s: T): T => s.toLowerCase() as T;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO32: Hex = `0x${"0".repeat(64)}`;

const deployment = loadDeployment();
const { token } = deployment;
const ourPool = poolByName(deployment, "gageSgage");

const dripRowId = (account: Address, dripId: Hex): string => `${account}-${dripId}`;
const linkId = (tx: Hex, account: Address, amount: bigint): string => `${tx}-${account}-${amount.toString()}`;

// ----------------------------------------------------------------- shared upserts

type EpochRow = typeof epochs.$inferSelect;

async function ensureEpoch(context: Context, n: bigint): Promise<EpochRow> {
  const existing = await context.db.find(epochs, { n });
  if (existing) return existing;
  const state = await context.db.find(emissionsState, { id: "emissions" });
  const bounds =
    state?.launchAt !== null && state?.launchAt !== undefined
      ? epochBounds(state.launchAt, state.epochLength, n)
      : { startsAt: 0n, endsAt: 0n };
  const row = {
    n,
    ...bounds,
    weekly: 0n,
    dealShareBps: 0,
    term21ShareBps: 0,
    dealBudget7: 0n,
    dealBudget21: 0n,
    reserved7: 0n,
    reserved21: 0n,
    liquidityBudget: 0n,
    released: false,
    rolledOver: false,
    rolledOverAmount: 0n,
  };
  return context.db.insert(epochs).values(row);
}

async function ensurePool(context: Context, poolId: Hex, at: bigint): Promise<typeof poolState.$inferSelect> {
  const existing = await context.db.find(poolState, { poolId });
  if (existing) return existing;
  const def = deployment.pools.find((p) => p.poolId === poolId);
  return context.db.insert(poolState).values({
    poolId,
    name: def?.name ?? "unknown",
    currency0: def?.currency0 ?? ZERO,
    currency1: def?.currency1 ?? ZERO,
    fee: def?.fee ?? 0,
    tickSpacing: def?.tickSpacing ?? 0,
    hooks: def?.hooks ?? ZERO,
    initialized: false,
    sqrtPriceX96: 0n,
    tick: 0,
    liquidity: 0n,
    totalWeight: 0n,
    updatedAt: at,
  });
}

/** A position row with zeros until ModifyLiquidity fills it; the owner comes from the NFT ledger if known. */
async function ensurePosition(context: Context, tokenId: bigint, at: bigint): Promise<typeof lpPositions.$inferSelect> {
  const existing = await context.db.find(lpPositions, { tokenId });
  if (existing) return existing;
  const nft = await context.db.find(nftPositions, { tokenId });
  return context.db.insert(lpPositions).values({
    tokenId,
    poolId: ourPool?.poolId ?? ZERO32,
    owner: nft?.owner ?? ZERO,
    tickLower: 0,
    tickUpper: 0,
    liquidity: 0n,
    weight: 0n,
    inRange: false,
    lastCheckpoint: 0n,
    isSeed: false,
    createdAt: at,
    updatedAt: at,
  });
}

/** Called from both Registered and Granted: links the drip to its deal once both sides are known. */
async function linkGrant(
  context: Context,
  id: string,
  side: { dealId: bigint } | { dripRowId: string },
): Promise<void> {
  const link = await context.db
    .insert(grantLinks)
    .values({ id, dealId: "dealId" in side ? side.dealId : null, dripRowId: "dripRowId" in side ? side.dripRowId : null })
    .onConflictDoUpdate(side);
  if (link.dealId !== null && link.dripRowId !== null) {
    await context.db.update(drips, { id: link.dripRowId }).set({ dealId: link.dealId });
  }
}

// ----------------------------------------------------------------- Drip

if (token.Drip != null) {
  ponder.on("Drip:Granted", async ({ event, context }) => {
    const { account, dripId, total, start, length, grantor } = event.args;
    const at = event.block.timestamp;
    const acct = lower(account);
    const id = dripRowId(acct, lower(dripId));
    const source = lower(grantor) === token.DealRewards ? "deal" : "lp";
    const values = {
      dripId: lower(dripId),
      account: acct,
      source,
      total,
      claimed: 0n,
      start: BigInt(start),
      length,
      grantor: lower(grantor),
      grantedAt: at,
      tx: event.transaction.hash,
    } as const;
    // A Collected placeholder (lp) may already hold the tokenId; keep it.
    await context.db
      .insert(drips)
      .values({ id, ...values })
      .onConflictDoUpdate(values);
    if (source === "deal") await linkGrant(context, linkId(event.transaction.hash, acct, total), { dripRowId: id });
  });

  ponder.on("Drip:Claimed", async ({ event, context }) => {
    const { account, dripId, amount } = event.args;
    const id = dripRowId(lower(account), lower(dripId));
    const row = await context.db.find(drips, { id });
    if (row === null) return;
    await context.db.update(drips, { id }).set({ claimed: row.claimed + amount });
  });
}

// ----------------------------------------------------------------- Emissions

if (token.Emissions != null) {
  ponder.on("Emissions:Launched", async ({ event, context }) => {
    const at = event.block.timestamp;
    const launchAt = BigInt(event.args.launchAt);
    const { abi, address } = context.contracts.Emissions;
    const [epochLength, weeksRaw, reserve] = await Promise.all([
      context.client.readContract({ abi, address, functionName: "EPOCH", cache: "immutable" }),
      context.client.readContract({ abi, address, functionName: "WEEKS", cache: "immutable" }),
      context.client.readContract({ abi, address, functionName: "RESERVE", cache: "immutable" }),
    ]);
    const weeks = Number(weeksRaw);
    await context.db
      .insert(emissionsState)
      .values({ id: "emissions", launchAt, epochLength, weeks, reserve, updatedAt: at })
      .onConflictDoUpdate({ launchAt, epochLength, weeks, reserve, updatedAt: at });

    // The schedule table is compile-time (spec 13); the shares are the defaults until SharesSet says otherwise.
    for (let i = 0; i < weeks; i++) {
      const n = BigInt(i);
      const [weekly, dealShareBps, term21ShareBps] = await Promise.all([
        context.client.readContract({ abi, address, functionName: "weekly", args: [n], cache: "immutable" }),
        // Shares are fixed once an epoch has started, and the public RPC keeps no archive state, so read them
        // like the other constants rather than at the event's block.
        context.client.readContract({ abi, address, functionName: "dealShareBps", args: [n], cache: "immutable" }),
        context.client.readContract({ abi, address, functionName: "term21ShareBps", args: [n], cache: "immutable" }),
      ]);
      const budgets = splitWeekly(weekly, dealShareBps, term21ShareBps);
      const patch = { ...epochBounds(launchAt, epochLength, n), weekly, dealShareBps, term21ShareBps, ...budgets };
      await context.db
        .insert(epochs)
        .values({
          n,
          ...patch,
          reserved7: 0n,
          reserved21: 0n,
          released: false,
          rolledOver: false,
          rolledOverAmount: 0n,
        })
        .onConflictDoUpdate((row) => (row.released ? {} : patch));
    }
  });

  ponder.on("Emissions:SharesSet", async ({ event, context }) => {
    const { epoch, dealShareBps, term21ShareBps } = event.args;
    const row = await ensureEpoch(context, epoch);
    if (row.released) return;
    await context.db
      .update(epochs, { n: epoch })
      .set({ dealShareBps, term21ShareBps, ...splitWeekly(row.weekly, dealShareBps, term21ShareBps) });
  });

  ponder.on("Emissions:Released", async ({ event, context }) => {
    const { epoch, liquidity, deals7, deals21 } = event.args;
    await ensureEpoch(context, epoch);
    await context.db.update(epochs, { n: epoch }).set({
      weekly: liquidity + deals7 + deals21,
      liquidityBudget: liquidity,
      dealBudget7: deals7,
      dealBudget21: deals21,
      released: true,
    });
  });

  ponder.on("Emissions:Reserved", async ({ event, context }) => {
    const { epoch, term, amount } = event.args;
    const bucket = termBucket(term);
    if (bucket === null) return;
    await ensureEpoch(context, epoch);
    await context.db
      .update(epochs, { n: epoch })
      .set((row) => (bucket === 7 ? { reserved7: row.reserved7 + amount } : { reserved21: row.reserved21 + amount }));
  });

  ponder.on("Emissions:RolledOver", async ({ event, context }) => {
    const { epoch, amount } = event.args;
    await ensureEpoch(context, epoch);
    await context.db.update(epochs, { n: epoch }).set({ rolledOver: true, rolledOverAmount: amount });
  });

  ponder.on("Emissions:Finalized", async ({ event, context }) => {
    const at = event.block.timestamp;
    await context.db
      .insert(emissionsState)
      .values({ id: "emissions", launchAt: null, epochLength: 0n, weeks: 0, reserve: 0n, finalizedBurn: event.args.burned, updatedAt: at })
      .onConflictDoUpdate({ finalizedBurn: event.args.burned, updatedAt: at });
  });
}

// ----------------------------------------------------------------- DealRewards

if (token.DealRewards != null) {
  ponder.on("DealRewards:RatesSet", async ({ event, context }) => {
    const { epoch, rate7, rate21, priceUSDGPerSGAGE, lenderShareBps } = event.args;
    await ensureEpoch(context, epoch);
    await context.db.update(epochs, { n: epoch }).set({ rate7, rate21, priceUSDGPerSGAGE, lenderShareBps });
  });

  ponder.on("DealRewards:Registered", async ({ event, context }) => {
    const { dealId, epoch, term, fee, reward, lenderAmount, borrowerAmount, budgetExhausted } = event.args;
    const tx = event.transaction.hash;
    await context.db
      .insert(dealRewards)
      .values({ dealId, epoch, term, fee, reward, lenderAmount, borrowerAmount, budgetExhausted, registeredAt: event.block.timestamp, tx })
      .onConflictDoNothing();
    await bumpWeek(context.db, event.block.timestamp, (row) => ({ sgageGranted: row.sgageGranted + reward }));
    const deal = await context.db.find(deals, { id: dealId });
    if (deal === null) return;
    if (deal.lender !== null && lenderAmount > 0n) await linkGrant(context, linkId(tx, deal.lender, lenderAmount), { dealId });
    if (borrowerAmount > 0n) await linkGrant(context, linkId(tx, deal.borrower, borrowerAmount), { dealId });
  });
}

// ----------------------------------------------------------------- LPRewards

if (token.LPRewards != null) {
  ponder.on("LPRewards:Checkpointed", async ({ event, context }) => {
    const { tokenId, weight, totalWeight, inRange } = event.args;
    const at = event.block.timestamp;
    await ensurePosition(context, tokenId, at);
    await context.db.update(lpPositions, { tokenId }).set({ weight, inRange, lastCheckpoint: at, updatedAt: at });
    if (ourPool != null) {
      await ensurePool(context, ourPool.poolId, at);
      await context.db.update(poolState, { poolId: ourPool.poolId }).set({ totalWeight, updatedAt: at });
    }
  });

  ponder.on("LPRewards:EmissionsNotified", async ({ event, context }) => {
    const { epoch, amount } = event.args;
    await bumpWeek(context.db, event.block.timestamp, (row) => ({ lpEmissions: row.lpEmissions + amount }));
    await context.db.insert(lpNotices).values({
      id: event.id,
      kind: "EMISSIONS",
      epoch,
      amount,
      at: event.block.timestamp,
      tx: event.transaction.hash,
    });
  });

  ponder.on("LPRewards:LumpNotified", async ({ event, context }) => {
    const { from, amount, totalWeight } = event.args;
    await context.db.insert(lpNotices).values({
      id: event.id,
      kind: "LUMP",
      from: lower(from),
      amount,
      totalWeight,
      at: event.block.timestamp,
      tx: event.transaction.hash,
    });
  });

  ponder.on("LPRewards:Collected", async ({ event, context }) => {
    const { tokenId, owner, emissions, dripId, creatorFee } = event.args;
    const at = event.block.timestamp;
    await context.db
      .insert(lpEarned)
      .values({ tokenId, emissionsEarned: emissions, creatorFeeEarned: creatorFee, collectedAt: at, collectCount: 1 })
      .onConflictDoUpdate((row) => ({
        emissionsEarned: row.emissionsEarned + emissions,
        creatorFeeEarned: row.creatorFeeEarned + creatorFee,
        collectedAt: at,
        collectCount: row.collectCount + 1,
      }));
    if (emissions === 0n) return;
    // Drip.Granted for this collection lands in the same transaction; whichever runs first, the row ends up whole.
    const acct = lower(owner);
    await context.db
      .insert(drips)
      .values({
        id: dripRowId(acct, lower(dripId)),
        dripId: lower(dripId),
        account: acct,
        source: "lp",
        tokenId,
        total: 0n,
        claimed: 0n,
        start: at,
        length: 0,
        grantor: token.LPRewards ?? ZERO,
        grantedAt: at,
        tx: event.transaction.hash,
      })
      .onConflictDoUpdate({ tokenId, source: "lp" });
  });

  ponder.on("LPRewards:SeedSet", async ({ event, context }) => {
    const at = event.block.timestamp;
    await ensurePosition(context, event.args.tokenId, at);
    await context.db.update(lpPositions, { tokenId: event.args.tokenId }).set({ isSeed: true, updatedAt: at });
  });
}

// ----------------------------------------------------------------- LPStreamer (D64)

if (token.LPStreamer != null) {
  ponder.on("LPStreamer:Deposited", async ({ event, context }) => {
    const { from, amount, forEpoch } = event.args;
    await context.db.insert(lpStreamerDeposits).values({
      id: event.id,
      from: lower(from),
      amount,
      forEpoch,
      at: event.block.timestamp,
      tx: event.transaction.hash,
    });
  });

  // Emitted once per epoch, in order, by the streamer's roll.
  ponder.on("LPStreamer:PotFixed", async ({ event, context }) => {
    const { epoch, pot, rate } = event.args;
    await context.db.insert(lpStreamerEpochs).values({ epoch, pot, rate, fixedAt: event.block.timestamp, tx: event.transaction.hash });
  });

  ponder.on("LPStreamer:Checkpointed", async ({ event, context }) => {
    const { tokenId, accrual, credit, epoch } = event.args;
    await context.db.insert(lpStreamerCheckpoints).values({
      id: event.id,
      tokenId,
      accrual,
      credit,
      epoch,
      at: event.block.timestamp,
      tx: event.transaction.hash,
    });
  });

  // A collect opens a 7-day drip on the streamer's own Drip (`LPStreamerDrip`, indexed under the `Drip` handlers).
  ponder.on("LPStreamer:Collected", async ({ event, context }) => {
    const { tokenId, owner, amount, dripId } = event.args;
    const at = event.block.timestamp;
    const drip = lower(dripId);
    await context.db
      .insert(lpStreamerCollected)
      .values({ tokenId, collectedTotal: amount, collectCount: 1, collectedAt: at, lastDripId: drip })
      .onConflictDoUpdate((row) => ({ collectedTotal: row.collectedTotal + amount, collectCount: row.collectCount + 1, collectedAt: at, lastDripId: drip }));
    // Drip.Granted for this collection lands in the same transaction; whichever runs first, the row ends up whole
    // and keeps the tokenId, the way LPRewards.Collected does.
    const acct = lower(owner);
    await context.db
      .insert(drips)
      .values({
        id: dripRowId(acct, drip),
        dripId: drip,
        account: acct,
        source: "lp",
        tokenId,
        total: 0n,
        claimed: 0n,
        start: at,
        length: 0,
        grantor: token.LPStreamer ?? ZERO,
        grantedAt: at,
        tx: event.transaction.hash,
      })
      .onConflictDoUpdate({ tokenId, source: "lp" });
  });
}

// ----------------------------------------------------------------- Buyback, CreatorFeeSplitter, ReinvestRouter, SeedTimelock

if (token.DealFeeRouter != null) {
  ponder.on("DealFeeRouter:FloorFunded", async ({ event, context }) => {
    const {caller, usdgIn, ethOut, gageBought, gageAdded} = event.args;
    await context.db.insert(dealFeeFloorDeposits).values({
      id: event.id, at: event.block.timestamp, caller: lower(caller),
      usdgIn, ethOut, gageBought, gageAdded, tx: event.transaction.hash,
    });
  });
}

if (token.Buyback != null) {
  ponder.on("Buyback:Clip", async ({ event, context }) => {
    const { caller, usdgIn, ethOut, gageOut, sgageBurned, bounty } = event.args;
    await bumpWeek(context.db, event.block.timestamp, (row) => ({
      sgageBurned: row.sgageBurned + sgageBurned,
      usdgSpentOnBuyback: row.usdgSpentOnBuyback + usdgIn,
    }));
    await context.db.insert(burns).values({
      id: event.id,
      at: event.block.timestamp,
      usdgSpent: usdgIn,
      ethOut,
      gageBought: gageOut,
      sgageBurned,
      bounty,
      caller: lower(caller),
      tx: event.transaction.hash,
    });
  });
}

if (token.CreatorFeeSplitter != null) {
  ponder.on("CreatorFeeSplitter:Split", async ({ event, context }) => {
    const { caller, ethTotal, ethToOps, gageToFloor, bounty } = event.args;
    await context.db.insert(creatorFeeSplits).values({
      id: event.id,
      at: event.block.timestamp,
      caller: lower(caller),
      ethTotal,
      ethToOps,
      gageToFloor,
      bounty,
      tx: event.transaction.hash,
    });
  });

  ponder.on("CreatorFeeSplitter:FloorAdded", async ({ event, context }) => {
    const { tokenId, tickLower, tickUpper, gageIn, liquidity } = event.args;
    const at = event.block.timestamp;
    await context.db
      .insert(floorBands)
      .values({ tokenId, tickLower, tickUpper, liquidity, gageIn, swept: false, sgageBurned: 0n, createdAt: at, updatedAt: at })
      .onConflictDoUpdate((row) => ({ liquidity, gageIn: row.gageIn + gageIn, updatedAt: at }));
  });

  ponder.on("CreatorFeeSplitter:FloorSwept", async ({ event, context }) => {
    const { tokenId, sgageBurned } = event.args;
    await context.db
      .update(floorBands, { tokenId })
      .set((row) => ({ swept: true, liquidity: 0n, sgageBurned: row.sgageBurned + sgageBurned, updatedAt: event.block.timestamp }));
  });
}

if (token.ReinvestRouter != null) {
  ponder.on("ReinvestRouter:Reinvested", async ({ event, context }) => {
    const { owner, tokenId, zap, sgageIn, sgageSold, gageBought, liquidity } = event.args;
    await context.db.insert(reinvests).values({
      id: event.id,
      owner: lower(owner),
      tokenId,
      zap,
      sgageIn,
      sgageSold,
      gageBought,
      liquidity,
      at: event.block.timestamp,
      tx: event.transaction.hash,
    });
  });
}

if (token.SeedTimelock != null) {
  const patchSeed = async (
    context: Context,
    at: bigint,
    patch: Partial<Omit<typeof seedTimelock.$inferInsert, "id" | "updatedAt">>,
    bump?: (row: typeof seedTimelock.$inferSelect) => Partial<typeof seedTimelock.$inferInsert>,
  ) => {
    await context.db
      .insert(seedTimelock)
      .values({ id: "seed", released: false, fees0: 0n, fees1: 0n, updatedAt: at, ...patch })
      .onConflictDoUpdate((row) => ({ ...patch, ...(bump ? bump(row) : {}), updatedAt: at }));
  };

  ponder.on("SeedTimelock:Locked", async ({ event, context }) => {
    await patchSeed(context, event.block.timestamp, {
      tokenId: event.args.tokenId,
      releaseAt: BigInt(event.args.releaseAt),
    });
  });

  ponder.on("SeedTimelock:FeesCollected", async ({ event, context }) => {
    const { amount0, amount1 } = event.args;
    await patchSeed(context, event.block.timestamp, { fees0: amount0, fees1: amount1 }, (row) => ({
      fees0: row.fees0 + amount0,
      fees1: row.fees1 + amount1,
    }));
  });

  ponder.on("SeedTimelock:Released", async ({ event, context }) => {
    await patchSeed(context, event.block.timestamp, { released: true, releasedTo: lower(event.args.to) });
  });
}

// ----------------------------------------------------------------- PositionManager (ERC-721) and PoolManager (v4)

if (token.PositionManager != null && deployment.vaultVersion !== 3) {
  const positionManager = token.PositionManager;
  ponder.on("PositionManager:Transfer", async ({ event, context }) => {
    const { to, tokenId } = event.args;
    const at = event.block.timestamp;
    const owner = lower(to);
    const burned = owner === ZERO;
    const existing = await context.db.find(nftPositions, { tokenId });
    if (existing === null) {
      // First sight of this token (its mint, or a transfer of a token minted before the start block): read the
      // pool key and ticks once. The read is `immutable`, so it goes to the latest block (the public RPC has no
      // archive state) and is cached for good; a token already burned by then answers with the empty word.
      const [key, info] = await context.client.readContract({
        abi: PositionManagerAbi,
        address: positionManager,
        functionName: "getPoolAndPositionInfo",
        args: [tokenId],
        cache: "immutable",
      });
      const empty = isEmptyPositionInfo(info);
      const poolKey = {
        currency0: lower(key.currency0),
        currency1: lower(key.currency1),
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: lower(key.hooks),
      };
      const poolId = empty ? ZERO32 : poolIdOf(poolKey);
      const ticks = decodePositionInfo(info);
      await context.db.insert(nftPositions).values({
        tokenId,
        owner,
        poolId,
        poolName: poolNameOf(deployment.pools, poolId),
        ...poolKey,
        tickLower: ticks.tickLower,
        tickUpper: ticks.tickUpper,
        burned,
        mintedAt: at,
        updatedAt: at,
      });
    } else {
      await context.db.update(nftPositions, { tokenId }).set({ owner, burned, updatedAt: at });
    }
    // Rewards follow the NFT (spec 12.4): the position row, if it is one of ours, moves with it.
    const position = await context.db.find(lpPositions, { tokenId });
    if (position != null) await context.db.update(lpPositions, { tokenId }).set({ owner, updatedAt: at });
  });
}

if (token.PoolManager !== undefined && deployment.pools.length > 0) {
  ponder.on("PoolManager:Initialize", async ({ event, context }) => {
    const { id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick } = event.args;
    const at = event.block.timestamp;
    const poolId = lower(id);
    const def = deployment.pools.find((p) => p.poolId === poolId);
    const values = {
      name: def?.name ?? "unknown",
      currency0: lower(currency0),
      currency1: lower(currency1),
      fee,
      tickSpacing,
      hooks: lower(hooks),
      initialized: true,
      sqrtPriceX96,
      tick,
      updatedAt: at,
    };
    await context.db
      .insert(poolState)
      .values({ poolId, ...values, liquidity: 0n, totalWeight: 0n })
      .onConflictDoUpdate(values);
  });

  ponder.on("PoolManager:ModifyLiquidity", async ({ event, context }) => {
    const { id, sender, tickLower, tickUpper, liquidityDelta, salt } = event.args;
    const at = event.block.timestamp;
    const poolId = lower(id);
    const pool = await ensurePool(context, poolId, at);
    // Active liquidity only moves when the change straddles the current tick; Swap carries the exact figure.
    if (tickInRange(pool.tick, tickLower, tickUpper)) {
      await context.db
        .update(poolState, { poolId })
        .set((row) => ({ liquidity: row.liquidity + liquidityDelta, updatedAt: at }));
    }
    if (ourPool !== undefined && poolId === ourPool.poolId) {
      const positionId = liquidityPositionId(poolId, sender, tickLower, tickUpper, salt);
      await context.db.insert(tvlPositions).values({
        id: positionId, poolId, tickLower, tickUpper, liquidity: liquidityDelta,
      }).onConflictDoUpdate((row) => ({ liquidity: row.liquidity + liquidityDelta }));
    }
    if (ourPool === undefined || poolId !== ourPool.poolId || lower(sender) !== token.PositionManager) return;
    // The PositionManager sets salt = tokenId, which is what makes positions unspoofable (spec 12.4).
    const tokenId = BigInt(salt);
    const position = await ensurePosition(context, tokenId, at);
    const nft = position.owner === ZERO ? await context.db.find(nftPositions, { tokenId }) : undefined;
    await context.db.update(lpPositions, { tokenId }).set({
      tickLower,
      tickUpper,
      liquidity: position.liquidity + liquidityDelta,
      owner: nft?.owner ?? position.owner,
      updatedAt: at,
    });
  });

  ponder.on("PoolManager:Swap", async ({ event, context }) => {
    const { id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick } = event.args;
    const at = event.block.timestamp;
    const poolId = lower(id);
    await ensurePool(context, poolId, at);
    await context.db.insert(swaps).values({
      id: event.id,
      poolId,
      at,
      block: event.block.number,
      sender: lower(sender),
      amount0,
      amount1,
      sqrtPriceX96,
      liquidity,
      tick,
      tx: event.transaction.hash,
    });
    await context.db.update(poolState, { poolId }).set({ sqrtPriceX96, tick, liquidity, updatedAt: at });
  });
}
