/**
 * The one place that talks to the chain with intent. Every call is simulated first (`eth_call`); in dry-run mode
 * the simulation is the whole story and the log says what would have been sent. In live mode the send is refused
 * when the hot wallet holds less than MIN_GAS_ETH.
 */
import {
  BaseError,
  encodeFunctionData,
  ContractFunctionRevertedError,
  type Abi,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Account,
} from "viem";
import type { TransactionJournal } from "./transaction-journal.js";
import type { Logger } from "./log.js";

export interface Call {
  /** Human label for logs and the runbook, e.g. "FeeSink.collect". */
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /** When given, the call is only sent if the simulated return value passes; otherwise it is `skipped`. */
  sendIf?: (result: unknown) => boolean;
  /** Per-call gas budget, e.g. 1% of the ETH value being converted into floor backing. */
  maxGasCostWei?: bigint;
}

export interface RevertInfo {
  name: string;
  args: readonly unknown[];
  message: string;
}

export type Outcome =
  | { status: "dry"; result: unknown }
  | { status: "skipped"; result: unknown }
  | { status: "sent"; hash: `0x${string}`; gasUsed: bigint; result: unknown }
  | { status: "refused"; reason: "gas_below_floor" | "no_wallet" | "uneconomic_gas"; balance?: bigint }
  | { status: "reverted"; revert: RevertInfo }
  | { status: "failed"; error: string };

export interface SenderDeps {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account> | undefined;
  account: Account | undefined;
  dryRun: boolean;
  minGasWei: bigint;
  log: Logger;
  journal?: TransactionJournal;
  maxTransactionCostWei?: bigint;
}

export interface Sender {
  pendingTransaction?(): `0x${string}` | null;
  /** True only while this process is confirming a new send, never while recovering an unresolved journal. */
  isConfirmingTransaction?(): boolean;
  /** Resolve the existing journal through the same nonce queue, even when no new action is due. */
  recoverPending?(): Promise<boolean>;
  execute(call: Call): Promise<Outcome>;
  /** Balance check the jobs can also use for the periodic gas line. */
  gasBalance(): Promise<bigint | undefined>;
  readonly stats: { simulated: number; sent: number; reverted: number; refused: number; failed: number };
}

export function describeRevert(err: unknown): RevertInfo | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  return {
    name: revert.data?.errorName ?? revert.reason ?? "revert",
    args: revert.data?.args ?? [],
    message: revert.shortMessage,
  };
}

