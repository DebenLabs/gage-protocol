import type { EarnAddress, EarnApproval, EarnCollateralKind, EarnCoreState, EarnLane, EarnLoan, EarnNotice, EarnPocket, EarnRequest, EarnStrategy, EarnToken } from "../../../../shared/earn";
import { checkpointPerformance, performanceFromCheckpoint, reserveRatio, shareAssets, shareRatio, type EarnValueSample } from "./earn-accounting";
import { type EarnAccountRecord, type EarnPocketRecord } from "./earn-account-state";

export type EarnReader = (target: EarnAddress, name: string, args: readonly unknown[], block: bigint) => Promise<unknown>;
export type EarnConfig = { chainId: number; id?: string; title?: string; HybridVault: EarnAddress; HybridReserve: EarnAddress; USDG: EarnAddress; EarnCore: EarnAddress; RewardToken?: EarnAddress };
export interface EarnSyncStore {
  admittedTokens(): Promise<EarnAddress[]>;
  strategy(): Promise<EarnStrategy | undefined>;
  saveStrategy(value: EarnStrategy, ratio: { numerator: bigint; denominator: bigint }): Promise<void>;
  accountPage(after: EarnAddress | undefined, limit: number): Promise<EarnAccountRecord[]>;
  accountCursor(): Promise<{ after?: EarnAddress; active?: EarnAddress; pocketAfter?: string }>;
  saveAccountCursor(cursor: { after?: EarnAddress; active?: EarnAddress; pocketAfter?: string }): Promise<void>;
  pocketPage(after: string | undefined, limit: number): Promise<EarnPocketRecord[]>;
  accountPocketCursor(account: EarnAddress): Promise<string | undefined>;
  saveAccountPocketCursor(account: EarnAddress, after: string): Promise<void>;
  accountPocket(account: EarnAddress, pocket: EarnPocketRecord): Promise<void>;
  account(account: EarnAddress): Promise<EarnAccountRecord | undefined>;
  saveAccount(value: EarnAccountRecord): Promise<void>;
  /** One row per account and block, oldest first; every event in a block reads the same end-of-block state, so flows are summed per block. */
  history(account: EarnAddress): Promise<(EarnValueSample & { block: bigint })[]>;
  saveHistory(account: EarnAddress, row: EarnValueSample & { block: bigint }): Promise<void>;
  loans(): Promise<EarnLoan[]>;
  loan(dealId: string): Promise<EarnLoan | undefined>;
  saveLoan(value: EarnLoan): Promise<void>;
  openRequestCount(): Promise<number>;
  requests(account?: EarnAddress): Promise<EarnRequest[]>;
  request(id: string): Promise<EarnRequest | undefined>;
  saveRequest(value: EarnRequest): Promise<void>;
  pockets(): Promise<EarnPocketRecord[]>;
  pocket(id: string): Promise<EarnPocketRecord | undefined>;
  savePocket(value: EarnPocketRecord): Promise<void>;
  approvals(at?: bigint): Promise<EarnApproval[]>;
  approval(dealId: string): Promise<EarnApproval | undefined>;
  saveApproval(value: EarnApproval): Promise<void>;
  notice(value: EarnNotice): Promise<void>;
  /** The newest reserve conversion sample and a new one; the sync keeps them about an hour apart. */
  latestReserveSample(): Promise<EarnReserveSample | undefined>;
  saveReserveSample(row: EarnReserveSample): Promise<void>;
}
/** Assets per one reserve share unit at a block: the reserve's own growth, untouched by deposits and redemptions. */
export type EarnReserveSample = { block: bigint; asOf: bigint; assets: bigint };
export const RESERVE_SAMPLE_INTERVAL = 3600n;
/** Settlement facts only events carry: the chain views keep neither payouts nor booked profit per loan. */
export type EarnLoanUpdate = { payout?: bigint; profit?: bigint; fee?: bigint; pocketId?: bigint; rewards?: bigint };
export type EarnRequestUpdate = { served?: { shares: bigint; assets: bigint }; cancelled?: boolean };
const lower = (v: string) => v.toLowerCase() as EarnAddress;
const lanes = ["STOCK", "MEME", "LP"] as const;
const kinds: readonly EarnCollateralKind[] = ["ERC20", "UNIV4_POSITION", "UNIV3_POSITION"];
export const CORE_STATES: readonly (EarnCoreState | "NONE")[] = ["NONE", "FUNDING", "ACTIVE", "REPAID", "DEFAULTED", "CANCELLED"];
const UNITS = 4;
const ONE_SHARE = 10n ** 18n;
const ZERO = /^0x0{40}$/i;
const snapshot = (config: EarnConfig, block: bigint, asOf: bigint) => ({ chainId: config.chainId, strategy: config.HybridVault, blockNumber: String(block), asOf: Number(asOf) });
const big = (v: unknown) => BigInt(v as bigint);
const uint = (v: unknown) => Number(v);
/** Registry categories are independent of Earn allocation categories: WETH shares the stock allocation. */
function registryEarnLane(raw: unknown): EarnLane {
  const lane = uint(raw);
  if (lane === 0 || lane === 1) return "STOCK";
  if (lane === 2) return "MEME";
  throw new Error("Invalid Earn registry lane");
}
function collateralKind(raw: unknown): EarnCollateralKind {
  const kind = kinds[uint(raw)];
  if (!kind) throw new Error("Invalid Earn collateral kind");
  return kind;
}
type RecordValues = Record<string, bigint | boolean | string | number>;
/** Public struct getters decode as positional tuples; typed fixtures may hand back named objects. */
const field = (raw: unknown, index: number, name: string): unknown => Array.isArray(raw) ? raw[index] : (raw as Record<string, unknown>)[name];

