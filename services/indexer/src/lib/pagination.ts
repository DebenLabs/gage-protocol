import { badRequest } from "./errors";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Opaque keyset cursor: the sort key of the last row on the page plus its id as the tie-breaker. */
export type Cursor = { k: string | null; id: string };

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("BAD_LIMIT", "limit must be an integer >= 1");
  return Math.min(n, MAX_LIMIT);
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("shape");
    const { k, id } = parsed as { k?: unknown; id?: unknown };
    if ((k !== null && typeof k !== "string") || typeof id !== "string") throw new Error("shape");
    return { k, id };
  } catch {
    throw badRequest("BAD_CURSOR", "cursor is not one this service issued");
  }
}

/** Trims a `limit + 1` fetch to a page and issues the cursor for the next one. */
export function page<T>(rows: T[], limit: number, cursorOf: (row: T) => Cursor): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null;
  return { items, nextCursor };
}
