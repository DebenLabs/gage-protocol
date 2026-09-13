import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keccak256, type Account, type Chain, type Hex, type PublicClient, type TransactionReceipt, type Transport } from "viem";

type Tx = { to: Hex; data: Hex; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string };
interface Pending { chainId: number; owner: Hex; hash: Hex; tx: Tx }
/** Only public unsigned transaction fields are persisted. Re-signing reproduces the identical hash on restart. */
export class TransactionJournal {
  constructor(readonly file: string) {}
  read(): Pending | null { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) as Pending | null : null; }
  save(p: Pending | null): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(p), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  async recover(pub: PublicClient<Transport, Chain>, account: Account): Promise<TransactionReceipt | null> {
    const pending = this.read();
    if (!pending) return null;
    if (pending.owner.toLowerCase() !== account.address.toLowerCase() || pending.chainId !== await pub.getChainId()) throw new Error("journal-identity-mismatch");
    let receipt: TransactionReceipt | null = null;
    try { receipt = await pub.getTransactionReceipt({ hash: pending.hash }); }
    catch (e) { if (!(e instanceof Error) || e.name !== "TransactionReceiptNotFoundError") throw e; }
    if (!receipt) {
      let known = false;
      try { await pub.getTransaction({ hash: pending.hash }); known = true; }
      catch (e) { if (!(e instanceof Error) || e.name !== "TransactionNotFoundError") throw e; }
      if (!known) {
        if (await pub.getTransactionCount({ address: account.address, blockTag: "latest" }) > pending.tx.nonce) throw new Error("journal-nonce-consumed");
        if (!account.signTransaction) throw new Error("local-signer-required");
        const raw = await account.signTransaction(fields(pending));
        if (keccak256(raw) !== pending.hash) throw new Error("journal-signature-mismatch");
        await pub.sendRawTransaction({ serializedTransaction: raw });
      }
      receipt = await pub.waitForTransactionReceipt({ hash: pending.hash, timeout: 60_000 });
    }
    this.save(null);
    return receipt;
  }
  async send(pub: PublicClient<Transport, Chain>, account: Account, tx: Tx): Promise<TransactionReceipt> {
    if (this.read()) throw new Error("unresolved-journal-transaction");
    if (!account.signTransaction) throw new Error("local-signer-required");
    const p: Pending = { chainId: await pub.getChainId(), owner: account.address, tx, hash: "0x" };
    const raw = await account.signTransaction(fields(p));
    p.hash = keccak256(raw);
    this.save(p);
    // recover also handles a lost response between submission and confirmation.
    return (await this.recover(pub, account))!;
  }
}
function fields(p: Pending) {
  return { chainId: p.chainId, type: "eip1559" as const, to: p.tx.to, data: p.tx.data, nonce: p.tx.nonce,
    value: BigInt(p.tx.value), gas: BigInt(p.tx.gas), maxFeePerGas: BigInt(p.tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.tx.maxPriorityFeePerGas) };
}