/** The core prices quarter i of a total as total / 4 plus one raw unit for the first (total mod 4) quarters. */
export function quarterSlice(total: bigint, slot: number): bigint {
  return total / 4n + (BigInt(slot) < total % 4n ? 1n : 0n);
}
/** Sum of the quarters selected by a four-bit slot mask. */
export function sliceSum(total: bigint, slots: number): bigint {
  let sum = 0n;
  for (let i = 0; i < UNITS; i++) if (slots & (1 << i)) sum += quarterSlice(total, i);
  return sum;
}
export const unitCount = (slots: number) => [0, 1, 2, 3].filter(i => slots & (1 << i)).length;

/** One sample per event block and periodic idle block, with native Morpho pending fee accrual included.
 * Formula: https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol (previewRedeem).
 * Derived rows (token exposure, open requests, pockets) come from the store, so entity syncs run before this one.
 */
export async function syncEarnStrategy(config: EarnConfig, read: EarnReader, store: EarnSyncStore, block: bigint, asOf: bigint, token?: EarnAddress): Promise<EarnStrategy> {
  const v = (name: string, args: readonly unknown[] = []) => read(config.HybridVault, name, args, block);
  const r = (name: string, args: readonly unknown[] = []) => read(config.HybridReserve, name, args, block);
  // Earlier deployments used different category indices and a longer Params tuple that can still ABI-decode.
  if (big(await v("MANDATE_VERSION")) !== 2n) throw new Error("Unsupported Earn mandate version");
  const [core, coreRewards, registry, reserveAddress, usdg, rewardAddress, curator, grace, p, paused, feeBps, feeCompanion, feeAccrued, highWater, supply, virtual, previous] = await Promise.all([
    v("VAULT"), v("CORE_REWARDS"), v("REGISTRY"), v("RESERVE"), v("USDG"), v("REWARD_TOKEN"), v("CURATOR"), v("GRACE"), v("params") as Promise<RecordValues>, v("paused"), v("feeBps"), v("fees"), v("feeAccrued"), v("highWaterPrice"), v("totalSupply"), v("VIRTUAL_SHARES"), store.strategy(),
  ]);
  const [cash, shares, performing, overdue, lockedProfit, lockedNow, unlockStart, unlockEnd, unlockWindow, harvested, assigned, pendingShares, claimableTotal, accRewardPerShare, rewardRemainder, full, total] = await Promise.all([
    v("cash"), v("reserveShares"), v("performingPrincipal"), v("overduePrincipal"), v("lockedProfit"), v("lockedProfitNow"), v("unlockStart"), v("unlockEnd"), v("PROFIT_UNLOCK"), v("harvestedCash"), v("assignedCash"), v("pendingShares"), v("claimableTotal"), v("accRewardPerShare"), v("rewardRemainder"), v("fullAssets"), v("totalAssets"),
  ]);
  const [reserveAsset, reserveSymbol, reserveDecimals, reserveSupply, reserveVirtual, accrued, decimals] = await Promise.all([
    r("asset"), r("symbol"), r("decimals"), r("totalSupply"), r("virtualShares"), r("accrueInterestView") as Promise<readonly bigint[]>, read(config.USDG, "decimals", [], block),
  ]);
  if (lower(String(p.core)) !== config.EarnCore || lower(String(core)) !== config.EarnCore || lower(String(p.reserve)) !== config.HybridReserve || lower(String(reserveAddress)) !== config.HybridReserve || lower(String(usdg)) !== config.USDG) throw new Error("Earn deployment identity mismatch");
  const [coreRegistry, coreLedger] = await Promise.all([read(config.EarnCore, "REGISTRY", [], block), read(config.EarnCore, "REWARDS", [], block)]);
  if (lower(String(coreRegistry)) !== lower(String(registry)) || lower(String(coreLedger)) !== lower(String(coreRewards))) throw new Error("Earn core wiring mismatch");
  if (lower(String(reserveAsset)) !== config.USDG || ZERO.test(String(rewardAddress))) throw new Error("Earn reward or reserve identity mismatch");
  const rewardTokenAddress = lower(String(rewardAddress));
  if (config.RewardToken && config.RewardToken !== rewardTokenAddress) throw new Error("Earn reward token identity mismatch");
  const registryAddress = lower(String(registry));
  // The fee companion splits claimed fees; before wiring, the strategy can charge no fee.
  const feesAddress = lower(String(feeCompanion));
  const wired = !ZERO.test(feesAddress);
  const [feeOwner, feeRecipient, protocolShareBps, protocolRecipient, curatorAccrued, protocolAccrued] = wired
    ? await Promise.all([read(feesAddress, "STRATEGY", [], block), read(feesAddress, "curatorRecipient", [], block), read(feesAddress, "PROTOCOL_SHARE_BPS", [], block), read(feesAddress, "PROTOCOL_RECIPIENT", [], block), read(feesAddress, "curatorAccrued", [], block), read(feesAddress, "protocolAccrued", [], block)])
    : [config.HybridVault, "0x0000000000000000000000000000000000000000", 0, "0x0000000000000000000000000000000000000000", 0n, 0n];
  if (lower(String(feeOwner)) !== config.HybridVault) throw new Error("Earn fee companion identity mismatch");
  const [rewardSymbol, rewardDecimals] = await Promise.all([read(rewardTokenAddress, "symbol", [], block), read(rewardTokenAddress, "decimals", [], block)]);
  const reserveRate = reserveRatio(accrued[0]!, big(reserveSupply) + accrued[1]! + accrued[2]!, big(reserveVirtual));
  const reserveAssets = shareAssets(big(shares), reserveRate);
  if (reserveAssets !== big(await r("convertToAssets", [big(shares)]))) throw new Error("Earn reserve conversion mismatch");
  // One conversion sample about every hour, whatever the vault's own activity; the API reads the rate off this series.
  const latestSample = await store.latestReserveSample();
  if (!latestSample || asOf - latestSample.asOf >= RESERVE_SAMPLE_INTERVAL) await store.saveReserveSample({ block, asOf, assets: shareAssets(10n ** BigInt(uint(reserveDecimals)), reserveRate) });
  // Match HybridVault.freeLiquidity: zero/missing maxWithdraw means the reserve does not report a limit.
  let reserveLiquid = reserveAssets;
  try {
    const limit = big(await r("maxWithdraw", [config.HybridVault]));
    if (limit > 0n && limit < reserveLiquid) reserveLiquid = limit;
  } catch { /* The withdrawal itself still checks actual reserve liquidity. */ }
  // These views exclude effective impairment before the state-changing checkpoint updates stored principal.
  const fullAssets = big(full), totalAssets = big(total);
  const effectivePerforming = fullAssets - big(cash) - reserveAssets;
  if (effectivePerforming < 0n || effectivePerforming > big(performing)
      || totalAssets !== (fullAssets > big(lockedNow) ? fullAssets - big(lockedNow) : 0n)) throw new Error("Earn asset accounting mismatch");
  const effectiveOverdue = big(overdue) + big(performing) - effectivePerforming;
  const ratio = shareRatio(totalAssets, big(supply), big(virtual));
  const price = shareAssets(ONE_SHARE, ratio), fullPrice = shareAssets(ONE_SHARE, shareRatio(fullAssets, big(supply), big(virtual)));
  const laneRows = await Promise.all(lanes.map(async (lane, index) => {
    const [weight, committed] = await Promise.all([v("laneWeightBps", [index]), v("lanePrincipal", [index])]);
    const cap = fullAssets * big(weight) / 10000n;
    return { lane, weightBps: uint(weight), principal: String(committed), cap: String(cap), headroom: String(cap > big(committed) ? cap - big(committed) : 0n) };
  }));
  // Keep de-admitted tokens in the ledger so already recovered collateral is never hidden.
  const tokens = new Set([...(previous?.tokens ?? []).map(row => row.token), ...await store.admittedTokens()]);
  if (token) tokens.add(lower(token));
  const candidateRows = await Promise.all([...tokens].map(async token => {
    const [ceiling, unit] = await Promise.all([v("tokenCeiling", [token]), v("tokenUnit", [token])]);
    // setTokenCeiling(token, 0) can mention a never-admitted address, including an EOA.
    if (big(unit) === 0n) return undefined;
    const [erc20, symbol, decimals] = await Promise.all([read(registryAddress, "getERC20Config", [token], block) as Promise<RecordValues>, read(token, "symbol", [], block), read(token, "decimals", [], block)]);
    const lane = registryEarnLane(erc20.lane);
    // ERC-8056 uses 18 decimals. Only stock display amounts use it; never cache a mutable split multiplier.
    let uiMultiplier = "1000000000000000000";
    if (uint(erc20.lane) === 0) {
      try { uiMultiplier = String(await read(token, "uiMultiplier", [], block)); } catch { /* Ordinary ERC20 stock fixture. */ }
    }
    return { token, ceiling: String(ceiling), unit: String(unit), lane, symbol: String(symbol), decimals: uint(decimals), allowed: Boolean(erc20.allowed), uiMultiplier } satisfies EarnToken;
  }));
  // Outstanding position principal per token, one row per open loan (written-down loans stay open until settled).
  const outstanding = new Map<string, bigint>();
  for (const row of await store.loans()) if (!row.settled) outstanding.set(row.token, (outstanding.get(row.token) ?? 0n) + big(row.positionPrincipal));
  const tokenRows = candidateRows.filter((value): value is EarnToken => value !== undefined).map(row => ({ ...row, principal: String(outstanding.get(row.token) ?? 0n) }));
  const openRequests = await store.openRequestCount();
  const value: EarnStrategy = {
    ...snapshot(config, block, asOf), id: config.id ?? "gage-mix", title: config.title ?? "Gage USDG Mix", address: config.HybridVault, core: config.EarnCore, coreRewards: lower(String(coreRewards)), registry: registryAddress, reserveAsset: config.USDG, reserveSymbol: String(reserveSymbol), rewardToken: { address: rewardTokenAddress, symbol: String(rewardSymbol), decimals: uint(rewardDecimals) }, reserve: config.HybridReserve, curator: lower(String(curator)), usdg: config.USDG,
    usdgDecimals: uint(decimals), reserveDecimals: uint(reserveDecimals), shareDecimals: 18, paused: Boolean(paused), feeBps: uint(feeBps), fees: feesAddress, feeRecipient: lower(String(feeRecipient)), protocolShareBps: uint(protocolShareBps), protocolRecipient: lower(String(protocolRecipient)), feeAccrued: String(feeAccrued), curatorAccrued: String(curatorAccrued), protocolAccrued: String(protocolAccrued),
    highWaterPrice: String(highWater), mandate: { minDeposit: String(p.minDeposit), maxTotalDeposits: String(p.maxTotalDeposits), maxLoanTerm: uint(p.maxLoanTerm), minReturnBps: uint(p.minReturnBps), maxGageExposureBps: uint(p.maxGageExposureBps) }, grace: uint(grace),
    lanes: laneRows, tokens: tokenRows,
    shares: { totalSupply: String(supply), virtualShares: String(virtual), price: String(price), fullPrice: String(fullPrice) },
    totals: { cash: String(cash), reserveShares: String(shares), reserveAssets: String(reserveAssets), performingPrincipal: String(effectivePerforming), overduePrincipal: String(effectiveOverdue), fullAssets: String(fullAssets), totalAssets: String(totalAssets), lockedProfit: String(lockedProfit),
      unlockStart: uint(unlockStart), unlockEnd: uint(unlockEnd), profitUnlockSeconds: uint(unlockWindow), freeLiquidity: String(big(cash) + reserveLiquid), pendingShares: String(pendingShares), pendingRequestAssets: String(shareAssets(big(pendingShares), ratio)), openRequests,
      claimableTotal: String(claimableTotal), harvestedCash: String(harvested), assignedCash: String(assigned), accRewardPerShare: String(accRewardPerShare), rewardRemainder: String(rewardRemainder) },
    // The API joins the indexed pocket table. Serializing the entire history here would make every
    // publication grow forever even when no collateral changed.
    pockets: [],
  };
  await store.saveStrategy(value, ratio);
  return value;
}

