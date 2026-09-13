import type { PublicClient, Transport, Chain, Address } from "viem";
import type { Config } from "./config.js";
import type { ContractKey, Deployment } from "./deployment.js";
import type { Logger } from "./log.js";
import type { Sender } from "./sender.js";
import type { KeeperState } from "./state.js";
import type { Views } from "./views.js";

export interface JobContext {
  publicClient?: PublicClient<Transport, Chain>;
  signerAddress?: Address;
  config: Config;
  log: Logger;
  views: Views;
  sender: Sender;
  /** Mutable; the runner persists it after every job. */
  state: KeeperState;
  /** Re-read on every call so token-layer keys are picked up when they appear. */
  deployment(): Deployment;
  /** Unix milliseconds. */
  now(): number;
  /** Cached USDG decimals (6 on mainnet USDG and on the testnet mock). */
  usdgDecimals(): Promise<number>;
}

/** Address lookup that logs one clean skip line when a contract is not deployed yet. */
export function need(ctx: JobContext, d: Deployment, job: string, keys: readonly ContractKey[]): Address[] | undefined {
  const missing = keys.filter((k) => d.addresses[k] === undefined);
  if (missing.length > 0) {
    ctx.log.info("job_skipped", { job, reason: "contract_not_deployed", missing });
    return undefined;
  }
  return keys.map((k) => d.addresses[k]!);
}

export function nowSeconds(ctx: JobContext): number {
  return Math.floor(ctx.now() / 1000);
}
