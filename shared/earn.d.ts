/** Earn JSON contract. Canonical across web and services; see docs/api.md. */
export type EarnAddress = `0x${string}`;
export type EarnAmount = string;
export type EarnLane = "STOCK" | "MEME" | "LP";
export type EarnCollateralKind = "ERC20" | "UNIV3_POSITION" | "UNIV4_POSITION";
export interface EarnSnapshot { chainId: number; strategy: EarnAddress; blockNumber: string; asOf: number }
export interface EarnPage<T> extends EarnSnapshot { items: T[]; nextCursor: string | null }
export interface EarnMandate {
  minDeposit: EarnAmount;
  maxTotalDeposits: EarnAmount; maxLoanTerm: number; minReturnBps: number; maxGageExposureBps: number;
}
export interface EarnToken {
  token: EarnAddress; symbol: string; decimals: number; unit: EarnAmount; lane: EarnLane;
  ceiling: EarnAmount; allowed: boolean;
  /** ERC-8056 display multiplier, raw 18-decimal fixed-point; 1e18 means one. */
  uiMultiplier: EarnAmount;
  /** Strategy position principal outstanding in open loans against this token; absent from the chain fallback. */
  principal?: EarnAmount;
}
/** A finalized default: the recovered collateral belongs to the holders of record when the pocket opened. */
export interface EarnPocket extends EarnSnapshot {
  id: string; dealId: string; token: EarnAddress; amount: EarnAmount;
  /** Metadata of the recovered asset, which need not be an admitted lending token. Zero token means native ETH. */
  metadata?: { symbol: string; decimals: number; uiMultiplier: EarnAmount };
  /** Share supply when the pocket opened; a holder's part is amount × balanceOfAt / supply. */
  supply: EarnAmount; claimed: EarnAmount; openedAt: number;
}
export interface EarnStrategy extends EarnSnapshot {
  /** Catalog identity from the deployment manifest: the app route slug (`/earn/<id>`) and the display name. */
  id: string; title: string;
  /** `core` is the Gage V2 engine the strategy lends through; `coreRewards` its sGAGE ledger. */
  address: EarnAddress; core: EarnAddress; coreRewards: EarnAddress; registry: EarnAddress; reserveAsset: EarnAddress; reserveSymbol: string;
  rewardToken: { address: EarnAddress; symbol: string; decimals: number };
  reserve: EarnAddress; curator: EarnAddress; usdg: EarnAddress;
  usdgDecimals: number; reserveDecimals: number;
  /** Strategy shares carry 18 decimals and are not transferable. */
  shareDecimals: number; paused: boolean;
  /** Performance fee on realized loan profit that lifts the share price above the vault's high-water mark, snapshotted per loan. */
  feeBps: number;
  /** The fee companion that splits collected fees; `feeRecipient` is its curator payout address. */
  fees: EarnAddress; feeRecipient: EarnAddress;
  /** Share of every fee routed to the protocol floor route, fixed at deployment. */
  protocolShareBps: number; protocolRecipient: EarnAddress;
  /** `feeAccrued` waits in the strategy; the companion holds the split `curatorAccrued` and `protocolAccrued`. */
  feeAccrued: EarnAmount; curatorAccrued: EarnAmount; protocolAccrued: EarnAmount;
  /** The highest full-assets share price after a fee, in USDG units per share scaled by 1e36. */
  highWaterPrice: EarnAmount; mandate: EarnMandate;
  /** Core grace after the term before a default can be finalized, in seconds. */
  grace: number;
  lanes: { lane: EarnLane; weightBps: number; principal: EarnAmount; cap: EarnAmount; headroom: EarnAmount }[];
  tokens: EarnToken[];
  shares: {
    totalSupply: EarnAmount;
    /** Virtual shares in the conversion denominator (1e12): one USDG unit starts worth 1e12 shares. */
    virtualShares: EarnAmount;
    /** USDG units per 1e18 shares at `totalAssets`, the price deposits and redemptions execute at. */
    price: EarnAmount;
    /** The same price before profit unlocking, on `fullAssets`. */
    fullPrice: EarnAmount;
  };
  totals: {
    cash: EarnAmount; reserveShares: EarnAmount; reserveAssets: EarnAmount;
    /** Loans carried at principal; `overduePrincipal` is written down and counts for nothing. */
    performingPrincipal: EarnAmount; overduePrincipal: EarnAmount;
    /** cash + reserveAssets + performingPrincipal; `totalAssets` is that less the profit still unlocking. */
    fullAssets: EarnAmount; totalAssets: EarnAmount; lockedProfit: EarnAmount;
    unlockStart: number; unlockEnd: number; profitUnlockSeconds: number;
    /** cash + reserveAssets: what redemptions and new loans can draw on before requests are counted. */
    freeLiquidity: EarnAmount;
    /** Shares queued for redemption and their value at the current price. */
    pendingShares: EarnAmount; pendingRequestAssets: EarnAmount; openRequests: number;
    /** USDG credited to served requests and not yet claimed. */
    claimableTotal: EarnAmount; harvestedCash: EarnAmount; assignedCash: EarnAmount;
    /** Cumulative sGAGE per share (1e18 fixed-point) and the remainder held while no shares exist. */
    accRewardPerShare: EarnAmount; rewardRemainder: EarnAmount;
  };
  pockets: EarnPocket[];
  /** The reserve's realized share-price growth over about a week before this snapshot, as a simple yearly rate; null when the chain
   * cannot serve the older state, absent from the chain fallback and from snapshots published before the field existed. */
  reserveRate?: EarnReserveRate | null;
}
export interface EarnReserveRate { yearlyBps: number; windowSeconds: number; fromBlock: string; toBlock: string }
export interface EarnAccount extends EarnSnapshot {
  account: EarnAddress;
  /** `shares` includes `lockedShares` waiting in requests; `freeShares` may be redeemed at once. */
  shares: EarnAmount; lockedShares: EarnAmount; freeShares: EarnAmount;
  /** convertToAssets(shares) at the current price, and what `maxWithdraw` allows right now. */
  value: EarnAmount; withdrawable: EarnAmount;
  /** USDG credited by served requests, waiting for `claim()`. */
  claimable: EarnAmount; rewards: EarnAmount;
  requests: EarnRequest[];
  pockets: { pocketId: string; dealId: string; token: EarnAddress; claimable: EarnAmount; claimed: boolean; balanceAt: EarnAmount }[];
  /** Cumulative collateral this account claimed from pockets, per token. */
  collateralReceived: { token: EarnAddress; amount: EarnAmount }[];
  /** USDG-denominated performance from the indexed value history; absent from the chain fallback. */
  performance?: EarnPerformance;
}
/** Value counts share value and unclaimed served USDG; collateral held is not valued, so a default shows as a loss. */
export interface EarnPerformance {
  valueUSDG: EarnAmount; depositsUSDG: EarnAmount; withdrawalsUSDG: EarnAmount;
  /** value + withdrawals - deposits, signed. */
  profitUSDG: string;
  /** Cumulative time-weighted return in basis points, chained across every flow since the first deposit; never annualized. */
  twrBps: number;
  sinceAt: number; samples: number;
}
export type EarnRequestStatus = "pending" | "partial" | "served" | "cancelled";
export interface EarnRequest extends EarnSnapshot {
  id: string; account: EarnAddress;
  /** Shares still queued, shares already burned for this request and the USDG credited for them. */
  shares: EarnAmount; servedShares: EarnAmount; servedAssets: EarnAmount; status: EarnRequestStatus;
  /** 1-based place among open requests; 0 once served or cancelled. */
  position: number; requestedAt: number;
}
/** Funding: units bought, listing not yet active. Settling: the core resolved (or the funding window closed) and Earn settlement is pending. */
export type EarnLoanState = "Funding" | "Active" | "Overdue" | "Claimable" | "Settling" | "Repaid" | "Collateral" | "Refunded";
export type EarnCoreState = "FUNDING" | "ACTIVE" | "REPAID" | "DEFAULTED" | "CANCELLED";
export interface EarnLoan extends EarnSnapshot {
  id: string; dealId: string; borrower: EarnAddress; token: EarnAddress; lane: EarnLane; kind: EarnCollateralKind;
  /** `principal`/`cap` describe the whole V2 loan; `positionPrincipal` is the strategy's own quarters.
   * `token`/`collateralAmount` are the ERC20 asset/amount or, for LP collateral, the manager/NFT ID. */
  principal: EarnAmount; cap: EarnAmount; collateralAmount: EarnAmount;
  positionPrincipal: EarnAmount; units: number; slots: number; withdrawn: boolean;
  /** True once the strategy wrote the principal down at term end; `carried` is what the share price still counts. */
  overdue: boolean; carried: EarnAmount;
  state: EarnLoanState; coreState: EarnCoreState;
  /** Zero until the loan activates. `fundingDeadline` closes the listing; `claimableAt` is expiry plus core grace. */
  fundingDeadline: number; fundedAt: number; expiry: number; claimableAt: number; settled: boolean;
  /** Settlement result: USDG received (`payout`), booked profit or loss, fee and recovery pockets (one per underlying asset).
   * `pocketId` preserves the first pocket for clients that only show one; `pocketIds` contains every recovery. */
  outcome: "cash" | "collateral" | "refund" | null; payout: EarnAmount; profit: string; fee: EarnAmount; feeBps: number; pocketId: string | null; pocketIds: string[];
  /** sGAGE harvested from this loan into the strategy so far. */
  rewards: EarnAmount;
  /** The core loan term in seconds, and the sGAGE the core ledger allocated to the strategy's quarters over that term
   * (released on the ledger's quadratic curve; zero until activation). Absent from rows published before these fields existed. */
  term?: number; rewardTotal?: EarnAmount;
}
export interface EarnApproval extends EarnSnapshot {
  dealId: string; token: EarnAddress; lane: EarnLane; kind: EarnCollateralKind; principal: EarnAmount; units: number; validUntil: number;
  funded: boolean; revoked: boolean;
}
/** Loan outcomes are strategy-wide (`account` is the strategy); served requests name the requester. */
export interface EarnNotice extends EarnSnapshot {
  id: string; kind: "repayment" | "collateral" | "refund" | "overdue" | "served"; account: EarnAddress;
  dealId: string | null; token: EarnAddress; amount: EarnAmount; transactionHash: string;
}
export interface EarnKeeperAlert {
  id: string; code: "keeper_revert" | "harvest_failed" | "reserve_redemption_failed";
  action: string; strategy: EarnAddress; at: number; attempts: number;
}
export interface EarnKeeperHealth {
  ok: boolean; chainId: number; strategy: EarnAddress; mode: "dry-run" | "execute" | "disabled";
  lastTickAt: number | null; staleAfterSeconds: number; pendingTransaction: string | null;
  failures: { action: string; attempts: number; retryAt: number }[]; alerts: EarnKeeperAlert[];
}