/** The USDG flow an event moves for its account: deposits in, redemptions and claims out; everything else is internal. */
export function earnFlowOf(name: string, args: Record<string, unknown>, usdg?: EarnAddress): bigint {
  if (name === "Deposited") return big(args.assets);
  if (name === "Withdrawn" || name === "Claimed") return -big(args.assets);
  if (name === "PocketClaimed" && usdg && typeof args.token === "string" && lower(args.token) === usdg) return -big(args.amount);
  return 0n;
}

/** Performance includes shares, served USDG and unclaimed USDG recovery pockets; non-USDG collateral stays unpriced. */
export async function syncEarnAccount(config: EarnConfig, read: EarnReader, store: EarnSyncStore, owner: EarnAddress, block: bigint, asOf: bigint, flow = 0n) {
  const account = lower(owner), address = config.HybridVault;
  const v = (name: string, args: readonly unknown[] = []) => read(address, name, args, block);
  const [balance, locked, claimable, rewards, rewardState, withdrawable, previous] = await Promise.all([
    v("balanceOf", [account]), v("lockedShares", [account]), v("claimable", [account]), v("rewardClaimable", [account]), v("rewardState", [account]) as Promise<readonly bigint[]>, v("maxWithdraw", [account]), store.account(account),
  ]);
  const value = big(await v("convertToAssets", [big(balance)]));
  // Scalar samples and flows stay constant-size. USDG pocket entitlements are joined from the
  // event-position ledger when an account is requested, including pockets created after a holder exits.
  const sample = { block, asOf: Number(asOf), value: value + big(claimable), flow };
  const performanceCheckpoint = checkpointPerformance(previous?._earnCheckpoint?.performance, sample);
  await store.saveHistory(account, { ...sample, flow: BigInt(performanceCheckpoint.last.flow) });
  const performance = performanceFromCheckpoint(performanceCheckpoint);
  const result: EarnAccountRecord = { ...snapshot(config, block, asOf), account, shares: String(balance), lockedShares: String(locked), freeShares: String(big(balance) - big(locked)), value: String(value), withdrawable: String(withdrawable), claimable: String(claimable), rewards: String(rewards),
    requests: [], pockets: [],
    collateralReceived: [], performance, _earnCheckpoint: { rewardOwed: String(rewardState[0]), rewardIndex: String(rewardState[1]), performance: performanceCheckpoint } };
  await store.saveAccount(result);
  return result;
}

