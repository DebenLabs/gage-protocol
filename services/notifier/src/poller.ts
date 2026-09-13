/**
 * Polls the indexer every minute: reminders for the borrower of every FUNDED deal, the after-grace notice for
 * its lender, budget-exhausted and epoch-roll notices for opted-in wallets, and retries of failed sends. The
 * sent ledger in SQLite makes every notification go out once. The indexer being down is logged and tried again
 * next minute; nothing else stops.
 */
import type { Channels } from "./channels/types.js";
import type { NotifierConfig } from "./config.js";
import type { Db, Subscription } from "./db.js";
import type { Indexer, IndexedAsset, IndexedDeal, IndexedEpoch } from "./indexer.js";
import type { Logger } from "./log.js";
import type { WalletUSDG } from "./balances.js";
import { approvalNotice, claimableNotice, keeperNotice, listingNotice, outcomeNotices, type EarnMessage } from "./earn.js";
import type { EarnStrategy } from "../../../shared/earn.js";
import { renderBudgetExhausted, renderDealNotice, renderEpochRoll, type Rendered } from "./messages.js";
import { dueReminders, LENDER_KIND, lenderClaimDue, reminderKey } from "./schedule.js";

export interface PollStats {
  deals: number;
  sent: number;
  dry: number;
  skipped: number;
  failed: number;
  retried: number;
  indexerOk: boolean;
}

export interface PollerStatus {
  lastPollAt: number | undefined;
  lastOkAt: number | undefined;
  lastError: string | undefined;
  lastStats: PollStats | undefined;
}

export interface PollerDeps {
  db: Db;
  indexer: Indexer;
  channels: Channels;
  config: NotifierConfig;
  log: Logger;
  /** Optional: the borrower's USDG wallet balance for the T−24h line. */
  walletUSDG?: WalletUSDG | undefined;
  now?: () => number;
}

interface Item {
  key: string;
  kind: string;
  ref: string;
  sub: Subscription;
  message: Rendered;
}

export class Poller {
  readonly status: PollerStatus = { lastPollAt: undefined, lastOkAt: undefined, lastError: undefined, lastStats: undefined };
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private assets: { at: number; byToken: Map<string, IndexedAsset> } | undefined;
  private readonly now: () => number;
  /** A failed send is attempted at most once per poll, including when its source remains visible. */
  private readonly attempted = new Set<string>();

