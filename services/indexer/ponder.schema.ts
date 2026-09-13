import { index, onchainEnum, onchainTable } from "ponder";

/** V2 identities always include the engine; a local numeric ID is never globally unique. */
export const v2Positions = onchainTable("v2_positions", t => ({
  key: t.text().primaryKey(), engine: t.hex().notNull(), loanId: t.bigint().notNull(),
  state: t.text().notNull(), askPrice: t.bigint().notNull(), askDeadline: t.bigint().notNull(), lenderAskDeadline: t.bigint().notNull(), snapshot: t.text().notNull(), indexedBlock: t.bigint().notNull(),
}), t => ({ engineId: index().on(t.engine, t.loanId), stateIndex: index().on(t.engine, t.state) }));
export const v2Participants = onchainTable("v2_participants", t => ({
  key: t.text().primaryKey(), positionKey: t.text().notNull(), account: t.hex().notNull(),
}), t => ({ accountIndex: index().on(t.account, t.positionKey) }));
export const v2Events = onchainTable("v2_events", t => ({
  key: t.text().primaryKey(), contract: t.hex().notNull(), eventName: t.text().notNull(),
  payload: t.text().notNull(), block: t.bigint().notNull(), timestamp: t.bigint().notNull(), tx: t.hex().notNull(),
}), t => ({ blockIndex: index().on(t.block) }));

// Every table below is rebuilt from events alone (engineering brief 6). Amounts are raw units as bigint,
// timestamps are unix seconds as bigint, addresses are lowercase hex.

export const dealKind = onchainEnum("deal_kind", ["ERC20", "UNIV4_POSITION", "UNIV3_POSITION"]);
export const dealState = onchainEnum("deal_state", ["LISTED", "FUNDED", "RECLAIMED", "CLAIMED", "CANCELLED"]);
export const bidState = onchainEnum("bid_state", ["OPEN", "WITHDRAWN", "ACCEPTED"]);
export const lane = onchainEnum("lane", ["STOCK", "ETH", "MEME", "POSITION"]);
export const balanceKind = onchainEnum("balance_kind", ["USDG", "ERC20", "NFT"]);
export const dripSource = onchainEnum("drip_source", ["deal", "lp"]);
export const feeRoute = onchainEnum("fee_route", ["TREASURY", "BUYBACK"]);
export const lpNoticeKind = onchainEnum("lp_notice_kind", ["EMISSIONS", "LUMP"]);

// ----------------------------------------------------------------- vault layer (M1)

export const deals = onchainTable(
  "deals",
  (t) => ({
    id: t.bigint().primaryKey(),
    borrower: t.hex().notNull(),
    kind: dealKind().notNull(),
    token: t.hex().notNull(),
    amountOrTokenId: t.bigint().notNull(),
    cap: t.bigint().notNull(),
    term: t.integer().notNull(),
    listingExpiry: t.bigint().notNull(),
    minPrice: t.bigint().notNull(),
    lender: t.hex(),
    price: t.bigint(),
    fee: t.bigint(),
    fundedAt: t.bigint(),
    expiry: t.bigint(),
    graceEnd: t.bigint(),
    state: dealState().notNull(),
    lane: lane().notNull(),
    acceptedBidId: t.bigint(),
    openBidCount: t.integer().notNull(),
    listedAt: t.bigint().notNull(),
    listedBlock: t.bigint().notNull(),
    settledAt: t.bigint(),
    listedTx: t.hex().notNull(),
    fundedTx: t.hex(),
    settledTx: t.hex(),
  }),
  (table) => ({
    borrowerIdx: index().on(table.borrower),
    lenderIdx: index().on(table.lender),
    tokenIdx: index().on(table.token),
    stateIdx: index().on(table.state, table.listingExpiry),
    fundedAtIdx: index().on(table.token, table.fundedAt),
  }),
);

export const bids = onchainTable(
  "bids",
  (t) => ({
    id: t.bigint().primaryKey(),
    dealId: t.bigint().notNull(),
    lender: t.hex().notNull(),
    price: t.bigint().notNull(),
    expiry: t.bigint().notNull(),
    state: bidState().notNull(),
    placedAt: t.bigint().notNull(),
    /** When the bid left OPEN (withdrawn or accepted); null while its USDG is still escrowed. */
    closedAt: t.bigint(),
    tx: t.hex().notNull(),
    /** Set when the bid went through EntryRouter (BidWithETH): the ETH the lender paid. */
    ethIn: t.bigint(),
  }),
  (table) => ({
    dealIdx: index().on(table.dealId, table.state),
    lenderIdx: index().on(table.lender),
  }),
);