export const EARN_ACCOUNT_REFRESH_BATCH = 32;
/** Refresh one bounded page without RPC or history/pocket-table scans. Persist the cursor in Ponder's
 * reorg-aware store; API reads use the same projection for accounts awaiting their next page. */
export async function syncEarnAccounts(_config: EarnConfig, _read: EarnReader, store: EarnSyncStore, _block: bigint, _asOf: bigint) {
  const cursor = await store.accountCursor();
  const rows = await store.accountPage(cursor.after, EARN_ACCOUNT_REFRESH_BATCH);
  let remaining = EARN_ACCOUNT_REFRESH_BATCH, completed = 0;
  for (const account of rows) {
    const after = cursor.active === account.account ? cursor.pocketAfter : await store.accountPocketCursor(account.account);
    const pockets = await store.pocketPage(after, remaining);
    for (const pocket of pockets) await store.accountPocket(account.account, pocket);
    if (pockets.length) await store.saveAccountPocketCursor(account.account, pockets.at(-1)!.id);
    remaining -= pockets.length;
    if (remaining === 0) {
      await store.saveAccountCursor({ after: cursor.after, active: account.account, pocketAfter: pockets.at(-1)!.id });
      return { accounts: completed, pockets: EARN_ACCOUNT_REFRESH_BATCH };
    }
    completed++;
    cursor.after = account.account;
    cursor.active = undefined;
    cursor.pocketAfter = undefined;
  }
  await store.saveAccountCursor(rows.length === EARN_ACCOUNT_REFRESH_BATCH ? { after: cursor.after } : {});
  return { accounts: completed, pockets: EARN_ACCOUNT_REFRESH_BATCH - remaining };
}

