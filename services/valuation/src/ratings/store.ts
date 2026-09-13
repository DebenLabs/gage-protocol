import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Optional local evidence ledger. Never used for authorization, pricing or vault accounting. */
export class RatingStore {
  private readonly db: SqliteDatabase;
  constructor(file: string) {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof SqliteDatabase };
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS assessments (id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions (assessment TEXT NOT NULL, session TEXT NOT NULL, event TEXT NOT NULL, surface TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (assessment, session, event, surface));
      CREATE INDEX IF NOT EXISTS assessments_time ON assessments(at);
      CREATE INDEX IF NOT EXISTS interactions_time ON interactions(at);`);
  }
  assessment(id: string, at: number, body: unknown): boolean {
    // Bounded public traffic; retained observations can be exported before their 90-day expiry.
    this.db.prepare("DELETE FROM interactions WHERE at < ?").run(at - 90 * 86400);
    this.db.prepare("DELETE FROM assessments WHERE at < ?").run(at - 90 * 86400);
    const count = this.db.prepare("SELECT count(*) AS n FROM assessments WHERE at >= ?").get(at - 86400) as { n: number };
    if (count.n >= 10_000) return false;
    this.db.prepare("INSERT OR IGNORE INTO assessments VALUES (?, ?, ?)").run(id, at, JSON.stringify(body));
    return true;
  }
  interaction(assessment: string, session: string, event: string, surface: string, now: number): boolean {
    if (!this.db.prepare("SELECT id FROM assessments WHERE id = ? AND at >= ?").get(assessment, now - 900)) return false;
    const count = this.db.prepare("SELECT count(*) AS n FROM interactions WHERE at >= ?").get(now - 86400) as { n: number };
    if (count.n >= 50_000) return false;
    this.db.prepare("INSERT OR IGNORE INTO interactions VALUES (?, ?, ?, ?, ?)").run(assessment, session, event, surface, now);
    return true;
  }
  close(): void { this.db.close(); }
  observations(from: number, through: number): unknown[] {
    return (this.db.prepare("SELECT body FROM assessments WHERE at >= ? AND at <= ? ORDER BY at DESC LIMIT 10000").all(from, through) as { body: string }[]).map(row => JSON.parse(row.body) as unknown);
  }
}
