import path from "node:path";

export interface Config {
  rpcUrl: string;
  port: number;
  indexerUrl: string;
  deploymentFile: string;
  explorerApi: string;
  dataDir: string;
  knownLockers: string[];
  rangeSigmaMultiplier: number;
  blockTtlMs: number;
  sampleIntervalMs: number;
  /** How long a token's facts (explorer calls, checks) are reused before being rebuilt. */
  factsTtlMs: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`bad numeric env value: ${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const deploymentFile = env.DEPLOYMENT_FILE ?? "../../contracts/deployments/46630.json";
  return {
    rpcUrl: env.RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
    port: num(env.PORT, 4100),
    indexerUrl: (env.INDEXER_URL ?? "http://localhost:42069").replace(/\/$/, ""),
    deploymentFile: path.resolve(cwd, deploymentFile),
    explorerApi: (env.EXPLORER_API ?? "https://explorer.testnet.chain.robinhood.com/api/v2").replace(/\/$/, ""),
    dataDir: path.resolve(cwd, env.DATA_DIR ?? "./data"),
    knownLockers: (env.KNOWN_LOCKERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
    rangeSigmaMultiplier: num(env.RANGE_SIGMA_MULTIPLIER, 1.5),
    blockTtlMs: num(env.BLOCK_TTL_MS, 1000),
    sampleIntervalMs: num(env.SAMPLE_INTERVAL_MS, 3_600_000),
    factsTtlMs: num(env.FACTS_TTL_MS, 300_000)
  };
}