/** Reconcile live positions even when the core changed without emitting a strategy event. */
export async function syncEarnLoans(config: EarnConfig, read: EarnReader, store: EarnSyncStore, block: bigint, asOf: bigint) {
  for (const loan of await store.loans()) if (!loan.settled) await syncEarnLoan(config, read, store, BigInt(loan.dealId), block, asOf);
}

/** An external lender can activate a strategy's partial position. Read the complete core record,
 * including its activation clock, rather than merging only a state label into a funding-era row.
 */
export async function syncEarnCoreLoan(config: EarnConfig, read: EarnReader, store: EarnSyncStore, engine: EarnAddress, id: bigint, block: bigint, asOf: bigint) {
  if (lower(engine) !== config.EarnCore) return undefined;
  const tracked = await store.loan(String(id));
  if (!tracked || tracked.settled) return undefined;
  const [slots, core] = await Promise.all([read(engine, "lenders", [id], block) as Promise<readonly string[]>, read(engine, "getLoan", [id], block) as Promise<RecordValues>]);
  // Cancellation releases lender slots; otherwise the selected engine must still hold this position for the vault.
  if (uint(core.state) !== 5 && !slots.some(slot => lower(slot) === config.HybridVault)) return undefined;
  return syncEarnLoan(config, read, store, id, block, asOf);
}

