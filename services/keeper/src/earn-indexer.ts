import type { EarnAddress, EarnApproval, EarnLoan, EarnSnapshot, EarnStrategy } from "../../../shared/earn.js";
import { KeeperDiagnosticError, type SafeErrorCode } from "./errors.js";

export interface EarnInput { strategy: EarnStrategy; loans: EarnLoan[]; approvals: EarnApproval[] }
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
class SnapshotChanged extends KeeperDiagnosticError {
  constructor() { super("indexer_snapshot_changed"); }
}
const httpCodes = new Map<number, SafeErrorCode>([
  [400, "indexer_http_400"], [401, "indexer_http_401"], [403, "indexer_http_403"], [404, "indexer_http_404"],
  [429, "indexer_http_429"], [500, "indexer_http_500"], [502, "indexer_http_502"], [503, "indexer_http_503"], [504, "indexer_http_504"],
]);
const requestFailure = (error: unknown) => new KeeperDiagnosticError(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
  ? "indexer_timeout" : "indexer_network_error");

/** Fixed-snapshot loans and active approvals. Queue work uses strategy totals, without loading request history. */
export async function fetchEarnInput(baseUrl: string, strategy: EarnAddress, chainId: number, fetchFn: typeof fetch = fetch): Promise<EarnInput> {
  const base = baseUrl.replace(/\/$/, ""), prefix = `/earn/${strategy.toLowerCase()}`;
  const get = async (path: string): Promise<Record<string, unknown>> => {
    let response: Response;
    try { response = await fetchFn(base + path, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } }); }
    catch (error) { throw requestFailure(error); }
    if (response.status === 409) throw new SnapshotChanged();
    if (!response.ok) throw new KeeperDiagnosticError(httpCodes.get(response.status) ?? "indexer_http_error");
    let body: unknown;
    try { body = await response.json(); }
    catch (error) { throw error instanceof SyntaxError ? new KeeperDiagnosticError("indexer_invalid_json") : requestFailure(error); }
    if (!record(body)) throw new KeeperDiagnosticError("indexer_invalid_response");
    return body;
  };
  const identity = (raw: Record<string, unknown>, snapshot?: EarnSnapshot) => {
    if (raw.chainId !== chainId || typeof raw.strategy !== "string" || raw.strategy.toLowerCase() !== strategy.toLowerCase() || typeof raw.blockNumber !== "string" || !/^\d+$/.test(raw.blockNumber) || !Number.isSafeInteger(raw.asOf)) throw new KeeperDiagnosticError("indexer_identity_mismatch");
    if (snapshot && (raw.blockNumber !== snapshot.blockNumber || raw.asOf !== snapshot.asOf)) throw new KeeperDiagnosticError("indexer_snapshot_mismatch");
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await get(`${prefix}?includePockets=false`); identity(raw);
      if (typeof raw.address !== "string" || raw.address.toLowerCase() !== strategy.toLowerCase()) throw new KeeperDiagnosticError("indexer_identity_mismatch");
      const current = raw as unknown as EarnStrategy;
      const paged = async <T>(kind: "loans" | "approvals"): Promise<T[]> => {
        const items: T[] = [], cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const query = new URLSearchParams({ limit: "100", blockNumber: current.blockNumber });
          if (kind === "approvals") query.set("active", "true");
          if (cursor) query.set("cursor", cursor);
          const page = await get(`${prefix}/${kind}?${query.toString()}`); identity(page, current);
          if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new KeeperDiagnosticError("indexer_pagination_invalid");
          items.push(...page.items as T[]);
          if (page.nextCursor === null) return items;
          if (!page.nextCursor || cursors.has(page.nextCursor)) throw new KeeperDiagnosticError("indexer_pagination_cursor_repeated");
          cursors.add(page.nextCursor); cursor = page.nextCursor;
        } while (cursor);
        return items;
      };
      const [loans, approvals] = await Promise.all([paged<EarnLoan>("loans"), paged<EarnApproval>("approvals")]);
      return { strategy: current, loans, approvals };
    } catch (error) { if (!(error instanceof SnapshotChanged) || attempt === 3) throw error; }
  }
  throw new SnapshotChanged();
}
