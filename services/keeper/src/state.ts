/**
 * Keeper memory, persisted to `<OUT_DIR>/keeper-state.json` so a restart does not rescan from the deploy block.
 * Everything here is a cache: deleting the file is always safe, it only costs RPC calls.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EarnKeeperAlert } from "../../../shared/earn.js";

export interface FundedRecord {
  dealId: string;
  fee: string;
  price: string;
  fundedAt: number;
  expiry: number;
}

export interface PriceSample {
  blockNumber?: string;
  /** Unix seconds. */
  t: number;
  /** USDG raw units per 1e18 sGAGE, as a decimal string. */
  priceUSDGPerSGAGE: string;
}

/** One backstop deal (D64): listed, funded and registered by the keeper wallet on both sides, then reclaimed. */
export interface BackstopRecord {
  dealId: string;
  /** Epoch whose unreserved budget the deal reserves; the deal must be funded inside it. */
  epoch: string;
  bucket: 7 | 21;
  /** Seconds. */
  term: number;
  token: string;
  /** Collateral, raw units. */
  amount: string;
  /** Asking price == cap, USDG raw units. */
  price: string;
  /** Fee the vault deducts at funding, USDG raw units. */
  fee: string;
  /** sGAGE the registration is expected to reserve. */
  reservation: string;
  createdAt: number;
  /** Every step is finished: registered, reclaimed and withdrawn (or cancelled and withdrawn). */
  done: boolean;
  /** Unix ms after which a step that reverted may be retried. */
  retryAfter?: number;
}

/** Earn retry memory of one strategy. */
export interface EarnStrategyState {
  lastTickAt: number | null;
  failures: Record<string, { attempts: number; retryAt: number; firstAt: number }>;
  alerts: EarnKeeperAlert[];
}

export interface KeeperState {
  /** Keyed by lowercase strategy address. Files written before multi-strategy support hold one bare bucket; see `earnBucket`. */
  earn?: Record<string, EarnStrategyState>;
  version: 1;
  /** Next block to scan for `Funded` logs on the vault. */
  fundedCursor: string | undefined;
  funded: Record<string, FundedRecord>;
  /** Deal ids DealRewards reports as registered. */
  registered: string[];
  /** Deal ids whose `register` reverted, with the unix ms after which to retry. */
  registerRetryAfter: Record<string, number>;
  /** Next block to scan for PositionManager `Transfer` logs. */
  positionCursor: string | undefined;
  /** tokenId -> belongs to the GAGE/sGAGE pool. */
  positionPool: Record<string, boolean>;
  /** Positions burned (transferred to the zero address). */
  burned: string[];
  /** Inventory of positions that have carried positive LP reward weight, including withdrawn/burned NFTs. */
  lpRewardPositions: string[];
  lpRewardCursor: string | undefined;
  lpRewardContract: string | undefined;
  /** Next block to scan for `Swap` logs on the GAGE/sGAGE pool (swap watcher). */
  swapCursor: string | undefined;
  /** Block of the last swap seen in the GAGE/sGAGE pool. */
  lastSwapBlock: string | undefined;
  /** Last swap-triggered checkpoint: the head block it covered and the unix ms it was sent. */
  lastSwapCheckpoint: { block: string; at: number } | undefined;
  priceSamples: PriceSample[];
  /** Epoch numbers for which a proposal file has been written. */
  proposalsWritten: string[];
  /** Unix ms after which to retry `rollover(epoch)` / `finalize()`. */
  epochRetryAfter: Record<string, number>;
  finalized: boolean;
  ratesHealth?: { checkedAt: number; status: "ok" | "blocked"; reason?: string };
  /** Streamer boundary passes: the boundary (unix seconds, as a string) each pass last covered and when. */
  streamerBoundary: { lastPre: { boundary: string; at: number } | undefined; lastPost: { boundary: string; at: number } | undefined };
  /** Last `LPStreamer.deposit` the deposit job sent. */
  lastStreamerDeposit: { amount: string; forEpoch: string; at: number } | undefined;
  /** Deal ids of every backstop deal the keeper wallet created (its drips feed the deposit job). */
  backstopDeals: string[];
  backstop: Record<string, BackstopRecord>;
}

/**
 * The Earn bucket of one strategy, created on first access. A legacy single bucket (a file persisted with
 * `earn.lastTickAt` at the top level) belonged to the flagship and is moved under its address once.
 */
export function earnBucket(state: KeeperState, strategy: string, flagship: string): EarnStrategyState {
  const earn = state.earn ??= {};
  if ("lastTickAt" in earn) state.earn = { [flagship]: earn as unknown as EarnStrategyState };
  return state.earn[strategy] ??= { lastTickAt: null, failures: {}, alerts: [] };
}

export function emptyState(): KeeperState {
  return {
    version: 1,
    fundedCursor: undefined,
    funded: {},
    registered: [],
    registerRetryAfter: {},
    positionCursor: undefined,
    positionPool: {},
    burned: [],
    lpRewardPositions: [],
    lpRewardCursor: undefined,
    lpRewardContract: undefined,
    swapCursor: undefined,
    lastSwapBlock: undefined,
    lastSwapCheckpoint: undefined,
    priceSamples: [],
    proposalsWritten: [],
    epochRetryAfter: {},
    finalized: false,
    streamerBoundary: { lastPre: undefined, lastPost: undefined },
    lastStreamerDeposit: undefined,
    backstopDeals: [],
    backstop: {},
  };
}

export function loadState(path: string): KeeperState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyState();
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    return emptyState();
  }
  return { ...emptyState(), ...(parsed as Partial<KeeperState>), version: 1 };
}

export function saveState(path: string, state: KeeperState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