/** A request row keeps what the queue served; the chain holds only the shares still waiting. */
export async function syncEarnRequest(config: EarnConfig, read: EarnReader, store: EarnSyncStore, id: bigint, block: bigint, asOf: bigint, update: EarnRequestUpdate = {}): Promise<EarnRequest> {
  const [raw, prior] = await Promise.all([read(config.HybridVault, "requests", [id], block), store.request(String(id))]);
  const account = lower(String(field(raw, 0, "owner"))), remaining = big(field(raw, 1, "shares"));
  const servedShares = BigInt(prior?.servedShares ?? 0n) + (update.served?.shares ?? 0n), servedAssets = BigInt(prior?.servedAssets ?? 0n) + (update.served?.assets ?? 0n);
  const cancelled = update.cancelled || prior?.status === "cancelled";
  const status: EarnRequest["status"] = remaining > 0n ? (servedShares > 0n ? "partial" : "pending") : cancelled ? "cancelled" : "served";
  const value: EarnRequest = { ...snapshot(config, block, asOf), id: String(id), account, shares: String(remaining), servedShares: String(servedShares), servedAssets: String(servedAssets), status, position: prior?.position ?? 0, requestedAt: prior?.requestedAt ?? Number(asOf) };
  await store.saveRequest(value);
  return value;
}

