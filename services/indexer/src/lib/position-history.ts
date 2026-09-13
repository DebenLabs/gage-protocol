import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";

export interface PositionHistory {
  chainId: number;
  anchorBlock: number;
  anchorHash: Hex;
  positionManager: Address;
  poolIds: Hex[];
  tokenIds: string[];
  firstBlock: number;
  eventCount: number;
  /** Snapshot at anchorBlock. All subsequent transfers are indexed from anchorBlock + 1. */
  owners?: Record<string, Address>;
}
export function parsePositionHistory(raw: string, chainId: number, manager: Address, startBlock: number): PositionHistory {
  const h = JSON.parse(raw) as PositionHistory;
  if (h.chainId !== chainId || h.positionManager?.toLowerCase() !== manager.toLowerCase()) throw new Error("Position history chain/manager mismatch");
  if (!Number.isSafeInteger(h.anchorBlock) || h.anchorBlock < 0 || h.anchorBlock >= startBlock || !Number.isSafeInteger(h.firstBlock) || h.firstBlock < 0 || h.firstBlock > h.anchorBlock) throw new Error("Position history block boundary invalid");
  if (!/^0x[0-9a-f]{64}$/i.test(h.anchorHash) || !Array.isArray(h.poolIds) || h.poolIds.length === 0 || h.poolIds.some(id => !/^0x[0-9a-f]{64}$/i.test(id))) throw new Error("Position history provenance invalid");
  if (!Array.isArray(h.tokenIds) || h.tokenIds.length === 0 || h.tokenIds.some(id => typeof id !== "string" || !/^[1-9][0-9]*$/.test(id) || BigInt(id) >= 1n << 256n) || new Set(h.tokenIds).size !== h.tokenIds.length) throw new Error("Position history token IDs invalid");
  if (h.owners !== undefined && (typeof h.owners !== "object" || h.owners === null || Array.isArray(h.owners) || Object.keys(h.owners).length !== h.tokenIds.length || h.tokenIds.some(id => !/^0x[0-9a-f]{40}$/i.test(h.owners![id] ?? "") || BigInt(h.owners![id]!) === 0n))) throw new Error("Position history ownership snapshot incomplete");
  return h;
}
export function positionHistoryCandidates(history: PositionHistory | undefined, wallet: Address): string[] {
  if (!history) return [];
  return history.owners ? history.tokenIds.filter(id => history.owners![id]!.toLowerCase() === wallet.toLowerCase()) : history.tokenIds;
}
export function loadPositionHistory(chainId: number, manager: Address | undefined, startBlock: number): PositionHistory | undefined {
  if (!manager) return undefined;
  if (process.env.POSITION_HISTORY_FILE === "none") return undefined;
  const file = process.env.POSITION_HISTORY_FILE ? resolve(process.cwd(), process.env.POSITION_HISTORY_FILE) : resolve(process.cwd(), "position-history", `${chainId}.json`);
  if (!existsSync(file)) return undefined;
  return parsePositionHistory(readFileSync(file, "utf8"), chainId, manager, startBlock);
}