/** Internal vault balances (pull, never push). id = account-asset, or account-asset-tokenId for an NFT. */
export const balances = onchainTable(
  "balances",
  (t) => ({
    id: t.text().primaryKey(),
    account: t.hex().notNull(),
    asset: t.hex().notNull(),
    kind: balanceKind().notNull(),
    /** Raw amount for USDG and ERC20; the tokenId for NFT (matching `Withdrawn`). */
    amount: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({ accountIdx: index().on(table.account) }),
);

export const assets = onchainTable(
  "assets",
  (t) => ({
    token: t.hex().primaryKey(),
    symbol: t.text().notNull(),
    name: t.text().notNull(),
    decimals: t.integer().notNull(),
    lane: lane().notNull(),
    allowed: t.boolean().notNull(),
    minAmount: t.bigint().notNull(),
    maxDealRaw: t.bigint().notNull(),
    maxOpenRaw: t.bigint().notNull(),
    /** Raw units in LISTED and FUNDED deals, mirroring the vault's `openRaw`. */
    openRaw: t.bigint().notNull(),
    uiMultiplier: t.bigint(),
    pendingMultiplier: t.bigint(),
    effectiveAt: t.bigint(),
    paused: t.boolean(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({ laneIdx: index().on(table.lane) }),
);

/** Registry parameters that are not per asset. One row, id "registry". */
export const registryState = onchainTable("registry_state", (t) => ({
  id: t.text().primaryKey(),
  feeBps: t.integer().notNull(),
  newDealsPaused: t.boolean().notNull(),
  inRangeRequired: t.boolean().notNull(),
  terms: t.integer().array().notNull(),
  memePairMask: t.integer().notNull(),
  updatedAt: t.bigint().notNull(),
}));

export const routers = onchainTable("routers", (t) => ({
  address: t.hex().primaryKey(),
  allowed: t.boolean().notNull(),
  updatedAt: t.bigint().notNull(),
}));

export const pools = onchainTable("registry_pools", (t) => ({
  poolId: t.hex().primaryKey(),
  allowed: t.boolean().notNull(),
  minLiquidity: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/** Vault immutables read once: GRACE for graceEnd, the asset addresses for the balance ledger. */
export const vaultConstants = onchainTable("vault_constants", (t) => ({
  id: t.text().primaryKey(),
  grace: t.bigint().notNull(),
  usdg: t.hex().notNull(),
  usdgDecimals: t.integer().notNull(),
  feeSink: t.hex().notNull(),
  positionManager: t.hex().notNull(),
}));

export const feeSinkState = onchainTable("fee_sink_state", (t) => ({
  id: t.text().primaryKey(),
  route: feeRoute().notNull(),
  vault: t.hex(),
  treasury: t.hex(),
  buyback: t.hex(),
  collectedTotal: t.bigint().notNull(),
  sweptTotal: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/**
 * Weekly rollup for `/stats` (calendar weeks, Monday 00:00 UTC). Every column is a running sum bumped by the
 * handlers, so the row is as rebuildable as the tables it summarises.
 */
export const weekStats = onchainTable("week_stats", (t) => ({
  weekStart: t.bigint().primaryKey(),
  listed: t.integer().notNull(),
  bidsPlaced: t.integer().notNull(),
  funded: t.integer().notNull(),
  funded7: t.integer().notNull(),
  funded21: t.integer().notNull(),
  fundedUSDG: t.bigint().notNull(),
  feesUSDG: t.bigint().notNull(),
  reclaimed: t.integer().notNull(),
  claimed: t.integer().notNull(),
  cancelled: t.integer().notNull(),
  sgageBurned: t.bigint().notNull(),
  usdgSpentOnBuyback: t.bigint().notNull(),
  /** sGAGE granted to deal parties (DealRewards.Registered). */
  sgageGranted: t.bigint().notNull(),
  /** sGAGE handed to LPRewards for the pool (EmissionsNotified). */
  lpEmissions: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

// ----------------------------------------------------------------- token layer (M6)

export const drips = onchainTable(
  "drips",
  (t) => ({
    id: t.text().primaryKey(),
    dripId: t.hex().notNull(),
    account: t.hex().notNull(),
    source: dripSource().notNull(),
    dealId: t.bigint(),
    tokenId: t.bigint(),
    total: t.bigint().notNull(),
    claimed: t.bigint().notNull(),
    start: t.bigint().notNull(),
    length: t.integer().notNull(),
    grantor: t.hex().notNull(),
    grantedAt: t.bigint().notNull(),
    tx: t.hex().notNull(),
  }),
  (table) => ({
    accountIdx: index().on(table.account),
    dealIdx: index().on(table.dealId),
    tokenIdx: index().on(table.tokenId),
    txIdx: index().on(table.tx),
  }),
);

/**
 * Joins a deal reward to its two drips. DealRewards.Registered and Drip.Granted land in one transaction in an order
 * the indexer does not assume: whichever handler runs second completes the link. id = tx-account-amount.
 */
export const grantLinks = onchainTable("grant_links", (t) => ({
  id: t.text().primaryKey(),
  dealId: t.bigint(),
  dripRowId: t.text(),
}));

export const dealRewards = onchainTable(
  "deal_rewards",
  (t) => ({
    dealId: t.bigint().primaryKey(),
    epoch: t.bigint().notNull(),
    term: t.integer().notNull(),
    fee: t.bigint().notNull(),
    reward: t.bigint().notNull(),
    lenderAmount: t.bigint().notNull(),
    borrowerAmount: t.bigint().notNull(),
    budgetExhausted: t.boolean().notNull(),
    registeredAt: t.bigint().notNull(),
    tx: t.hex().notNull(),
  }),
  (table) => ({ txIdx: index().on(table.tx) }),
);

export const epochs = onchainTable("epochs", (t) => ({
  n: t.bigint().primaryKey(),
  startsAt: t.bigint().notNull(),
  endsAt: t.bigint().notNull(),
  weekly: t.bigint().notNull(),
  dealShareBps: t.integer().notNull(),
  term21ShareBps: t.integer().notNull(),
  dealBudget7: t.bigint().notNull(),
  dealBudget21: t.bigint().notNull(),
  reserved7: t.bigint().notNull(),
  reserved21: t.bigint().notNull(),
  liquidityBudget: t.bigint().notNull(),
  rate7: t.bigint(),
  rate21: t.bigint(),
  priceUSDGPerSGAGE: t.bigint(),
  lenderShareBps: t.integer(),
  released: t.boolean().notNull(),
  rolledOver: t.boolean().notNull(),
  rolledOverAmount: t.bigint().notNull(),
}));

/** One row, id "emissions": the schedule constants and the launch time. */
export const emissionsState = onchainTable("emissions_state", (t) => ({
  id: t.text().primaryKey(),
  launchAt: t.bigint(),
  epochLength: t.bigint().notNull(),
  weeks: t.integer().notNull(),
  reserve: t.bigint().notNull(),
  finalizedBurn: t.bigint(),
  updatedAt: t.bigint().notNull(),
}));

export const burns = onchainTable(
  "burns",
  (t) => ({
    id: t.text().primaryKey(),
    at: t.bigint().notNull(),
    usdgSpent: t.bigint().notNull(),
    ethOut: t.bigint().notNull(),
    gageBought: t.bigint().notNull(),
    sgageBurned: t.bigint().notNull(),
    bounty: t.bigint().notNull(),
    caller: t.hex().notNull(),
    tx: t.hex().notNull(),
  }),
  (table) => ({ atIdx: index().on(table.at) }),
);

export const creatorFeeSplits = onchainTable("creator_fee_splits", (t) => ({
  id: t.text().primaryKey(),
  at: t.bigint().notNull(),
  caller: t.hex().notNull(),
  ethTotal: t.bigint().notNull(),
  ethToOps: t.bigint().notNull(),
  /** GAGE that went into the sGAGE floor (D46). */
  gageToFloor: t.bigint().notNull(),
  bounty: t.bigint().notNull(),
  tx: t.hex().notNull(),
}));

/** One row per floor band the CreatorFeeSplitter owns in the GAGE/sGAGE pool (D46), from FloorAdded / FloorSwept. */
export const floorBands = onchainTable("floor_bands", (t) => ({
  tokenId: t.bigint().primaryKey(),
  tickLower: t.integer().notNull(),
  tickUpper: t.integer().notNull(),
  liquidity: t.bigint().notNull(),
  gageIn: t.bigint().notNull(),
  swept: t.boolean().notNull(),
  sgageBurned: t.bigint().notNull(),
  createdAt: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/**
 * Every PositionManager NFT, from `Transfer`: the owner, and the pool key and ticks read once from
 * `getPoolAndPositionInfo` (immutable for the life of a tokenId; zero when the token was already burned at the
 * latest block, since the public RPC has no archive state). Also gives a position in our pool an owner whichever
 * event lands first. Liquidity is not stored: `/wallet/:address/positions` reads it at the latest block.
 */
export const nftPositions = onchainTable(
  "nft_positions",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    owner: t.hex().notNull(),
    poolId: t.hex().notNull(),
    poolName: t.text(),
    currency0: t.hex().notNull(),
    currency1: t.hex().notNull(),
    fee: t.integer().notNull(),
    tickSpacing: t.integer().notNull(),
    hooks: t.hex().notNull(),
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    burned: t.boolean().notNull(),
    mintedAt: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({ ownerIdx: index().on(table.owner, table.burned) }),
);

export const lpPositions = onchainTable(
  "lp_positions",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    poolId: t.hex().notNull(),
    owner: t.hex().notNull(),
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    liquidity: t.bigint().notNull(),
    /** Value in GAGE at the last checkpoint, zero while out of range (ILPRewards). */
    weight: t.bigint().notNull(),
    inRange: t.boolean().notNull(),
    lastCheckpoint: t.bigint().notNull(),
    isSeed: t.boolean().notNull(),
    createdAt: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({ ownerIdx: index().on(table.owner) }),
);

/** What a position's owners have collected so far (LPRewards.Collected). */
export const lpEarned = onchainTable("lp_earned", (t) => ({
  tokenId: t.bigint().primaryKey(),
  emissionsEarned: t.bigint().notNull(),
  creatorFeeEarned: t.bigint().notNull(),
  collectedAt: t.bigint(),
  collectCount: t.integer().notNull(),
}));

export const lpNotices = onchainTable("lp_notices", (t) => ({
  id: t.text().primaryKey(),
  kind: lpNoticeKind().notNull(),
  epoch: t.bigint(),
  from: t.hex(),
  amount: t.bigint().notNull(),
  totalWeight: t.bigint(),
  at: t.bigint().notNull(),
  tx: t.hex().notNull(),
}));

// ----------------------------------------------------------------- LP streamer (D64)

/** One row per epoch whose pot the streamer fixed (PotFixed): `rate` is sGAGE per sGAGE of LPRewards accrual, 1e27. */
export const lpStreamerEpochs = onchainTable("lp_streamer_epochs", (t) => ({
  epoch: t.bigint().primaryKey(),
  pot: t.bigint().notNull(),
  rate: t.bigint().notNull(),
  fixedAt: t.bigint().notNull(),
  tx: t.hex().notNull(),
}));

/** Every deposit into the next epoch's pot (Deposited); anyone may deposit. id = event id. */
export const lpStreamerDeposits = onchainTable(
  "lp_streamer_deposits",
  (t) => ({
    id: t.text().primaryKey(),
    from: t.hex().notNull(),
    amount: t.bigint().notNull(),
    forEpoch: t.bigint().notNull(),
    at: t.bigint().notNull(),
    tx: t.hex().notNull(),
  }),
  (table) => ({ atIdx: index().on(table.at) }),
);

/** Every checkpoint (Checkpointed): the LPRewards accrual seen and the sGAGE credited, for the keeper's audit trail. */
export const lpStreamerCheckpoints = onchainTable(
  "lp_streamer_checkpoints",
  (t) => ({
    id: t.text().primaryKey(),
    tokenId: t.bigint().notNull(),
    accrual: t.bigint().notNull(),
    credit: t.bigint().notNull(),
    epoch: t.bigint().notNull(),
    at: t.bigint().notNull(),
    tx: t.hex().notNull(),
  }),
  (table) => ({ tokenIdx: index().on(table.tokenId) }),
);

/**
 * What a position's owners have collected from the streamer so far (Collected); the pending balance is read live.
 * Each collect opens a 7-day drip on the streamer's own Drip (`LPStreamerDrip`); `lastDripId` is the newest one, the
 * drip rows themselves live in `drips` like any other.
 */
export const lpStreamerCollected = onchainTable("lp_streamer_collected", (t) => ({
  tokenId: t.bigint().primaryKey(),
  collectedTotal: t.bigint().notNull(),
  collectCount: t.integer().notNull(),
  collectedAt: t.bigint().notNull(),
  lastDripId: t.hex().notNull(),
}));

export const poolState = onchainTable("pool_state", (t) => ({
  poolId: t.hex().primaryKey(),
  name: t.text().notNull(),
  currency0: t.hex().notNull(),
  currency1: t.hex().notNull(),
  fee: t.integer().notNull(),
  tickSpacing: t.integer().notNull(),
  hooks: t.hex().notNull(),
  initialized: t.boolean().notNull(),
  sqrtPriceX96: t.bigint().notNull(),
  tick: t.integer().notNull(),
  liquidity: t.bigint().notNull(),
  totalWeight: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

export const swaps = onchainTable(
  "swaps",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    at: t.bigint().notNull(),
    block: t.bigint().notNull(),
    sender: t.hex().notNull(),
    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
    sqrtPriceX96: t.bigint().notNull(),
    liquidity: t.bigint().notNull(),
    tick: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (table) => ({ poolAtIdx: index().on(table.poolId, table.at) }),
);

export const reinvests = onchainTable("reinvests", (t) => ({
  id: t.text().primaryKey(),
  owner: t.hex().notNull(),
  tokenId: t.bigint().notNull(),
  zap: t.boolean().notNull(),
  sgageIn: t.bigint().notNull(),
  sgageSold: t.bigint().notNull(),
  gageBought: t.bigint().notNull(),
  liquidity: t.bigint().notNull(),
  at: t.bigint().notNull(),
  tx: t.hex().notNull(),
}));

export const seedTimelock = onchainTable("seed_timelock", (t) => ({
  id: t.text().primaryKey(),
  tokenId: t.bigint(),
  releaseAt: t.bigint(),
  released: t.boolean().notNull(),
  releasedTo: t.hex(),
  fees0: t.bigint().notNull(),
  fees1: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/** Deal-fee conversion receipts: all purchased GAGE backs permanent floor bands. */
export const dealFeeFloorDeposits = onchainTable("deal_fee_floor_deposits", (t) => ({
  id: t.text().primaryKey(), at: t.bigint().notNull(), caller: t.hex().notNull(),
  usdgIn: t.bigint().notNull(), ethOut: t.bigint().notNull(), gageBought: t.bigint().notNull(),
  gageAdded: t.bigint().notNull(), tx: t.hex().notNull(),
}));

/** Actual GAGE/sGAGE principal across every v4 owner/range/salt, rebuilt from ModifyLiquidity. */
export const tvlPositions = onchainTable("tvl_positions", (t) => ({
  id: t.text().primaryKey(),
  poolId: t.hex().notNull(),
  tickLower: t.integer().notNull(),
  tickUpper: t.integer().notNull(),
  liquidity: t.bigint().notNull(),
}));

// Earn snapshots are reconstructed from events and reads pinned to those event blocks. Reserve conversion
// refreshes periodically even without an Earn transaction; all HTTP responses use one checked snapshot.
export const earnStrategies = onchainTable("earn_strategies", t => ({
  address: t.hex().primaryKey(), snapshot: t.text().notNull(), block: t.bigint().notNull(), asOf: t.bigint().notNull(), ready: t.boolean().notNull(),
  shareAssetsNumerator: t.bigint().notNull(), shareAssetsDenominator: t.bigint().notNull(),
}));
export const earnAccounts = onchainTable("earn_accounts", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), account: t.hex().notNull(), snapshot: t.text().notNull(),
}), t => ({ accountIndex: index().on(t.strategy, t.account) }));
/** Bounded passive-account refresh progress. Ponder rolls this back together with account checkpoints. */
export const earnAccountRefresh = onchainTable("earn_account_refresh", t => ({
  strategy: t.hex().primaryKey(), after: t.hex(), active: t.hex(), pocketAfter: t.text(),
}));
/** Event-order balances preserve pocket ownership even when recovery occurs after a full exit. */
export const earnShareChanges = onchainTable("earn_share_changes", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), account: t.hex().notNull(), position: t.bigint().notNull(), balance: t.bigint().notNull(),
}), t => ({ accountPositionIndex: index().on(t.strategy, t.account, t.position) }));
export const earnLoanSnapshots = onchainTable("earn_loan_snapshots", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), dealId: t.bigint().notNull(), position: t.bigint().notNull(),
}));
export const earnPocketClaims = onchainTable("earn_pocket_claims", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), account: t.hex().notNull(), pocketId: t.text().notNull(), position: t.bigint().notNull(),
}), t => ({ accountIndex: index().on(t.strategy, t.account) }));
/** Bounded catch-up warms immutable entitlement balances; claims remain in their own event ledger. */
export const earnAccountPockets = onchainTable("earn_account_pockets", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), account: t.hex().notNull(), pocketId: t.text().notNull(), balanceAt: t.bigint().notNull(),
}), t => ({ accountIndex: index().on(t.strategy, t.account, t.pocketId) }));
export const earnAccountPocketProgress = onchainTable("earn_account_pocket_progress", t => ({
  key: t.text().primaryKey(), after: t.bigint().notNull(),
}));
/** One row per redemption request; `id` is the decimal request id, ordered as text like every other cursor. */
export const earnRequests = onchainTable("earn_requests", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), id: t.text().notNull(), number: t.bigint().notNull(), account: t.hex().notNull(), snapshot: t.text().notNull(), open: t.boolean().notNull(),
}), t => ({ accountIndex: index().on(t.strategy, t.account, t.id), openIndex: index().on(t.strategy, t.open, t.number) }));
export const earnRequestCounts = onchainTable("earn_request_counts", t => ({
  strategy: t.hex().primaryKey(), count: t.integer().notNull(),
}));
/** One row per loan the strategy funded (D82: pooled shares, no participants). */
export const earnLoans = onchainTable("earn_loans", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), id: t.text().notNull(), dealId: t.bigint().notNull(), snapshot: t.text().notNull(), settled: t.boolean().notNull(),
}), t => ({ dealIndex: index().on(t.strategy, t.dealId), openIndex: index().on(t.strategy, t.settled) }));
/** Side pockets opened by finalized defaults; pocket ids double as balance snapshot ids on-chain. */
export const earnPockets = onchainTable("earn_pockets", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), id: t.text().notNull(), number: t.bigint().notNull(), snapshot: t.text().notNull(),
}), t => ({ strategyIndex: index().on(t.strategy, t.id), numberIndex: index().on(t.strategy, t.number) }));
export const earnApprovals = onchainTable("earn_approvals", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), dealId: t.bigint().notNull(), snapshot: t.text().notNull(), funded: t.boolean().notNull(), revoked: t.boolean().notNull(), validUntil: t.bigint().notNull(),
}), t => ({ dealIndex: index().on(t.strategy, t.dealId), activeIndex: index().on(t.strategy, t.funded, t.revoked, t.validUntil) }));
export const earnEvents = onchainTable("earn_events", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), id: t.text().notNull(), account: t.hex().notNull(), snapshot: t.text().notNull(),
}), t => ({ accountIndex: index().on(t.strategy, t.account, t.id) }));

