import { getAddress, isAddress, isHex, parseEther, type Address, type Hex } from "viem";

export interface SeedConfig {
  chainId: number;
  rpcUrl: string;
  locker: Address;
  codeHash: Hex;
  tokenId: bigint;
  intervalMs: number;
  minGrowthPpm: bigint;
  minGasWei: bigint;
  maxGasCostWei: bigint;
  dryRun: boolean;
}

export function seedConfig(env: NodeJS.ProcessEnv): SeedConfig {
  const chainId = Number(env.CHAIN_ID);
  if (chainId !== 46630 && chainId !== 4663) throw new Error("CHAIN_ID must be explicitly 46630 or 4663");
  if (!env.RPC_URL || !/^https?:\/\//.test(env.RPC_URL)) throw new Error("RPC_URL is required");
  if (!env.SEED_LOCK_ADDRESS || !isAddress(env.SEED_LOCK_ADDRESS)) throw new Error("SEED_LOCK_ADDRESS is required");
  if (!env.SEED_LOCK_CODEHASH || !isHex(env.SEED_LOCK_CODEHASH) || env.SEED_LOCK_CODEHASH.length !== 66) {
    throw new Error("SEED_LOCK_CODEHASH must pin the verified deployed locker bytecode");
  }
  const tokenId = BigInt(env.SEED_TOKEN_ID ?? "0");
  if (tokenId <= 0n) throw new Error("SEED_TOKEN_ID must be positive");
  const intervalMs = Number(env.SEED_INTERVAL_SECONDS ?? "1800") * 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 86_400_000) {
    throw new Error("SEED_INTERVAL_SECONDS must be between 60 and 86400");
  }
  const minGrowthPpm = BigInt(env.SEED_MIN_GROWTH_PPM ?? "100");
  if (minGrowthPpm < 1n || minGrowthPpm > 1_000_000n) throw new Error("Invalid SEED_MIN_GROWTH_PPM");
  const minGasWei = parseEther(env.MIN_GAS_ETH ?? "0.01");
  const maxGasCostWei = parseEther(env.SEED_MAX_GAS_ETH ?? "0.00005");
  if (minGasWei < 0n || maxGasCostWei <= 0n) throw new Error("Invalid gas limits");
  if (env.DRY_RUN !== undefined && !["true", "false"].includes(env.DRY_RUN)) throw new Error("DRY_RUN must be true or false");
  return {
    chainId, rpcUrl: env.RPC_URL, locker: getAddress(env.SEED_LOCK_ADDRESS),
    codeHash: env.SEED_LOCK_CODEHASH, tokenId, intervalMs, minGrowthPpm,
    minGasWei, maxGasCostWei, dryRun: env.DRY_RUN !== "false",
  };
}

export function compoundQuote(price: bigint, existing: bigint, additional: bigint, minGrowthPpm: bigint) {
  if (price <= 0n || existing <= 0n || additional <= 0n || additional * 1_000_000n < existing * minGrowthPpm) return null;
  const minLiquidity = additional * 995n / 1000n;
  return minLiquidity > 0n ? { referencePrice: price, minLiquidity } : null;
}

export function gasAllowed(balance: bigint, gas: bigint, fee: bigint, c: Pick<SeedConfig, "maxGasCostWei" | "minGasWei">) {
  const cost = gas * fee;
  return gas > 0n && fee > 0n && cost <= c.maxGasCostWei && balance >= cost + c.minGasWei;
}
