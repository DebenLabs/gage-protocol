import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config, Secrets } from "./config.js";

/** Robinhood Chain. Multicall3 is deployed at the canonical address on the testnet (checked 2026-09-07). */
export function gageChain(chainId: number, rpcUrl: string): Chain {
  const isTestnet = chainId === 46630;
  return defineChain({
    id: chainId,
    name: isTestnet ? "Robinhood Chain Testnet" : "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
    testnet: isTestnet,
  });
}

export interface Clients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account> | undefined;
  account: Account | undefined;
}

export function makeClients(config: Config, secrets: Secrets): Clients {
  const chain = gageChain(config.chainId, config.rpcUrl);
  const transports = [http(config.rpcUrl, { batch: true })];
  if (config.rpcFallbackUrl !== undefined) transports.push(http(config.rpcFallbackUrl, { batch: true }));
  const transport = transports.length > 1 ? fallback(transports) : transports[0]!;
  const publicClient = createPublicClient({ chain, transport });
  const account = secrets.keeperKey === undefined ? undefined : privateKeyToAccount(secrets.keeperKey);
  const walletClient = account === undefined ? undefined : createWalletClient({ account, chain, transport });
  return { publicClient, walletClient, account };
}
