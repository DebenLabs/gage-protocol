/**
 * SQLite through Node's built-in `node:sqlite` (no native dependency; `--experimental-sqlite` on Node 22.5–22.12,
 * unflagged from 22.13). Subscriptions, the sent ledger (each notification goes out once), Telegram chat links,
 * and a tiny key-value table for poller memory. `migrate` runs on open.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress, type Address } from "viem";
import type { ChannelName } from "./auth.js";
import { parsePrefs, type Prefs } from "./prefs.js";

export interface Subscription {
  wallet: Address;
  channel: ChannelName;
  address: string;
  prefs: Prefs;
  createdAt: number;
}

export type SentStatus = "sent" | "dry" | "skipped" | "failed";

export interface SentRow {
  key: string;
  wallet: string;
  channel: ChannelName;
  kind: string;
  ref: string;
  status: SentStatus;
  attempts: number;
  error: string | null;
  sentAt: number;
}

export interface Db {
  upsertSubscription(s: Subscription): void;
  listSubscriptions(wallet: string): Subscription[];
  allSubscriptions(): Subscription[];
  deleteSubscription(wallet: string, channel: ChannelName): boolean;
  /** Kinds already sent, dry-sent or skipped for a wallet, channel and ref. */
  doneKinds(wallet: string, channel: ChannelName, ref: string): Set<string>;
  isDone(key: string): boolean;
  getSent(key: string): SentRow | undefined;
  record(row: Omit<SentRow, "attempts"> & { attempts?: number }): void;
  failedRetryable(maxAttempts: number, limit: number): SentRow[];
  countSentSince(unix: number): number;
  countPending(maxAttempts: number): number;
  getKv(key: string): string | undefined;
  setKv(key: string, value: string): void;
  deleteKv(key: string): void;
  setTelegramChat(wallet: string, chatId: string, now: number): void;
  getTelegramChat(wallet: string): string | undefined;
  close(): void;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS subscriptions (
     wallet TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, prefs TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (wallet, channel));
   CREATE TABLE IF NOT EXISTS sent (
     key TEXT PRIMARY KEY, wallet TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
     status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, error TEXT, sent_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS sent_by_ref ON sent (wallet, channel, ref);
   CREATE INDEX IF NOT EXISTS sent_by_time ON sent (sent_at);
   CREATE TABLE IF NOT EXISTS telegram_chats (wallet TEXT PRIMARY KEY, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

interface SubRow {
  wallet: string;
  channel: string;
  address: string;
  prefs: string;
  created_at: number;
}
interface SentDbRow {
  key: string;
  wallet: string;
  channel: string;
  kind: string;
  ref: string;
  status: string;
  attempts: number;
  error: string | null;
  sent_at: number;
}

function toSub(r: SubRow): Subscription {
  return {
    wallet: getAddress(r.wallet),
    channel: r.channel as ChannelName,
    address: r.address,
    prefs: parsePrefs(JSON.parse(r.prefs)) ?? parsePrefs(undefined)!,
    createdAt: r.created_at,
  };
}

function toSent(r: SentDbRow): SentRow {
  return {
    key: r.key,
    wallet: r.wallet,
    channel: r.channel as ChannelName,
    kind: r.kind,
    ref: r.ref,
    status: r.status as SentStatus,
    attempts: r.attempts,
    error: r.error,
    sentAt: r.sent_at,
  };
}

export function migrate(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT version FROM migrations").all() as unknown as { version: number }[]).map((r) => r.version),
  );
  let ran = 0;
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    ran += 1;
  });
  return ran;
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  const stmts = {
    upsertSub: db.prepare(
      `INSERT INTO subscriptions (wallet, channel, address, prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet, channel) DO UPDATE SET address = excluded.address, prefs = excluded.prefs, updated_at = excluded.updated_at`,
    ),
    listSubs: db.prepare("SELECT * FROM subscriptions WHERE wallet = ? ORDER BY channel"),
    allSubs: db.prepare("SELECT * FROM subscriptions ORDER BY wallet, channel"),
    deleteSub: db.prepare("DELETE FROM subscriptions WHERE wallet = ? AND channel = ?"),
    doneKinds: db.prepare("SELECT kind FROM sent WHERE wallet = ? AND channel = ? AND ref = ? AND status IN ('sent','dry','skipped')"),
    isDone: db.prepare("SELECT 1 FROM sent WHERE key = ? AND status IN ('sent','dry','skipped')"),
    getSent: db.prepare("SELECT * FROM sent WHERE key = ?"),
    record: db.prepare(
      `INSERT INTO sent (key, wallet, channel, kind, ref, status, attempts, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET status = excluded.status, attempts = sent.attempts + 1, error = excluded.error, sent_at = excluded.sent_at`,
    ),
    failed: db.prepare("SELECT * FROM sent WHERE status = 'failed' AND attempts < ? ORDER BY sent_at LIMIT ?"),
    sentSince: db.prepare("SELECT COUNT(*) AS n FROM sent WHERE status IN ('sent','dry') AND sent_at >= ?"),
    pending: db.prepare("SELECT COUNT(*) AS n FROM sent WHERE status = 'failed' AND attempts < ?"),
    getKv: db.prepare("SELECT value FROM kv WHERE key = ?"),
    setKv: db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    deleteKv: db.prepare("DELETE FROM kv WHERE key = ?"),
    setChat: db.prepare(
      "INSERT INTO telegram_chats (wallet, chat_id, created_at) VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET chat_id = excluded.chat_id",
    ),
    getChat: db.prepare("SELECT chat_id FROM telegram_chats WHERE wallet = ?"),
  };

  return {
    upsertSubscription: (s) => {
      stmts.upsertSub.run(s.wallet.toLowerCase(), s.channel, s.address, JSON.stringify(s.prefs), s.createdAt, s.createdAt);
    },
    listSubscriptions: (wallet) => (stmts.listSubs.all(wallet.toLowerCase()) as unknown as SubRow[]).map(toSub),
    allSubscriptions: () => (stmts.allSubs.all() as unknown as SubRow[]).map(toSub),
    deleteSubscription: (wallet, channel) => Number(stmts.deleteSub.run(wallet.toLowerCase(), channel).changes) > 0,
    doneKinds: (wallet, channel, ref) =>
      new Set((stmts.doneKinds.all(wallet.toLowerCase(), channel, ref) as unknown as { kind: string }[]).map((r) => r.kind)),
    isDone: (key) => stmts.isDone.get(key) !== undefined,
    getSent: (key) => {
      const row = stmts.getSent.get(key) as unknown as SentDbRow | undefined;
      return row ? toSent(row) : undefined;
    },
    record: (r) => {
      stmts.record.run(r.key, r.wallet.toLowerCase(), r.channel, r.kind, r.ref, r.status, r.attempts ?? 1, r.error, r.sentAt);
    },
    failedRetryable: (maxAttempts, limit) => (stmts.failed.all(maxAttempts, limit) as unknown as SentDbRow[]).map(toSent),
    countSentSince: (unix) => (stmts.sentSince.get(unix) as unknown as { n: number }).n,
    countPending: (maxAttempts) => (stmts.pending.get(maxAttempts) as unknown as { n: number }).n,
    getKv: (key) => (stmts.getKv.get(key) as unknown as { value: string } | undefined)?.value,
    setKv: (key, value) => {
      stmts.setKv.run(key, value);
    },
    deleteKv: (key) => { stmts.deleteKv.run(key); },
    setTelegramChat: (wallet, chatId, now) => {
      stmts.setChat.run(wallet.toLowerCase(), chatId, now);
    },
    getTelegramChat: (wallet) => (stmts.getChat.get(wallet.toLowerCase()) as unknown as { chat_id: string } | undefined)?.chat_id,
    close: () => db.close(),
  };
}
