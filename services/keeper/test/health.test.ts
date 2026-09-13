import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthServer, type HealthChecks } from "../src/health.js";
import { createLogger } from "../src/log.js";

const servers: ReturnType<typeof createHealthServer>[] = [];
const quiet = createLogger({}, { write: () => undefined });
async function serve(checks: Omit<HealthChecks, "log">) {
  const server = createHealthServer({ ...checks, log: quiet });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe("keeper health HTTP boundary", () => {
  it("answers liveness without performing RPC or reading a journal", async () => {
    const process = vi.fn(() => Promise.reject(Error("RPC unavailable")));
    const earn = vi.fn(() => { throw Error("corrupt journal"); });
    const base = await serve({ process, earn });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect(process).not.toHaveBeenCalled();
    expect(earn).not.toHaveBeenCalled();
    expect((await fetch(`${base}/health`)).status).toBe(503);
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });

  it("contains Earn journal/read errors and remains available for subsequent probes", async () => {
    let broken = true;
    const base = await serve({ process: () => ({ ok: true }), earn: () => {
      if (broken) throw Error("private endpoint or journal contents must not escape");
      return { status: 200, body: { ok: true } };
    } });
    const failed = await fetch(`${base}/health/earn`);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false, error: "health_check_failed" });
    broken = false;
    expect((await fetch(`${base}/health/earn`)).status).toBe(200);
  });

  it("preserves a strategy's unhealthy or unknown status and guards serialization", async () => {
    const base = await serve({ process: () => ({ invalid: 1n }), earn: url => ({
      status: new URL(url).searchParams.has("strategy") ? 404 : 503, body: { ok: false },
    }) });
    expect((await fetch(`${base}/health/earn`)).status).toBe(503);
    expect((await fetch(`${base}/health/earn?strategy=unknown`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(503);
    expect((await fetch(`${base}/missing`)).status).toBe(404);
    expect((await fetch(`${base}/health/live`)).headers.get("cache-control")).toBe("no-store");
  });
});
