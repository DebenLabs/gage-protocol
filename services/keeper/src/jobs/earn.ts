import type { Abi, Address } from "viem";
import type { EarnAddress, EarnKeeperAlert, EarnKeeperHealth, EarnLoan } from "../../../../shared/earn.js";
import { earnAbi, earnCoreAbi, earnReadAbi } from "../earn-abi.js";
import { fetchEarnInput, type EarnInput } from "../earn-indexer.js";
import { safeErrorCode } from "../errors.js";
import type { JobContext } from "../context.js";
import { earnStrategiesOf, type EarnStrategyRef } from "../deployment.js";
import type { Call } from "../sender.js";
import { earnBucket, type EarnStrategyState } from "../state.js";
export type { EarnInput } from "../earn-indexer.js";
export interface EarnDependencies {
  /** Chain clock for deterministic local replays; operational health/retries use ctx.now. */
  chainNow?(): number;
  snapshot(): Promise<EarnInput>;
  read(address: Address, name: string, args?: readonly unknown[]): Promise<unknown>;
  readLatest?(address: Address, name: string, args?: readonly unknown[]): Promise<unknown>;
}
const readAbi: Abi = earnReadAbi;
const MAX_BATCH = 32;
const amount = (v: unknown) => BigInt(v as string | number | bigint);
const lower = (v: string) => v.toLowerCase() as EarnAddress;
const seconds = (ctx: JobContext) => Math.floor(ctx.now() / 1000);
const batches = <T>(items: T[]): T[][] => Array.from({ length: Math.ceil(items.length / MAX_BATCH) }, (_, n) => items.slice(n * MAX_BATCH, (n + 1) * MAX_BATCH));
const ZERO = "0x0000000000000000000000000000000000000000" as EarnAddress;
/** Failure key of a strategy tick that threw (indexer, RPC or identity); cleared by the next complete tick. */
const TICK = "tick";
const strategies = (ctx: JobContext) => earnStrategiesOf(ctx.deployment());
const state = (ctx: JobContext, address: EarnAddress) => earnBucket(ctx.state, address, strategies(ctx)[0]?.vault ?? address);
function fail(ctx: JobContext, memory: EarnStrategyState, strategy: EarnAddress, key: string, code: EarnKeeperAlert["code"]): void {
  const current = memory.failures[key], at = seconds(ctx), attempts = (current?.attempts ?? 0) + 1;
  const firstAt = current?.firstAt ?? at;
  memory.failures[key] = { attempts, firstAt, retryAt: at + Math.min(600, ctx.config.earnRetryBaseSeconds * 2 ** Math.min(attempts - 1, 10)) };
  if (attempts >= ctx.config.earnAlertAttempts) {
    const id = `${strategy}:${key}:${firstAt}`;
    if (!memory.alerts.some(a => a.id === id)) memory.alerts.push({ id, code, action: key, strategy, at, attempts });
    ctx.log.warn("earn_repeated_failure", { strategy, action: key, attempts, code });
  }
}

/** The strategy at `address` (any case), or undefined when the deployment does not list it. */
export function findEarnStrategy(ctx: JobContext, address: string): EarnStrategyRef | undefined {
  return strategies(ctx).find(s => s.vault === address.toLowerCase());
}

/** Health of one strategy: the flagship (entry 0) by default; a lowercase address or ref otherwise. Throws for an unlisted address. */
export function earnHealth(ctx: JobContext, strategy?: EarnStrategyRef | string): EarnKeeperHealth {
  const d = ctx.deployment(), list = strategies(ctx), now = seconds(ctx);
  const ref = strategy === undefined ? list[0] : typeof strategy === "string" ? findEarnStrategy(ctx, strategy) : strategy;
  if (strategy !== undefined && !ref) throw Error("Unknown Earn strategy");
  const address = ref?.vault ?? lower(d.addresses.HybridVault ?? ZERO), s = state(ctx, address);
  const enabled = ctx.config.earnEnabled && ref !== undefined;
  const pendingTransaction = ctx.sender.pendingTransaction?.() ?? null;
  const transactionBlocked = pendingTransaction !== null && !ctx.sender.isConfirmingTransaction?.();
  return { ok: enabled && s.lastTickAt !== null && now - s.lastTickAt <= ctx.config.earnMaxAgeSeconds && !transactionBlocked && !Object.values(s.failures).some(f => f.attempts >= ctx.config.earnAlertAttempts),
    chainId: d.chainId, strategy: address, mode: !enabled ? "disabled" : ctx.config.dryRun ? "dry-run" : "execute", lastTickAt: s.lastTickAt,
    staleAfterSeconds: ctx.config.earnMaxAgeSeconds, pendingTransaction,
    failures: Object.entries(s.failures).map(([action, f]) => ({ action, attempts: f.attempts, retryAt: f.retryAt })), alerts: s.alerts };
}

