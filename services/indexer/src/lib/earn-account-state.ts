import type { EarnAccount, EarnPocket, EarnStrategy } from "../../../../shared/earn";
import { checkpointPerformance, earnPerformance, performanceFromCheckpoint, shareAssets, type EarnPerformanceCheckpoint, type EarnValueSample } from "./earn-accounting";

/** Indexer-only checkpoint fields are stripped from HTTP responses. */
export type EarnAccountRecord = EarnAccount & { _earnCheckpoint?: { rewardIndex: string; rewardOwed: string; performance: EarnPerformanceCheckpoint } };
export type EarnPocketRecord = EarnPocket & { snapshotPosition?: string; createdPosition?: string };
export type EarnShareChange = { position: bigint; balance: bigint };
export type EarnPocketClaim = { pocketId: string; position: bigint };
export const earnEventPosition = (block: bigint, logIndex: number) => block * (1n << 32n) + BigInt(logIndex);
export function sharesAt(changes: EarnShareChange[], position: bigint) {
  let lo = 0, hi = changes.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (changes[mid]!.position <= position) lo = mid + 1; else hi = mid; }
  return lo === 0 ? 0n : changes[lo - 1]!.balance;
}
type StrategyValue = { snapshot: EarnStrategy; shareAssetsNumerator: string; shareAssetsDenominator: string };
const REWARD_PRECISION = 10n ** 18n;

/** An account's own events refresh its shares, claims and existing pocket rights. Between those events,
 * only global NAV/reward indices and newly opened pockets can change its entitlement. No historical RPC
 * reads or account-history scan is necessary to project those changes at the publication block. */
export function projectEarnAccount(record: EarnAccountRecord, current: StrategyValue): EarnAccountRecord {
  const strategy = current.snapshot, checkpoint = record._earnCheckpoint;
  const changed = record.blockNumber !== strategy.blockNumber || record.asOf !== strategy.asOf;
  if (changed && !checkpoint) throw new Error("Earn account checkpoint unavailable");
  if (BigInt(record.blockNumber) > BigInt(strategy.blockNumber)) throw new Error("Earn account is newer than publication");
  const ratio = { numerator: BigInt(current.shareAssetsNumerator), denominator: BigInt(current.shareAssetsDenominator) };
  if (ratio.denominator <= 0n) throw new Error("Invalid Earn account conversion");
  const shares = BigInt(record.shares), value = shareAssets(shares, ratio), free = shareAssets(BigInt(record.freeShares), ratio), liquid = BigInt(strategy.totals.freeLiquidity);
  const pockets = record.pockets;
  const recoverableUSDG = pockets.reduce((sum, pocket) => sum + (pocket.token === strategy.usdg ? BigInt(pocket.claimable) : 0n), 0n);
  const rewardIndex = BigInt(strategy.totals.accRewardPerShare);
  if (checkpoint && rewardIndex < BigInt(checkpoint.rewardIndex)) throw new Error("Earn reward index moved backwards");
  const rewards = checkpoint ? BigInt(checkpoint.rewardOwed) + shares * (rewardIndex - BigInt(checkpoint.rewardIndex)) / REWARD_PRECISION : BigInt(record.rewards);
  const performance = checkpoint ? checkpointPerformance(checkpoint.performance, { block: BigInt(strategy.blockNumber), asOf: strategy.asOf, value: value + BigInt(record.claimable) + recoverableUSDG, flow: 0n }) : undefined;
  return { ...record, blockNumber: strategy.blockNumber, asOf: strategy.asOf, value: String(value), withdrawable: String(free < liquid ? free : liquid), rewards: String(rewards), pockets,
    requests: record.requests.map(request => ({ ...request, blockNumber: strategy.blockNumber, asOf: strategy.asOf })),
    ...(performance ? { performance: performanceFromCheckpoint(performance), _earnCheckpoint: { ...checkpoint!, performance } } : {}),
  };
}

/** Materialize the requested account only, from indexed event positions. This work belongs to the HTTP
 * response (which already returns every pocket), never to the periodic publication transaction. */
export function materializeEarnAccount(record: EarnAccountRecord, current: StrategyValue, pockets: EarnPocketRecord[], changes: EarnShareChange[], claims: EarnPocketClaim[], history: (EarnValueSample & { block: bigint })[], cachedBalances = new Map<string, bigint>()): EarnAccountRecord {
  const end = earnEventPosition(BigInt(current.snapshot.blockNumber) + 1n, 0) - 1n;
  const claimPositions = new Map(claims.map(claim => [claim.pocketId, claim.position]));
  const parts = pockets.filter(pocket => !pocket.createdPosition || BigInt(pocket.createdPosition) <= end).map(pocket => {
    if (pocket.snapshotPosition === undefined) throw new Error("Earn pocket ownership position unavailable");
    const balanceAt = cachedBalances.get(pocket.id) ?? sharesAt(changes, BigInt(pocket.snapshotPosition));
    const part = BigInt(pocket.supply) === 0n ? 0n : BigInt(pocket.amount) * balanceAt / BigInt(pocket.supply);
    const claimPosition = claimPositions.get(pocket.id), claimed = claimPosition !== undefined && claimPosition <= end;
    return { pocket, part, claimPosition, entitlement: { pocketId: pocket.id, dealId: pocket.dealId, token: pocket.token, balanceAt: String(balanceAt), claimed, claimable: String(claimed ? 0n : part) } };
  });
  const received = new Map<string, bigint>();
  for (const { pocket, part, entitlement } of parts) if (entitlement.claimed) received.set(pocket.token, (received.get(pocket.token) ?? 0n) + part);
  const projected = projectEarnAccount({ ...record, pockets: parts.map(part => part.entitlement), collateralReceived: [...received].map(([token, amount]) => ({ token: token as EarnPocket["token"], amount: String(amount) })) }, current);
  const currentBlock = BigInt(current.snapshot.blockNumber);
  const rows = history.filter(row => row.block <= currentBlock && row.block !== currentBlock);
  rows.push({ block: currentBlock, asOf: current.snapshot.asOf, value: BigInt(projected.value) + BigInt(projected.claimable), flow: history.find(row => row.block === currentBlock)?.flow ?? 0n });
  rows.sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : 0);
  const recoveryEvents = parts.flatMap(part => part.pocket.token !== current.snapshot.usdg ? [] : [
    { position: BigInt(part.pocket.createdPosition ?? 0), change: part.part },
    ...(part.claimPosition === undefined ? [] : [{ position: part.claimPosition, change: -part.part }]),
  ]).sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
  let recovery = 0n, eventIndex = 0;
  const performance = earnPerformance(rows.map(row => {
    const at = earnEventPosition(row.block + 1n, 0) - 1n;
    while (eventIndex < recoveryEvents.length && recoveryEvents[eventIndex]!.position <= at) recovery += recoveryEvents[eventIndex++]!.change;
    return { ...row, value: row.value + recovery };
  }));
  return { ...projected, performance: { valueUSDG: String(performance.value), depositsUSDG: String(performance.deposits), withdrawalsUSDG: String(performance.withdrawals), profitUSDG: String(performance.profit), twrBps: performance.twrBps, sinceAt: performance.sinceAt, samples: performance.samples } };
}

export function publicEarnAccount(record: EarnAccountRecord): EarnAccount {
  const { _earnCheckpoint, ...account } = record;
  void _earnCheckpoint;
  return account;
}
