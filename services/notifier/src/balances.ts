/**
 * Optional read of the borrower's USDG wallet balance for the T−24h line ("Wallet has 2,102.40."). Needs an RPC
 * and the USDG address from the deployment json; without either the sentence is left out.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, isAddress, parseAbi, type Address } from "viem";

export type WalletUSDG = (wallet: string) => Promise<bigint | undefined>;

const erc20Abi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

/** The `USDG` key of `contracts/deployments/<chainId>.json`, or undefined when the file or key is missing. */
export function readUsdgAddress(deploymentFile: string): Address | undefined {
  try {
    const json: unknown = JSON.parse(readFileSync(deploymentFile, "utf8"));
    if (typeof json !== "object" || json === null) return undefined;
    const v = (json as Record<string, unknown>).USDG;
    return typeof v === "string" && isAddress(v) ? getAddress(v) : undefined;
  } catch {
    return undefined;
  }
}

export function rpcWalletUSDG(rpcUrl: string, usdg: Address, onError?: (error: string) => void): WalletUSDG {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return async (wallet) => {
    if (!isAddress(wallet)) return undefined;
    try {
      return await client.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(wallet)] });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  };
}
