import { describe, expect, it } from "vitest";
import { fetchEarnInput } from "../src/earn-indexer.js";
import { safeErrorCode } from "../src/errors.js";
import type { EarnAddress } from "../../../shared/earn.js";

const strategy = "0x1000000000000000000000000000000000000011" as EarnAddress;
const snapshot = { strategy, chainId: 46630, blockNumber: "100", asOf: 1_800_000_000 };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const urlOf = (input: Parameters<typeof fetch>[0]) => input instanceof Request ? input.url : input instanceof URL ? input.href : input;

describe("Earn keeper indexer inventory", () => {
  it("pins every loan and active-approval page to the strategy snapshot without fetching request history", async () => {
    const urls: URL[] = [];
    const fetchFn: typeof fetch = input => {
      const url = new URL(urlOf(input)); urls.push(url);
      if (url.pathname === `/earn/${strategy}`) return json({ ...snapshot, address: strategy });
      if (url.pathname.endsWith("/requests")) throw Error("Request history must not gate keeper ticks");
      const cursor = url.searchParams.get("cursor");
      return json({ ...snapshot, items: [{ id: cursor ? "2" : "1" }], nextCursor: cursor ? null : "next-page" });
    };
    const result = await fetchEarnInput("http://localhost:42069", strategy, 46630, fetchFn);
    for (const list of [result.loans, result.approvals]) expect(list).toHaveLength(2);
    expect(urls).toHaveLength(5);
    expect(urls.filter(u => u.pathname === `/earn/${strategy}`).map(u => u.searchParams.get("includePockets"))).toEqual(["false"]);
    expect(urls.filter(u => u.pathname !== `/earn/${strategy}`).map(u => u.pathname.split("/").at(-1)).sort()).toEqual(["approvals", "approvals", "loans", "loans"]);
    expect(urls.filter(u => u.pathname !== `/earn/${strategy}`).every(u => u.searchParams.get("blockNumber") === "100")).toBe(true);
    expect(urls.filter(u => u.pathname.endsWith("/approvals")).map(u => u.searchParams.get("active"))).toEqual(["true", "true"]);
    expect(urls.filter(u => u.pathname.endsWith("/loans")).every(u => !u.searchParams.has("active"))).toBe(true);
  });

  it("rejects a repeated pagination cursor instead of silently truncating", async () => {
    const fetchFn: typeof fetch = input => new URL(urlOf(input)).pathname === `/earn/${strategy}`
      ? json({ ...snapshot, address: strategy }) : json({ ...snapshot, items: [], nextCursor: "loop" });
    await expect(fetchEarnInput("http://localhost:42069", strategy, 46630, fetchFn)).rejects.toThrow(/cursor|pagination/i);
  });

  it("rejects the wrong chain, strategy or block on any page", async () => {
    for (const mismatch of [{ chainId: 4663 }, { strategy: "0x1000000000000000000000000000000000000099" }, { blockNumber: "99" }]) {
      const fetchFn: typeof fetch = input => new URL(urlOf(input)).pathname === `/earn/${strategy}`
        ? json({ ...snapshot, address: strategy }) : json({ ...snapshot, ...mismatch, items: [], nextCursor: null });
      await expect(fetchEarnInput("http://localhost:42069", strategy, 46630, fetchFn)).rejects.toThrow();
    }
  });

  it("keeps pocket history excluded when restarting after a concurrent indexed update", async () => {
    let interrupted = false;
    const strategyReads: URL[] = [];
    const fetchFn: typeof fetch = input => {
      const url = new URL(urlOf(input));
      if (url.pathname === `/earn/${strategy}`) { strategyReads.push(url); return json({ ...snapshot, address: strategy }); }
      if (!interrupted) { interrupted = true; return json({ error: { code: "SNAPSHOT_CHANGED" } }, 409); }
      return json({ ...snapshot, items: [], nextCursor: null });
    };
    await fetchEarnInput("http://localhost:42069", strategy, 46630, fetchFn);
    expect(strategyReads.map(url => url.searchParams.get("includePockets"))).toEqual(["false", "false"]);
  });

  it("distinguishes unavailable, missing, rate-limited and other HTTP failures without including URLs or response bodies", async () => {
    for (const status of [404, 429, 500, 502, 503, 504, 418]) {
      let reads = 0;
      const fetchFn: typeof fetch = () => { reads++; return json({ error: "private-provider-token" }, status); };
      const error: unknown = await fetchEarnInput("https://provider.invalid/private-api-key", strategy, 46630, fetchFn).catch((e: unknown) => e);
      expect(safeErrorCode(error)).toBe(status === 418 ? "indexer_http_error" : `indexer_http_${status}`);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private");
      expect(reads).toBe(1);
    }
  });

  it("reports an exhausted snapshot race and keeps the four-attempt retry limit", async () => {
    let reads = 0;
    const fetchFn: typeof fetch = () => { reads++; return json({ error: "SNAPSHOT_CHANGED" }, 409); };
    const error: unknown = await fetchEarnInput("http://localhost", strategy, 46630, fetchFn).catch((e: unknown) => e);
    expect(safeErrorCode(error)).toBe("indexer_snapshot_changed");
    expect(reads).toBe(4);
  });

  it("distinguishes request timeouts, transport failures, malformed JSON and invalid response shapes", async () => {
    const cases = [
      { fetchFn: () => Promise.reject(new DOMException("private-token", "TimeoutError")), code: "indexer_timeout" },
      { fetchFn: () => Promise.reject(new TypeError("private-token")), code: "indexer_network_error" },
      { fetchFn: () => Promise.resolve(new Response("{private-token")), code: "indexer_invalid_json" },
      { fetchFn: () => json([]), code: "indexer_invalid_response" },
    ];
    for (const { fetchFn, code } of cases) {
      const error: unknown = await fetchEarnInput("http://localhost", strategy, 46630, fetchFn).catch((e: unknown) => e);
      expect(safeErrorCode(error)).toBe(code);
      expect(String(error)).not.toContain("private-token");
    }
  });

  it("keeps body-read timeouts distinct from malformed JSON", async () => {
    const response = Object.assign(new Response(), { json: () => Promise.reject(new DOMException("private-token", "AbortError")) });
    const error: unknown = await fetchEarnInput("http://localhost", strategy, 46630, () => Promise.resolve(response)).catch((e: unknown) => e);
    expect(safeErrorCode(error)).toBe("indexer_timeout");
  });

  it("classifies identity, snapshot and pagination errors separately", async () => {
    for (const [page, code] of [
      [{ ...snapshot, chainId: 1, items: [], nextCursor: null }, "indexer_identity_mismatch"],
      [{ ...snapshot, blockNumber: "99", items: [], nextCursor: null }, "indexer_snapshot_mismatch"],
      [{ ...snapshot, items: "invalid", nextCursor: null }, "indexer_pagination_invalid"],
      [{ ...snapshot, items: [], nextCursor: "" }, "indexer_pagination_cursor_repeated"],
    ] as const) {
      const fetchFn: typeof fetch = input => new URL(urlOf(input)).pathname === `/earn/${strategy}`
        ? json({ ...snapshot, address: strategy }) : json(page);
      const error: unknown = await fetchEarnInput("http://localhost", strategy, 46630, fetchFn).catch((e: unknown) => e);
      expect(safeErrorCode(error)).toBe(code);
    }
  });
});
