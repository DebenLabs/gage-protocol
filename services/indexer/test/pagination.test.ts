import { describe, expect, it } from "vitest";

import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor, page, parseLimit } from "../src/lib/pagination";

describe("parseLimit", () => {
  it("defaults to 50 and caps at 200", () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit("")).toBe(DEFAULT_LIMIT);
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("999")).toBe(MAX_LIMIT);
  });
  it("rejects nonsense", () => {
    expect(() => parseLimit("0")).toThrow();
    expect(() => parseLimit("ten")).toThrow();
  });
});

describe("cursors", () => {
  it("round-trips", () => {
    const c = { k: "1756700000", id: "42" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(undefined)).toBeNull();
  });
  it("rejects cursors it did not issue", () => {
    expect(() => decodeCursor("not-base64-json")).toThrow();
    expect(() => decodeCursor(Buffer.from('{"k":1}').toString("base64url"))).toThrow();
  });
});

describe("page", () => {
  const cursorOf = (r: number) => ({ k: null, id: String(r) });
  it("trims a limit+1 fetch and issues a cursor only when more rows exist", () => {
    expect(page([1, 2, 3], 2, cursorOf)).toEqual({ items: [1, 2], nextCursor: encodeCursor({ k: null, id: "2" }) });
    expect(page([1, 2], 2, cursorOf)).toEqual({ items: [1, 2], nextCursor: null });
    expect(page([], 2, cursorOf)).toEqual({ items: [], nextCursor: null });
  });
});