export async function syncEarnPocket(config: EarnConfig, read: EarnReader, store: EarnSyncStore, id: bigint, block: bigint, asOf: bigint): Promise<EarnPocket> {
  const [raw, prior] = await Promise.all([read(config.HybridVault, "pockets", [id], block), store.pocket(String(id))]);
  const supply = big(field(raw, 3, "supply"));
  if (supply === 0n) throw new Error("Earn pocket missing");
  const token = lower(String(field(raw, 1, "token")));
  let metadata: EarnPocket["metadata"];
  if (ZERO.test(token)) metadata = { symbol: "ETH", decimals: 18, uiMultiplier: "1000000000000000000" };
  else {
    try {
      const [symbol, decimals] = await Promise.all([read(token, "symbol", [], block), read(token, "decimals", [], block)]);
      const precision = uint(decimals);
      if (typeof symbol === "string" && symbol.length > 0 && symbol.length <= 64 && Number.isInteger(precision) && precision >= 0 && precision <= 36) {
        let uiMultiplier = "1000000000000000000";
        try {
          const multiplier = big(await read(token, "uiMultiplier", [], block));
          if (multiplier > 0n) uiMultiplier = String(multiplier);
        } catch { /* Optional ERC-8056 display metadata. */ }
        metadata = { symbol, decimals: precision, uiMultiplier };
      }
    } catch { /* Recovery claims remain available when a token does not expose display metadata. */ }
  }
  const value: EarnPocketRecord = { ...prior, ...snapshot(config, block, asOf), id: String(id), dealId: String(field(raw, 0, "dealId")), token, amount: String(field(raw, 2, "amount")), supply: String(supply), claimed: String(field(raw, 4, "claimed")), openedAt: prior?.openedAt ?? Number(asOf), metadata };
  await store.savePocket(value);
  return value;
}

export async function syncEarnApproval(config: EarnConfig, read: EarnReader, store: EarnSyncStore, id: bigint, block: bigint, asOf: bigint, revoked = false) {
  const [approval, loan, funded, epoch, registry] = await Promise.all([read(config.HybridVault, "approvals", [id], block) as Promise<readonly bigint[]>, read(config.EarnCore, "getLoan", [id], block) as Promise<RecordValues>, read(config.HybridVault, "funded", [id], block), read(config.HybridVault, "approvalEpoch", [], block), read(config.HybridVault, "REGISTRY", [], block)]);
  const token = lower(String(loan.token));
  const kind = collateralKind(loan.kind);
  const lane = kind === "ERC20" ? registryEarnLane((await read(lower(String(registry)), "getERC20Config", [token], block) as RecordValues).lane) : "LP";
  const prior = await store.approval(String(id));
  const units = uint(approval[3] ?? 0) || prior?.units || 0;
  // The approved amount is the most `units` quarters can cost; a funded row keeps the exact principal it recorded.
  const fallback = units ? BigInt(units) * ((big(loan.principal) + 3n) / 4n) : 0n;
  await store.saveApproval({ ...snapshot(config, block, asOf), dealId: String(id), token, lane, kind, principal: String(approval[1] || prior?.principal || fallback), units, validUntil: Number(approval[0] || prior?.validUntil || 0), funded: Boolean(funded), revoked: revoked || (!funded && (approval[0] === 0n || approval[2] !== big(epoch))) });
}

