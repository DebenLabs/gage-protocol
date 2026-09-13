import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseAbi, type PublicClient, type WalletClient, type Transport, type Chain, type Account, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { makeSender } from "../src/sender.js";
import { createLogger } from "../src/log.js";
import { TransactionJournal } from "../src/transaction-journal.js";

const journalDirs: string[] = [];
afterEach(() => { for (const dir of journalDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function journalHarness() {
  const dir = mkdtempSync(join(tmpdir(), "gage-sender-test-")); journalDirs.push(dir);
  const account = privateKeyToAccount(generatePrivateKey());
  const journal = new TransactionJournal(join(dir, "pending.json"));
  let broadcasts = 0, mined = false, hash: Hex = "0x";
  const receipt = () => ({ status: "success", transactionHash: hash, gasUsed: 100_000n, blockNumber: 1n }) as TransactionReceipt;
  let wait = (): Promise<TransactionReceipt> => { mined = true; return Promise.resolve(receipt()); };
  const missing = (name: string): never => { const error = new Error(); error.name = name; throw error; };
  const simulate = vi.fn(() => Promise.resolve({ request: {}, result: 1n }));
  const pub = {
    simulateContract: simulate,
    getBalance: () => Promise.resolve(10n ** 18n),
    getTransactionCount: () => Promise.resolve(mined ? 1 : 0),
    estimateContractGas: () => Promise.resolve(100_000n),
    estimateFeesPerGas: () => Promise.resolve({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getChainId: () => Promise.resolve(4663),
    getTransactionReceipt: () => Promise.resolve(mined ? receipt() : missing("TransactionReceiptNotFoundError")),
    getTransaction: () => Promise.resolve(broadcasts ? {} : missing("TransactionNotFoundError")),
    sendRawTransaction: ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      hash = keccak256(serializedTransaction); broadcasts++; return Promise.resolve(hash);
    },
    waitForTransactionReceipt: () => wait(),
  } as unknown as PublicClient<Transport, Chain>;
  const sender = makeSender({ publicClient: pub, walletClient: {} as WalletClient<Transport, Chain, Account>, account,
    dryRun: false, minGasWei: 0n, journal, log: createLogger({}, { write: () => {} }) });
  const call = { label: "fixture", address: account.address, abi: parseAbi(["function claim() returns(uint256)"]), functionName: "claim" };
  return { sender, journal, call, simulate, broadcasts: () => broadcasts,
    setWait: (next: typeof wait) => { wait = next; }, mine: () => { mined = true; return receipt(); } };
}

it("serializes simulations and nonce reads across simultaneous jobs through receipt confirmation", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const steps: string[] = [];
  let nonce = 0;
  const pub = {
    simulateContract: vi.fn(() => { steps.push(`simulate:${nonce}`); return Promise.resolve({ request: {}, result: 1n }); }),
    getBalance: () => Promise.resolve(10n ** 18n),
    getTransactionCount: () => Promise.resolve(nonce),
    waitForTransactionReceipt: async () => { await new Promise(resolve => setTimeout(resolve, 10)); steps.push(`receipt:${nonce}`); nonce++; return { status: "success", transactionHash: `0x${nonce}`, gasUsed: 1n, blockNumber: 1n }; }
  } as unknown as PublicClient<Transport, Chain>;
  const wallet = { writeContract: (p: { nonce: number }) => { steps.push(`send:${p.nonce}`); return Promise.resolve(`0x${p.nonce}`); } } as unknown as WalletClient<Transport, Chain, Account>;
  const sender = makeSender({ publicClient: pub, walletClient: wallet, account, dryRun: false, minGasWei: 0n, log: createLogger({}, { write: () => {} }) });
  const call = { label: "fixture", address: account.address, abi: parseAbi(["function claim() returns(uint256)"]), functionName: "claim" };
  const results = await Promise.all([sender.execute(call), sender.execute(call)]);
  expect(results.map(r => r.status)).toEqual(["sent", "sent"]);
  expect(steps).toEqual(["simulate:0", "send:0", "receipt:0", "simulate:1", "send:1", "receipt:1"]);
});

describe("credential-safe errors", () => {
  it("does not include an RPC URL or key from a thrown client error", async () => {
    const lines: string[] = [];
    const pub = { simulateContract: () => Promise.reject(new Error("https://rpc.example/private-token secret-key")) } as unknown as PublicClient<Transport, Chain>;
    const sender = makeSender({ publicClient: pub, walletClient: undefined, account: undefined, dryRun: true, minGasWei: 0n, log: createLogger({}, { write: s => lines.push(s) }) });
    const out = await sender.execute({ label: "fixture", address: "0x0000000000000000000000000000000000000001", abi: [], functionName: "claim" });
    expect(JSON.stringify([out, lines])).not.toMatch(/private-token|secret-key/);
  });
});

it("refuses expensive fee maintenance before signing and caps the affordable transaction", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const writeContract = vi.fn((_request: unknown) => Promise.resolve("0x01"));
  const pub = {
    simulateContract: () => Promise.resolve({request: {}, result: 1n}),
    getBalance: () => Promise.resolve(10n ** 18n),
    getTransactionCount: () => Promise.resolve(0),
    estimateContractGas: () => Promise.resolve(100_000n),
    estimateFeesPerGas: () => Promise.resolve({maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}),
    waitForTransactionReceipt: () => Promise.resolve({status: "success", transactionHash: "0x01", gasUsed: 100_000n, blockNumber: 1n})
  } as unknown as PublicClient<Transport, Chain>;
  const wallet = {writeContract} as unknown as WalletClient<Transport, Chain, Account>;
  const sender = makeSender({publicClient: pub, walletClient: wallet, account, dryRun: false, minGasWei: 0n, log: createLogger({}, {write: () => {}})});
  const call = {label: "fees", address: account.address, abi: parseAbi(["function process(uint256)"]), functionName: "process", args: [100n]};
  expect(await sender.execute({...call, maxGasCostWei: 339_999n})).toEqual({status: "refused", reason: "uneconomic_gas"});
  expect(writeContract).not.toHaveBeenCalled();
  expect((await sender.execute({...call, maxGasCostWei: 340_000n})).status).toBe("sent");
  expect(writeContract.mock.calls[0]?.[0]).toMatchObject({gas: 170_000n, maxFeePerGas: 2n, nonce: 0});
});

describe("independent journal recovery", () => {
  it("clears a confirmed transaction after a lost receipt without simulating or sending another action", async () => {
    const h = journalHarness();
    h.setWait(() => Promise.reject(new Error("receipt response lost")));
    expect((await h.sender.execute(h.call)).status).toBe("failed");
    expect(h.sender.pendingTransaction?.()).not.toBeNull();
    expect(h.sender.isConfirmingTransaction?.()).toBe(false);
    h.mine();
    expect(await h.sender.recoverPending?.()).toBe(true);
    expect(h.sender.pendingTransaction?.()).toBeNull();
    expect(h.simulate).toHaveBeenCalledTimes(1);
    expect(h.broadcasts()).toBe(1);
  });

  it("queues recovery behind an active confirmation without rebroadcasting or overlapping journal access", async () => {
    const h = journalHarness();
    let entered = (): void => {}, finish = (_receipt: TransactionReceipt): void => {};
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const receipt = new Promise<TransactionReceipt>(resolve => { finish = resolve; });
    h.setWait(() => { entered(); return receipt; });
    const recover = vi.spyOn(h.journal, "recover");
    const sending = h.sender.execute(h.call);
    await waiting;
    expect(h.sender.pendingTransaction?.()).not.toBeNull();
    expect(h.sender.isConfirmingTransaction?.()).toBe(true);
    const recovering = h.sender.recoverPending?.();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(2); // preflight, then this transaction's submission/receipt
    finish(h.mine());
    expect((await sending).status).toBe("sent");
    expect(await recovering).toBe(true);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(h.sender.isConfirmingTransaction?.()).toBe(false);
    expect(h.sender.pendingTransaction?.()).toBeNull();
    expect(h.broadcasts()).toBe(1);
  });

  it("keeps an unresolved transaction blocked and refuses every new action before simulation", async () => {
    const h = journalHarness();
    h.setWait(() => Promise.reject(new Error("receipt timeout")));
    await h.sender.execute(h.call);
    const pending = h.sender.pendingTransaction?.();
    expect(await h.sender.recoverPending?.()).toBe(false);
    expect(h.sender.isConfirmingTransaction?.()).toBe(false);
    expect(await h.sender.execute(h.call)).toEqual({ status: "failed", error: "pending-transaction-unresolved" });
    expect(h.sender.pendingTransaction?.()).toBe(pending);
    expect(h.simulate).toHaveBeenCalledTimes(1);
    expect(h.broadcasts()).toBe(1);
  });
});