/** One row per account sync: the USDG value and the block's flow, the basis of the time-weighted return. */
export const earnAccountHistory = onchainTable("earn_account_history", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), account: t.hex().notNull(), block: t.bigint().notNull(), asOf: t.bigint().notNull(), value: t.text().notNull(), flow: t.text().notNull(),
}), t => ({ accountIndex: index().on(t.strategy, t.account, t.block) }));

/** Reserve conversion samples about an hour apart (assets per one reserve share unit); the published reserve rate is their growth over about a week. */
export const earnReserveSamples = onchainTable("earn_reserve_samples", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), block: t.bigint().notNull(), asOf: t.bigint().notNull(), assets: t.bigint().notNull(),
}), t => ({ strategyIndex: index().on(t.strategy, t.asOf) }));
/** Exact settlement blocks prevent future core state leaking into an earlier block with the same timestamp. */
export const earnCoreStates = onchainTable("earn_core_states", t => ({
  dealId: t.bigint().primaryKey(), state: t.text().notNull(), block: t.bigint().notNull(),
}));
/** Admission events can precede fee companion wiring; preserve them before the first complete snapshot. */
export const earnTokenInventory = onchainTable("earn_token_inventory", t => ({
  key: t.text().primaryKey(), strategy: t.hex().notNull(), token: t.hex().notNull(),
}));
