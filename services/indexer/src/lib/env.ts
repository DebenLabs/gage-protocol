import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Ponder loads `.env.local` on its own; the repo convention (contracts/.env.example) is a plain `.env`, so load it
// too. Existing variables win, so a shell export still overrides the file.
export function loadDotEnv(): void {
  const file = resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // A malformed .env is not fatal: the defaults below still describe the testnet.
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}
