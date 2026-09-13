import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { keccak256, type PublicClient, type Transport, type Chain, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TransactionJournal } from "../src/transaction-journal.js";

it("persists before broadcast and recovers a lost receipt without signing a second transaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gage-keeper-test-"));
  try {
    const file = join(dir, "pending.json"), key = generatePrivateKey(), account = privateKeyToAccount(key);
    let broadcast = 0, mined = false, hash: Hex = "0x";
    const missing = (name: string) => { const e = new Error(); e.name = name; throw e; };
    const pub = {
      getChainId: () => Promise.resolve(4663),
      getTransactionCount: () => Promise.resolve(mined ? 1 : 0),
      getTransactionReceipt: () => Promise.resolve(mined ? { status: "success", transactionHash: hash } : missing("TransactionReceiptNotFoundError")),
      getTransaction: () => Promise.resolve(broadcast ? {} : missing("TransactionNotFoundError")),
      sendRawTransaction: ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        hash = keccak256(serializedTransaction); broadcast++;
        expect((JSON.parse(readFileSync(file, "utf8")) as {hash: string}).hash).toBe(hash);
        expect(readFileSync(file, "utf8")).not.toContain(key.slice(2));
        return Promise.resolve();
      },
      waitForTransactionReceipt: () => Promise.reject(new Error("response-lost"))
    } as unknown as PublicClient<Transport, Chain>;
    await expect(new TransactionJournal(file).send(pub, account, { to: account.address, data: "0x", value: "0", nonce: 0, gas: "21000", maxFeePerGas: "10", maxPriorityFeePerGas: "1" })).rejects.toThrow("response-lost");
    mined = true;
    const recovered = await new TransactionJournal(file).recover(pub, account);
    expect(recovered?.transactionHash).toBe(hash);
    expect(broadcast).toBe(1);
    expect(new TransactionJournal(file).read()).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