export function makeSender(deps: SenderDeps): Sender {
  const { publicClient, walletClient, account, dryRun, minGasWei } = deps;
  const stats = { simulated: 0, sent: 0, reverted: 0, refused: 0, failed: 0 };
  let confirmingTransaction = false;

  const gasBalance = async (): Promise<bigint | undefined> =>
    account === undefined ? undefined : publicClient.getBalance({ address: account.address });

  const recoverPendingOne = async (): Promise<boolean> => {
    if (!deps.journal || !account || dryRun) return true;
    try {
      const receipt = await deps.journal.recover(publicClient, account);
      if (receipt) deps.log.info("transaction_recovered", { hash: receipt.transactionHash, status: receipt.status, block: receipt.blockNumber });
      return true;
    } catch {
      // Fail closed: a lost receipt never proves the nonce is available for a new transaction.
      deps.log.warn("transaction_recovery_blocked", { error: "pending-transaction-unresolved" });
      return false;
    }
  };

  const executeOne = async (call: Call): Promise<Outcome> => {
    const log = deps.log.child({ call: call.label, to: call.address, args: call.args ?? [] });
    if (!await recoverPendingOne()) return { status: "failed", error: "pending-transaction-unresolved" };
    let request;
    let result: unknown;
    try {
      const sim = await publicClient.simulateContract({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args ?? [],
        ...(call.value === undefined ? {} : { value: call.value }),
        ...(account === undefined ? {} : { account }),
      });
      request = sim.request;
      result = sim.result;
      stats.simulated += 1;
    } catch (err) {
      const revert = describeRevert(err);
      if (revert !== undefined) {
        stats.reverted += 1;
        log.info("simulation_reverted", { error: revert.name, errorArgs: revert.args });
        return { status: "reverted", revert };
      }
      stats.failed += 1;
      const message = "rpc-or-transaction-failed";
      log.error("simulation_failed", { error: message.slice(0, 400) });
      return { status: "failed", error: message };
    }

    if (call.sendIf !== undefined && !call.sendIf(result)) {
      log.debug("send_skipped", { result });
      return { status: "skipped", result };
    }
    if (dryRun) {
      log.info("would_send", { result });
      return { status: "dry", result };
    }
    if (walletClient === undefined || account === undefined) {
      stats.refused += 1;
      log.warn("send_refused", { reason: "no_wallet" });
      return { status: "refused", reason: "no_wallet" };
    }
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < minGasWei) {
      stats.refused += 1;
      log.warn("gas_below_floor", { balance, minGasWei, keeper: account.address });
      return { status: "refused", reason: "gas_below_floor", balance };
    }
    try {
      const [latest, pending] = await Promise.all([
        publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
        publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
      ]);
      if (latest !== pending) return { status: "failed", error: "wallet-has-pending-transaction" };
      let boundedFees: { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;
      if (deps.journal || call.maxGasCostWei !== undefined) {
        const [estimate, fees] = await Promise.all([
          publicClient.estimateContractGas({ ...request, account }), publicClient.estimateFeesPerGas()
        ]);
        // The next block can activate timestamp-dependent accounting writes absent from eth_estimateGas.
        boundedFees = { gas: estimate * 12n / 10n + 50_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
        const cost = boundedFees.gas * boundedFees.maxFeePerGas;
        if (call.maxGasCostWei !== undefined && cost > call.maxGasCostWei) {
          stats.refused += 1;
          log.info("send_refused", { reason: "uneconomic_gas", cost, budget: call.maxGasCostWei });
          return { status: "refused", reason: "uneconomic_gas" };
        }
        if (balance < minGasWei + cost + (call.value ?? 0n) || cost > (deps.maxTransactionCostWei ?? 10n ** 15n)) return { status: "failed", error: "transaction-gas-limit" };
      }
      let receipt;
      if (deps.journal) {
        const fees = boundedFees!;
        confirmingTransaction = true;
        try {
          receipt = await deps.journal.send(publicClient, account, { to: call.address,
            data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] }),
            value: String(call.value ?? 0n), nonce: pending, gas: String(fees.gas), maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas) });
        } finally {
          confirmingTransaction = false;
        }
      } else {
        const hash = boundedFees
          ? await walletClient.writeContract({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args ?? [], value: call.value, account, chain: walletClient.chain, ...boundedFees, type: "eip1559", nonce: pending })
          : await walletClient.writeContract({ ...request, nonce: pending });
        log.info("sent", { hash });
        receipt = await publicClient.waitForTransactionReceipt({ hash });
      }
      const hash = receipt.transactionHash;
      if (receipt.status !== "success") {
        stats.failed += 1;
        log.error("tx_reverted_onchain", { hash, gasUsed: receipt.gasUsed });
        return { status: "failed", error: `transaction ${hash} reverted on-chain` };
      }
      stats.sent += 1;
      log.info("confirmed", { hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      return { status: "sent", hash, gasUsed: receipt.gasUsed, result };
    } catch {
      stats.failed += 1;
      const message = "rpc-or-transaction-failed";
      log.error("send_failed", { error: message.slice(0, 400) });
      return { status: "failed", error: message };
    }
  };

  let queue = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    execute: call => enqueue(() => executeOne(call)),
    recoverPending: () => enqueue(recoverPendingOne),
    gasBalance, stats,
    pendingTransaction: () => deps.journal?.read()?.hash ?? null,
    isConfirmingTransaction: () => confirmingTransaction,
  };
}