/** Health of every listed strategy, in manifest order. */
export function earnStrategyHealths(ctx: JobContext): EarnKeeperHealth[] {
  return strategies(ctx).map(ref => earnHealth(ctx, ref));
}

/** `/health/earn[?strategy=<address>]`: the flagship without the query, 404 for an address the deployment does not list. */
export function earnHealthResponse(ctx: JobContext, url: string): { status: number; body: EarnKeeperHealth | { ok: false; error: string; strategy: string } } {
  const query = new URL(url, "http://keeper").searchParams.get("strategy");
  const ref = query === null ? undefined : findEarnStrategy(ctx, query);
  if (query !== null && !ref) return { status: 404, body: { ok: false, error: "unknown_strategy", strategy: query } };
  const health = earnHealth(ctx, ref);
  return { status: health.ok ? 200 : 503, body: health };
}

/**
 * One serial Earn job preserves the mandated ordering per strategy and runs the strategies in manifest order; Sender
 * serializes it with every other keeper job. A strategy whose tick throws records the failure in its own bucket and
 * the next strategy still runs; the first error is rethrown once every strategy has had its turn. A wallet-level stop
 * (unresolved transaction, refused send) ends the whole run, as it would every remaining send.
 * With `provided` (tests, rehearsal) only the strategy its snapshot names runs, the flagship when it names none.
 */
export async function runEarn(ctx: JobContext, provided?: EarnDependencies): Promise<void> {
  const d = ctx.deployment(), list = strategies(ctx);
  if (!ctx.config.earnEnabled || list.length === 0) return;
  if (d.chainId !== ctx.config.chainId) throw Error("Earn deployment chain mismatch");
  // A confirmed transaction may no longer appear in the next snapshot's planned actions. Recover before
  // fetching or planning, so an idle strategy can clear its journal without submitting another transaction.
  if (ctx.sender.recoverPending && !await ctx.sender.recoverPending()) return;
  const given = provided ? await provided.snapshot() : undefined;
  const targets = given ? [findEarnStrategy(ctx, given.strategy.address) ?? list[0]!] : list;
  let first: Error | undefined;
  for (const ref of targets) {
    try {
      if (await tick(ctx, ref, provided, given ?? await fetchEarnInput(ctx.config.indexerUrl, ref.vault, d.chainId)) === "stop") break;
    } catch (error) {
      first ??= error instanceof Error ? error : new Error(String(error));
      fail(ctx, state(ctx, ref.vault), ref.vault, TICK, "keeper_revert");
      // Only fixed identifiers are public; indexer and RPC errors can carry private endpoint URLs.
      ctx.log.warn("earn_strategy_failed", { strategy: ref.vault, id: ref.id, error: safeErrorCode(error) });
    }
  }
  if (first !== undefined) throw first;
}