  constructor(private readonly d: PollerDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.d.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollOnce(): Promise<PollStats> {
    const stats: PollStats = { deals: 0, sent: 0, dry: 0, skipped: 0, failed: 0, retried: 0, indexerOk: true };
    if (this.running) return stats;
    this.running = true;
    this.attempted.clear();
    const now = this.now();
    this.status.lastPollAt = now;
    try {
      const subs = this.d.db.allSubscriptions();
      const bySub = new Map<string, Subscription[]>();
      for (const s of subs) {
        const list = bySub.get(s.wallet.toLowerCase()) ?? [];
        list.push(s);
        bySub.set(s.wallet.toLowerCase(), list);
      }
      // Retry persisted envelopes even when the indexer is down or an approval has since expired.
      await this.retryFailed(stats);
      let strategies: Set<string> | undefined;
      try {
        strategies = await this.earnNotices(bySub, now, stats);
      } catch (err) {
        stats.indexerOk = false;
        this.status.lastError = err instanceof Error ? err.message : String(err);
        this.d.log.warn("earn_poll_failed", { error: this.status.lastError });
      }
      if (strategies !== undefined) await this.retryFailed(stats, strategies);
      await this.reminders(bySub, now, stats, strategies);
      await this.rewardNotices(subs, now, stats);
      if (stats.indexerOk) {
        this.status.lastOkAt = now;
        this.status.lastError = undefined;
      }
    } catch (err) {
      stats.indexerOk = false;
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.d.log.warn("poll_failed", { error: this.status.lastError });
    } finally {
      this.running = false;
      this.status.lastStats = stats;
      this.d.log.info("poll_done", { ...stats });
    }
    return stats;
  }

  private async assetInfo(token: string): Promise<IndexedAsset | undefined> {
    const now = this.now();
    if (this.assets === undefined || now - this.assets.at > 600) {
      try {
        const list = await this.d.indexer.assets();
        this.assets = { at: now, byToken: new Map(list.map((a) => [a.token.toLowerCase(), a])) };
      } catch (err) {
        this.d.log.warn("assets_unavailable", { error: err instanceof Error ? err.message : String(err) });
        this.assets ??= { at: now, byToken: new Map() };
      }
    }
    return this.assets.byToken.get(token.toLowerCase());
  }

  private async reminders(bySub: Map<string, Subscription[]>, now: number, stats: PollStats, strategies: Set<string> | undefined): Promise<void> {
    const deals = await this.d.indexer.fundedDeals();
    stats.deals = deals.length;
    const base = { timezone: this.d.config.timezone, usdgDecimals: this.d.config.usdgDecimals, appUrl: this.d.config.appUrl };
    for (const deal of deals) {
      const ref = `deal:${deal.id}`;
      for (const sub of bySub.get(deal.borrower.toLowerCase()) ?? []) {
        const done = this.d.db.doneKinds(sub.wallet, sub.channel, ref);
        const due = dueReminders({ expiry: deal.expiry, now, prefs: sub.prefs, done });
        for (const kind of due.skip) {
          this.d.db.record({ key: reminderKey(kind, deal.id, sub.wallet, sub.channel), wallet: sub.wallet, channel: sub.channel, kind, ref, status: "skipped", error: null, sentAt: now });
          stats.skipped += 1;
        }
        if (due.send === undefined) continue;
        const walletUSDG = due.send === "t24" && this.d.walletUSDG !== undefined ? await this.d.walletUSDG(deal.borrower) : undefined;
        const message = renderDealNotice(due.send, deal, { ...base, asset: await this.assetInfo(deal.token), walletUSDG });
        await this.deliver({ key: reminderKey(due.send, deal.id, sub.wallet, sub.channel), kind: due.send, ref, sub, message }, stats, deal);
      }
      // Strategy contracts have no human channel. Their curator receives the Earn claimable notice.
      // If discovery is unavailable, keep borrower reminders running and defer lender notices safely.
      if (deal.lender === null || strategies === undefined || strategies.has(deal.lender.toLowerCase())) continue;
      for (const sub of bySub.get(deal.lender.toLowerCase()) ?? []) {
        const done = this.d.db.doneKinds(sub.wallet, sub.channel, ref);
        if (!lenderClaimDue({ graceEnd: deal.graceEnd, now, prefs: sub.prefs, done })) continue;
        const message = renderDealNotice(LENDER_KIND, deal, { ...base, asset: await this.assetInfo(deal.token) });
        await this.deliver({ key: reminderKey(LENDER_KIND, deal.id, sub.wallet, sub.channel), kind: LENDER_KIND, ref, sub, message }, stats, deal);
      }
    }
  }

  private async earnNotices(bySub: Map<string, Subscription[]>, now: number, stats: PollStats): Promise<Set<string>> {
    const strategies = await this.d.indexer.earnStrategies();
    const addresses = new Set(strategies.map(strategy => strategy.address.toLowerCase()));
    if (!strategies.length) return addresses;
    for (const strategy of strategies) {
      if (strategy.chainId !== this.d.config.chainId || strategy.address !== strategy.strategy || strategy.asOf > now || now - strategy.asOf > this.d.config.earnMaxSnapshotAgeSec) throw new Error("Earn strategy identity or freshness check failed");
    }
    // Finish reading and validating complete snapshots before sending any message from this poll.
    const [listings, snapshots] = await Promise.all([
      Promise.all(strategies.map(strategy => this.d.indexer.earnListings(strategy))), Promise.all(strategies.map(strategy => this.d.indexer.earnNotifications(strategy))),
    ]);
    const options = { timezone: this.d.config.timezone, appUrl: this.d.config.appUrl };
    for (const [i, strategy] of strategies.entries()) {
      const snapshot = snapshots[i]!;
      const holders = snapshot.accounts.filter(account => BigInt(account.shares) > 0n || BigInt(account.claimable) > 0n || account.pockets.some(pocket => BigInt(pocket.claimable) > 0n)).map(account => account.account);
      const messages: (EarnMessage | undefined)[] = [
        ...listings[i]!.map(listing => listingNotice(strategy, listing, options)),
        ...snapshot.approvals.map(approval => approvalNotice(strategy, approval, now, options)),
        ...snapshot.loans.map(loan => claimableNotice(strategy, loan, now, options)),
        ...snapshot.keeper.alerts.map(alert => keeperNotice(strategy, alert, options)),
        ...snapshot.events.flatMap(notice => outcomeNotices(strategy, notice, holders, options)),
      ];
      for (const item of messages) {
        if (!item) continue;
        for (const sub of bySub.get(item.wallet.toLowerCase()) ?? []) {
          if (!sub.prefs.expiry) continue;
          await this.deliverEarn(strategy, item, sub, stats);
        }
      }
    }
    return addresses;
  }

  private async deliverEarn(strategy: EarnStrategy, notice: EarnMessage, sub: Subscription, stats: PollStats): Promise<void> {
    const ref = `earn:${strategy.chainId}:${strategy.address}:${notice.id}`;
    const key = `${notice.kind}:${ref}:${sub.wallet.toLowerCase()}:${sub.channel}`;
    await this.deliver({ key, kind: notice.kind, ref, sub, message: notice.message }, stats);
  }

  private async rewardNotices(subs: Subscription[], now: number, stats: PollStats): Promise<void> {
    const wantBudget = subs.filter((s) => s.prefs.budget);
    const wantEpoch = subs.filter((s) => s.prefs.epoch);
    if (wantBudget.length === 0 && wantEpoch.length === 0) return;
    let pool;
    try {
      pool = await this.d.indexer.pool();
    } catch (err) {
      // The token layer may not be indexed yet; reminders must not depend on it.
      this.d.log.info("pool_unavailable", { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const epoch: IndexedEpoch | undefined = pool.epoch;
    if (epoch === undefined) return;
    const o = { timezone: this.d.config.timezone, appUrl: this.d.config.appUrl };

    const lastEpoch = this.d.db.getKv("lastEpoch");
    if (lastEpoch !== String(epoch.n)) {
      // First sighting only records the epoch; a change from a known epoch is a roll worth announcing.
      if (lastEpoch !== undefined) {
        const message = renderEpochRoll(epoch, o);
        for (const sub of wantEpoch) {
          await this.deliver({ key: `epoch:${epoch.n}:${sub.wallet.toLowerCase()}:${sub.channel}`, kind: "epoch", ref: `epoch:${epoch.n}`, sub, message }, stats);
        }
      }
      this.d.db.setKv("lastEpoch", String(epoch.n));
    }

    if (pool.budgets !== undefined && epoch.released) {
      for (const term of [7, 21] as const) {
        const remaining = term === 7 ? pool.budgets.dealsRemaining7 : pool.budgets.dealsRemaining21;
        if (BigInt(remaining) !== 0n) continue;
        const message = renderBudgetExhausted(term, epoch, o);
        for (const sub of wantBudget) {
          await this.deliver({ key: `budget${term}:${epoch.n}:${sub.wallet.toLowerCase()}:${sub.channel}`, kind: `budget${term}`, ref: `epoch:${epoch.n}`, sub, message }, stats);
        }
      }
    }
  }

  private async retryFailed(stats: PollStats, strategies?: Set<string>): Promise<void> {
    const rows = this.d.db.failedRetryable(this.d.config.maxAttempts, 50);
    for (const row of rows) {
      // Legacy lender retries need current strategy discovery; other retries work during an outage.
      if ((row.kind === LENDER_KIND) !== (strategies !== undefined)) continue;
      const envelope = this.d.db.getKv(`message:${row.key}`);
      if (envelope === undefined) continue;
      const saved = JSON.parse(envelope) as Item;
      const sub = this.d.db.listSubscriptions(row.wallet).find(sub => sub.channel === row.channel);
      const pref = row.kind.startsWith("earn_") || row.kind === LENDER_KIND ? "expiry"
        : row.kind.startsWith("budget") ? "budget" : row.kind;
      if (!sub || !sub.prefs[pref as keyof Subscription["prefs"]] || strategies?.has(row.wallet.toLowerCase())) {
        this.d.db.record({ ...row, status: "skipped", error: null, sentAt: this.now() });
        this.d.db.deleteKv(`message:${row.key}`);
        stats.skipped += 1;
        continue;
      }
      const item = { ...saved, sub };
      stats.retried += 1;
      await this.deliver(item, stats);
    }
  }

  private resolveAddress(sub: Subscription): string | undefined {
    if (sub.channel !== "telegram" || /^-?\d+$/.test(sub.address)) return sub.address;
    return this.d.db.getTelegramChat(sub.wallet);
  }

  private async deliver(item: Item, stats: PollStats, deal?: IndexedDeal): Promise<void> {
    if (this.d.db.isDone(item.key) || this.attempted.has(item.key)) return;
    const previous = this.d.db.getSent(item.key);
    if (previous && previous.attempts >= this.d.config.maxAttempts) return;
    this.attempted.add(item.key);
    const channel = this.d.channels[item.sub.channel];
    const now = this.now();
    const address = this.resolveAddress(item.sub);
    const log = this.d.log.child({ key: item.key, wallet: item.sub.wallet, channel: item.sub.channel, ...(deal ? { dealId: deal.id, expiry: deal.expiry } : {}) });
    if (address === undefined) {
      this.d.db.setKv(`message:${item.key}`, JSON.stringify(item));
      this.d.db.record({ key: item.key, wallet: item.sub.wallet, channel: item.sub.channel, kind: item.kind, ref: item.ref, status: "failed", error: "telegram chat not linked: send /start <wallet> to the bot", sentAt: now });
      stats.failed += 1;
      log.warn("send_failed", { error: "telegram chat not linked" });
      return;
    }
    try {
      const receipt = await channel.send(address, item.message);
      const status = channel.dry ? "dry" : "sent";
      this.d.db.record({ key: item.key, wallet: item.sub.wallet, channel: item.sub.channel, kind: item.kind, ref: item.ref, status, error: null, sentAt: now });
      if (status === "dry") stats.dry += 1;
      else stats.sent += 1;
      this.d.db.deleteKv(`message:${item.key}`);
      log.info("notified", { status, subject: item.message.subject, ...(receipt.id === undefined ? {} : { id: receipt.id }) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.d.db.setKv(`message:${item.key}`, JSON.stringify(item));
      this.d.db.record({ key: item.key, wallet: item.sub.wallet, channel: item.sub.channel, kind: item.kind, ref: item.ref, status: "failed", error: error.slice(0, 500), sentAt: now });
      stats.failed += 1;
      log.warn("send_failed", { error: error.slice(0, 300) });
    }
  }
}
