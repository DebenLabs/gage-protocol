import { isAddress, type Address } from "viem";

export type V2Engine = {
  engine: Address; registry: Address; rewards: Address; cashoutRouter: Address;
  entryRouter: Address; zapRouter: Address; startBlock: number; grace: number; name: string;
  lenderSales?: boolean;
};
export type NativeV2 = { adapter: Address; engines: V2Engine[] };

export function parseNativeV2(raw: unknown): NativeV2 {
  if (!raw || typeof raw !== "object") throw new Error("Invalid nativeV2 deployment");
  const v = raw as NativeV2;
  if (!isAddress(v.adapter) || BigInt(v.adapter) === 0n || !Array.isArray(v.engines) || !v.engines.length) throw new Error("Invalid V2 adapter/engines");
  const engines = new Set<string>();
  const ledgers = new Set<string>();
  for (const e of v.engines) {
    if (e.lenderSales !== undefined && typeof e.lenderSales !== "boolean") throw new Error("Invalid V2 lender sales capability");
    for (const k of ["engine", "registry", "rewards", "cashoutRouter", "entryRouter", "zapRouter"] as const) {
      if (!isAddress(e[k]) || BigInt(e[k]) === 0n) throw new Error(`Invalid V2 ${k}`);
    }
    if (!Number.isSafeInteger(e.startBlock) || e.startBlock <= 0 || !Number.isInteger(e.grace) || e.grace < 0 || e.grace > 604800 || !e.name) throw new Error("Invalid V2 metadata");
    if (engines.has(e.engine.toLowerCase()) || ledgers.has(e.rewards.toLowerCase())) throw new Error("Duplicate V2 engine/ledger");
    engines.add(e.engine.toLowerCase()); ledgers.add(e.rewards.toLowerCase());
  }
  return v;
}