async function tick(ctx: JobContext, ref: EarnStrategyRef, provided: EarnDependencies | undefined, input: EarnInput): Promise<"done" | "stop"> {
  const d = ctx.deployment();
  const strategyAddress = ref.vault, reserve = ref.reserve, core = ref.core, memory = state(ctx, strategyAddress);
  const planningBlock = BigInt(input.strategy.blockNumber);
  const deps: EarnDependencies = provided ?? {
    snapshot: () => Promise.resolve(input),
    read: async (address, functionName, args = []) => {
      if (!ctx.publicClient) throw Error("Earn RPC unavailable");
      return ctx.publicClient.readContract({ address, abi: readAbi, functionName, args, blockNumber: planningBlock });
    },
    readLatest: async (address, functionName, args = []) => {
      if (!ctx.publicClient) throw Error("Earn RPC unavailable");
      return ctx.publicClient.readContract({ address, abi: readAbi, functionName, args });
    },
  };
  const chainNow = () => deps.chainNow?.() ?? seconds(ctx);
  const s = input.strategy, now = chainNow();
  if (s.chainId !== d.chainId || lower(s.address) !== strategyAddress || lower(s.strategy) !== strategyAddress || lower(s.reserve) !== reserve || lower(s.core) !== core) throw Error("Earn snapshot identity mismatch");
  if (s.asOf > now + 30 || now - s.asOf > ctx.config.earnMaxAgeSeconds) throw Error("Earn indexer snapshot stale");
  const coreRewards = s.coreRewards;
  const tolerance = BigInt(ctx.config.earnToleranceBps);
  const below = (preview: bigint) => preview * (10000n - tolerance) / 10000n;
  const above = (preview: bigint) => (preview * (10000n + tolerance) + 9999n) / 10000n;
  const read = (address: Address, name: string, args: readonly unknown[] = []) => deps.read(address, name, args);
  const failed = (key: string, code: EarnKeeperAlert["code"]) => fail(ctx, memory, strategyAddress, key, code);
  const planned = new Set<string>();
  const attempt = async (call: Call, key: string, code: EarnKeeperAlert["code"] = "keeper_revert") => {
    planned.add(key);
    if ((memory.failures[key]?.retryAt ?? 0) > seconds(ctx)) return "continue";
    const result = await ctx.sender.execute(call);
    if (result.status === "sent" || result.status === "dry" || result.status === "skipped") { delete memory.failures[key]; return result.status; }
    // A concurrent generic registration backstop has already completed the intended action.
    if (result.status === "reverted" && result.revert.name === "AlreadyRegistered") { delete memory.failures[key]; return "continue"; }
    failed(key, code);
    if (result.status === "refused" || (result.status === "failed" && ["pending-transaction-unresolved", "wallet-has-pending-transaction"].includes(result.error))) return "stop";
    return "continue";
  };
  const send = async (name: string, args: readonly unknown[], key: string, code?: EarnKeeperAlert["code"]) => attempt({ label: `Earn.${name}`, address: strategyAddress, abi: earnAbi, functionName: name, args }, key, code);
  const loans = [...new Map(input.loans.map(l => [l.dealId, l])).values()];

  // 0. A listing whose funding window closed can never activate; anyone may release it, which credits the core.
  for (const loan of loans.filter(l => !l.settled && !l.withdrawn && l.coreState === "FUNDING" && chainNow() >= l.fundingDeadline)) {
    const id = BigInt(loan.dealId);
    if (await attempt({ label: "Earn.cancelFunding", address: core, abi: earnCoreAbi, functionName: "cancelFunding", args: [id] }, `cancelFunding:${id}`) === "stop") return "stop";
  }

  // 1. Refunds, repayments and finalizable defaults settle first; the strategy harvests core cash inside `settle`.
  const resolved = (l: EarnLoan) => l.withdrawn || l.coreState === "REPAID" || l.coreState === "DEFAULTED" || l.coreState === "CANCELLED";
  const finalizable = (l: EarnLoan) => l.coreState === "ACTIVE" && l.claimableAt > 0 && chainNow() >= l.claimableAt;
  const settle = loans.filter(l => !l.settled && (resolved(l) || finalizable(l)));
  for (const group of batches(settle)) {
    const ids = group.map(l => BigInt(l.dealId));
    if (await send("settle", [ids], `settle:${ids.join(",")}`) === "stop") return "stop";
  }

  // 2. Loans past their term that have not repaid leave the share price at once; a finalizable loan settles instead.
  const overdue = loans.filter(l => !l.settled && !l.overdue && !l.withdrawn && l.coreState === "ACTIVE" && l.expiry > 0 && chainNow() >= l.expiry && !finalizable(l));
  for (const group of batches(overdue)) {
    const ids = group.map(l => BigInt(l.dealId));
    if (await send("markOverdue", [ids], `markOverdue:${ids.join(",")}`) === "stop") return "stop";
  }

  // 3. Pull core cash credit and released lender rewards; a caught USDG failure is still an observable failure.
  if (amount(await read(core, "cashCredit", [strategyAddress])) > 0n) {
    const key = "harvestCash", priorFailure = memory.failures[key], result = await send("harvestCash", [], key, "harvest_failed");
    if (result === "stop") return "stop";
    if (result === "sent" && amount(await (deps.readLatest ?? deps.read)(core, "cashCredit", [strategyAddress])) > 0n) {
      if (priorFailure) memory.failures[key] = priorFailure;
      failed(key, "harvest_failed");
    }
  }
  const rewardIds: bigint[] = [];
  for (const loan of loans) {
    if (loan.withdrawn || loan.coreState === "FUNDING" || loan.coreState === "CANCELLED") continue;
    const id = BigInt(loan.dealId);
    const claimable = amount(await read(coreRewards, "claimable", [id, strategyAddress]));
    if (claimable > 0n && claimable >= ctx.config.earnRewardMinRaw) rewardIds.push(id);
  }
  for (const ids of batches(rewardIds)) if (await send("harvestRewards", [ids], `harvestRewards:${ids.join(",")}`, "harvest_failed") === "stop") return "stop";

  // 4. Serve the redemption queue from cash and whatever the reserve can actually release right now.
  const cash = amount(s.totals.cash), reserveAssets = amount(s.totals.reserveAssets);
  if (amount(s.totals.pendingShares) > 0n && cash + reserveAssets > 0n) {
    let reserveLiquid = reserveAssets;
    try {
      const reported = amount(await read(reserve, "maxWithdraw", [strategyAddress]));
      // The supported Morpho reserve returns zero even when withdraw succeeds. Match HybridVault.freeLiquidity.
      if (reported > 0n) reserveLiquid = reported;
    } catch { /* A reserve without maxWithdraw is served on its converted value. */ }
    const maxAssets = cash + below(reserveLiquid < reserveAssets ? reserveLiquid : reserveAssets);
    // The contract counts visited rows, including cancelled requests, against this bounded budget.
    if (maxAssets > 0n && await send("serveRequests", [BigInt(MAX_BATCH), maxAssets], "serveRequests", "reserve_redemption_failed") === "stop") return "stop";
  }

  // 5. Approvals fund only from liquidity the queue does not already claim; check the clock again before each submission.
  // On-chain activity includes equality, but keeper submissions need time left for transaction inclusion.
  let available = amount(s.totals.freeLiquidity) - amount(s.totals.pendingRequestAssets);
  const fundable = [];
  for (const approval of input.approvals) {
    if (approval.funded || approval.revoked || approval.validUntil <= chainNow()) continue;
    const principal = amount(approval.principal);
    if (principal > available) continue;
    available -= principal;
    fundable.push(approval);
  }
  // 6. Idle cash the planned fundings do not need goes to the reserve; funding then draws on the reserve only for the rest.
  const reservedCash = fundable.reduce((n, approval) => n + amount(approval.principal), 0n);
  const idle = cash > reservedCash ? cash - reservedCash : 0n;
  if (!s.paused && idle >= ctx.config.earnInvestMinRaw) {
    const preview = amount(await read(reserve, "previewDeposit", [idle]));
    if (await send("investReserve", [idle, below(preview)], "investReserve", "harvest_failed") === "stop") return "stop";
  }
  if (!s.paused) for (const approval of fundable) {
    const maxReserveShares = above(amount(await read(reserve, "previewWithdraw", [amount(approval.principal)])));
    if (approval.validUntil <= chainNow()) continue;
    if (await send("fund", [BigInt(approval.dealId), maxReserveShares], `fund:${approval.dealId}`) === "stop") return "stop";
  }
  // Only a complete fresh tick proves an action obsolete. Paused phases have not been planned.
  // Keep incident history for delivery/deduplication while retiring resolved active failures.
  for (const key of Object.keys(memory.failures)) {
    if (s.paused && /^(investReserve$|fund:)/.test(key)) continue;
    if (/^(cancelFunding:|settle:|markOverdue:|harvestCash$|harvestRewards:|serveRequests$|investReserve$|fund:)/.test(key) && !planned.has(key)) delete memory.failures[key];
  }
  delete memory.failures[TICK];
  memory.lastTickAt = seconds(ctx);
  ctx.log.info("earn_tick", { strategy: strategyAddress, id: ref.id, block: s.blockNumber, requests: s.totals.openRequests, loans: loans.length, approvals: input.approvals.length, mode: ctx.config.dryRun ? "dry-run" : "execute" });
  return "done";
}