/** One row per loan. Chain views give position, flags and the core record; payout, profit, fee and pocket come from events. */
export async function syncEarnLoan(config: EarnConfig, read: EarnReader, store: EarnSyncStore, id: bigint, block: bigint, asOf: bigint, update: EarnLoanUpdate = {}): Promise<EarnLoan | undefined> {
  const v = (name: string, args: readonly unknown[] = []) => read(config.HybridVault, name, args, block);
  const [loan, funded, terminal, written, feeBps, grace, slots, positionPrincipal, withdrawn, fundedLane, ledger, prior] = await Promise.all([
    read(config.EarnCore, "getLoan", [id], block) as Promise<RecordValues>, v("funded", [id]), v("terminal", [id]), v("overdue", [id]), v("loanFeeBps", [id]), v("GRACE"), v("loanSlots", [id]), v("positionPrincipal", [id]), v("withdrawn", [id]), v("loanLane", [id]), v("CORE_REWARDS"), store.loan(String(id)),
  ]);
  if (!funded) return undefined;
  // The core ledger's lender allocation: the strategy's quarters earn their slices of `lenderTotal` over the term, zero until activation.
  const allocation = await read(lower(String(ledger)), "allocation", [id], block) as RecordValues | undefined;
  const token = lower(String(loan.token)), fundedAt = uint(loan.fundedAt), term = uint(loan.term);
  const expiry = fundedAt ? fundedAt + term : 0, claimableAt = fundedAt ? expiry + uint(grace) : 0;
  const coreState = CORE_STATES[uint(loan.state)];
  if (!coreState || coreState === "NONE") throw new Error("Invalid Earn core state");
  const mask = uint(slots), owned = big(positionPrincipal), released = Boolean(withdrawn), settled = Boolean(terminal), overdue = Boolean(written);
  const rewardTotal = sliceSum(big(allocation?.lenderTotal ?? 0n), mask);
  const impaired = overdue || coreState === "DEFAULTED" || (coreState === "ACTIVE" && Number(asOf) >= expiry)
    || (coreState === "REPAID" && fundedAt > 0 && uint(loan.closedAt) >= expiry);
  const outcome = settled ? released || coreState === "CANCELLED" ? "refund" : coreState === "DEFAULTED" ? "collateral" : "cash" : null;
  const lane = lanes[uint(fundedLane)], kind = collateralKind(loan.kind);
  if (!lane) throw new Error("Invalid Earn loan lane");
  const pocketIds = [...new Set([...(prior?.pocketIds ?? (prior?.pocketId ? [prior.pocketId] : [])), ...(update.pocketId === undefined ? [] : [String(update.pocketId)])])];
  const value: EarnLoan = { ...snapshot(config, block, asOf), id: String(id), dealId: String(id), borrower: lower(String(loan.originator)), token, lane, kind, principal: String(loan.principal), cap: String(loan.cap), collateralAmount: String(loan.collateral),
    positionPrincipal: String(owned), units: unitCount(mask), slots: mask, withdrawn: released, overdue, carried: String(settled || impaired ? 0n : owned),
    state: earnLoanStateAt({ settled, outcome, coreState, withdrawn: released, fundingDeadline: uint(loan.fundingDeadline), expiry, claimableAt }, Number(asOf)),
    coreState, fundingDeadline: uint(loan.fundingDeadline), fundedAt, expiry, claimableAt, settled, outcome,
    payout: String(update.payout ?? BigInt(prior?.payout ?? 0n)), profit: String(BigInt(prior?.profit ?? 0n) + (update.profit ?? 0n)), fee: String(BigInt(prior?.fee ?? 0n) + (update.fee ?? 0n)), feeBps: uint(feeBps),
    pocketId: pocketIds[0] ?? null, pocketIds, rewards: String(BigInt(prior?.rewards ?? 0n) + (update.rewards ?? 0n)), term, rewardTotal: String(rewardTotal) };
  await store.saveLoan(value);
  return value;
}

/** A recovered LP position produces distinct notices for its currencies, including native ETH. */
export function earnSettlementNotices(loan: EarnLoan, pockets: EarnPocket[], usdg: EarnAddress, event: { id: string; transactionHash: string }): EarnNotice[] {
  if (!loan.outcome) return [];
  const base = { chainId: loan.chainId, strategy: loan.strategy, blockNumber: loan.blockNumber, asOf: loan.asOf, account: loan.strategy, dealId: loan.dealId, transactionHash: event.transactionHash };
  if (loan.outcome === "collateral") return pockets.filter(pocket => pocket.dealId === loan.dealId && loan.pocketIds.includes(pocket.id)).map(pocket => ({ ...base, id: `${event.id}:${pocket.id}`, kind: "collateral", token: pocket.token, amount: pocket.amount }));
  return [{ ...base, id: event.id, kind: loan.outcome === "cash" ? "repayment" : "refund", token: usdg, amount: loan.payout }];
}

/** Shared state rule for indexer rows and API stamping. A closed funding window is settling: anyone may release it. */
export function earnLoanStateAt(loan: Pick<EarnLoan, "settled" | "outcome" | "coreState" | "withdrawn" | "fundingDeadline" | "expiry" | "claimableAt">, at: number): EarnLoan["state"] {
  if (loan.settled) return loan.outcome === "collateral" ? "Collateral" : loan.outcome === "refund" ? "Refunded" : "Repaid";
  if (loan.withdrawn || loan.coreState === "CANCELLED" || loan.coreState === "REPAID" || loan.coreState === "DEFAULTED") return "Settling";
  if (loan.coreState === "FUNDING") return at >= loan.fundingDeadline ? "Settling" : "Funding";
  if (at >= loan.claimableAt) return "Claimable";
  return at >= loan.expiry ? "Overdue" : "Active";
}
