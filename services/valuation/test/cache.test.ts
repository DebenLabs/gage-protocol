import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockCache } from "../src/cache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("per-block cache", () => {
  it("shares an unfinished read across simultaneous requests", async () => {
    const pending = deferred<string>();
    const block = vi.fn(async () => 10n);
    const read = vi.fn(() => pending.promise);
    const cache = new BlockCache(block, 1000);
    const requests = Array.from({ length: 20 }, () => cache.memo("pool", read));
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(read).toHaveBeenCalledTimes(1);
    expect(block).toHaveBeenCalledTimes(1);
    pending.resolve("price");
    expect(await Promise.all(requests)).toEqual(Array(20).fill("price"));
    expect(await cache.memo("pool", read)).toBe("price");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest block when an older read finishes afterwards", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const block = vi.fn().mockResolvedValueOnce(10n).mockResolvedValue(11n);
    const cache = new BlockCache(block, 1000);
    const old = cache.memo("pool", () => pending.promise);
    await vi.advanceTimersByTimeAsync(1001);
    const fresh = vi.fn(async () => "fresh");
    expect(await cache.memo("pool", fresh)).toBe("fresh");
    pending.resolve("old");
    expect(await old).toBe("old");
    expect(await cache.memo("pool", fresh)).toBe("fresh");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("retries failed reads without discarding a newer block's value", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const block = vi.fn().mockResolvedValueOnce(10n).mockResolvedValue(11n);
    const cache = new BlockCache(block, 1000);
    const old = cache.memo("pool", () => pending.promise);
    const failure = expect(old).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(1001);
    const fresh = vi.fn(async () => "fresh");
    await cache.memo("pool", fresh);
    pending.reject(new Error("offline"));
    await failure;
    expect(await cache.memo("pool", fresh)).toBe("fresh");
    expect(fresh).toHaveBeenCalledTimes(1);

    await expect(cache.memo("retry", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(await cache.memo("retry", async () => "recovered")).toBe("recovered");
  });
});
