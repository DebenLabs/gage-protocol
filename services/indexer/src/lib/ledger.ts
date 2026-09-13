import type { Context } from "ponder:registry";
import { balances } from "ponder:schema";
import type { Address } from "viem";
import { clampZero } from "./derive";

type Db = Context["db"];

export const balanceId = (account: Address, asset: Address, tokenId?: bigint): string =>
  tokenId === undefined ? `${account}-${asset}` : `${account}-${asset}-${tokenId.toString()}`;

/** Mirrors `balanceUSDG[account] += amount` / `balanceERC20[account][token] += amount` in the vault. */
export async function credit(
  db: Db,
  account: Address,
  asset: Address,
  kind: "USDG" | "ERC20",
  amount: bigint,
  at: bigint,
): Promise<void> {
  await db
    .insert(balances)
    .values({ id: balanceId(account, asset), account, asset, kind, amount, updatedAt: at })
    .onConflictDoUpdate((row) => ({ amount: row.amount + amount, updatedAt: at }));
}

/** Mirrors `owedNFT[account][tokenId] = true`. `amount` carries the tokenId, as `Withdrawn` does. */
export async function creditNft(
  db: Db,
  account: Address,
  positionManager: Address,
  tokenId: bigint,
  at: bigint,
): Promise<void> {
  await db
    .insert(balances)
    .values({
      id: balanceId(account, positionManager, tokenId),
      account,
      asset: positionManager,
      kind: "NFT",
      amount: tokenId,
      updatedAt: at,
    })
    .onConflictDoUpdate({ updatedAt: at });
}

/**
 * `Withdrawn(account, asset, amount)`. A withdrawal drains the whole balance, so the result is zero whenever the
 * ledger is complete; the clamp only protects a backfill that started after the credit.
 */
export async function debit(db: Db, account: Address, asset: Address, amount: bigint, at: bigint): Promise<void> {
  const row = await db.find(balances, { id: balanceId(account, asset) });
  if (row === null) return;
  await db
    .update(balances, { id: row.id })
    .set({ amount: clampZero(row.amount - amount), updatedAt: at });
}

export async function removeNft(db: Db, account: Address, positionManager: Address, tokenId: bigint): Promise<void> {
  await db.delete(balances, { id: balanceId(account, positionManager, tokenId) });
}
