import { createServer } from "node:http";
import type { Logger } from "./log.js";
import { safeErrorCode } from "./errors.js";

export interface HealthChecks {
  process(): unknown;
  earn(url: string): { status: number; body: unknown };
  log: Logger;
}

/** Liveness needs no dependency I/O. Readiness and Earn probes fail closed without crashing the server. */
export function createHealthServer(checks: HealthChecks) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://keeper");
      let status = 200;
      let body: unknown;
      if (url.pathname === "/health/live") body = { ok: true };
      else if (url.pathname === "/health") body = await checks.process();
      else if (url.pathname === "/health/earn") ({ status, body } = checks.earn(url.href));
      else { res.writeHead(404).end(); return; }
      // Serialization is guarded too: unreadable journals and malformed state must not reject unhandled.
      const json = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(json);
    })().catch(error => {
      checks.log.warn("health_probe_failed", { error: safeErrorCode(error) });
      if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"ok":false,"error":"health_check_failed"}');
    });
  });
}
