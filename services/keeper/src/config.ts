import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

/** Parses "90s", "10m", "1h", "2d" or a bare millisecond count. */
export function parseDuration(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(text);
  if (!m || m[1] === undefined) throw new Error(`bad duration: ${text}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * (mult[unit] ?? 1));
}

/** Parses a decimal string ("0.01", "1000") into raw units of `decimals`. */
export function parseDecimal(text: string, decimals: number): bigint {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`bad decimal: ${text}`);
  const whole = m[1] === "" ? "0" : (m[1] ?? "0");
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + (frac === "" ? 0n : BigInt(frac));
}

export interface Intervals {
  earn: number;
  checkpoint: number;
  swapWatch: number;
  register: number;
  epoch: number;
  fees: number;
  prep: number;
  priceSample: number;
  /** Streamer boundary job: polls every interval and acts only inside the window around an epoch boundary. */
  streamerBoundary: number;
  streamerDeposit: number;
  backstop: number;
  tick: number;
}

export interface Config {
  earnEnabled: boolean;
  earnToleranceBps: number;
  earnRewardMinRaw: bigint;
  /** Idle strategy cash, in raw USDG units, above which the keeper invests it into the reserve. */
  earnInvestMinRaw: bigint;
  earnMaxAgeSeconds: number;
  earnRetryBaseSeconds: number;
  earnAlertAttempts: number;
  chainId: number;
  rpcUrl: string;
  rpcFallbackUrl: string | undefined;
  deploymentFile: string;
  outDir: string;
  dryRun: boolean;
  hasKey: boolean;
  /** Explicit opt-in: this job calls the owner-only reward rate setter. */
  ratesEnabled: boolean;
  ratesStartEpoch: number;
  minGasWei: bigint;
  /** Human USDG (decimal string); converted with the token's decimals at runtime. */
  maxClipUsdg: string;
  feeSweepMinUsdg: string;
  checkpointBatch: number;
  registerMaxPerRun: number;
  positionsSource: string;
  indexerUrl: string;
  scanFromBlock: bigint | undefined;
  logChunkBlocks: bigint;
  epochLookback: number;
  /** Emissions.REGISTRATION_GRACE: rollover/finalize wait this long after the epoch (schedule) ends. */
  registrationGraceMs: number;
  epochPrepLeadMs: number;
  lenderShareBps: number;
  twapWindowMs: number;
  /** LPStreamer.checkpointMany over every scoring position from this long before each epoch boundary (D64). */
  streamerBoundaryLeadSeconds: number;
  /** Human sGAGE (decimal string): the deposit job sends the signer's whole balance once it is at least this. */
  streamerDepositMinSgage: string;
  /** Explicit opt-in: the backstop lists, funds, registers and reclaims a deal with the keeper wallet's own funds. */
  backstopEnabled: boolean;
  /** The backstop funds only inside this window before the epoch's end. */
  backstopWindowSeconds: number;
  /** Human sGAGE (decimal string): unreserved deal budget below this is left to roll over. */
  backstopMinSgage: string;
  /** ERC-20 the backstop deal posts as collateral; defaults to the deployment's `WETH` key. */
  backstopCollateralToken: Address | undefined;
  /** Raw units; defaults to the registry minimum for the token. */
  backstopCollateralAmount: bigint | undefined;
  intervals: Intervals;
  /**
   * Job allowlist (`KEEPER_JOBS`, comma-separated). Empty = every job. A staging keeper runs only `earn`, so a
   * second signer never repeats the production keeper's permissionless maintenance against the same contracts.
   */
  jobs: readonly string[];
  runOnce: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

/** The key lives here and nowhere else; this object is never logged. */
export interface Secrets {
  keeperKey: Hex | undefined;
}

export type Env = Record<string, string | undefined>;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad integer: ${v}`);
  return n;
}

function address(v: string | undefined, name: string): Address | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  if (!isAddress(v.trim())) throw new Error(`${name} must be an address`);
  return getAddress(v.trim());
}

function rawUnits(v: string | undefined, name: string): bigint | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  if (!/^\d+$/.test(v.trim())) throw new Error(`${name} must be an integer in raw units`);
  return BigInt(v.trim());
}

/** Every scheduled job name; `KEEPER_JOBS` may name only these. */
export const JOB_NAMES = ["earn", "graduation", "seed", "fees", "register", "epoch", "checkpoint", "swapWatch", "streamerBoundary", "streamerDeposit", "backstop", "price", "rates", "prep", "gas"] as const;

function jobList(v: string | undefined): readonly string[] {
  if (v === undefined || v.trim() === "") return [];
  const names = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const name of names) if (!(JOB_NAMES as readonly string[]).includes(name)) throw new Error(`KEEPER_JOBS names an unknown job: ${name}`);
  return [...new Set(names)];
}

export function loadConfig(env: Env, argv: readonly string[] = []): { config: Config; secrets: Secrets } {
  const key = env.KEEPER_KEY?.trim();
  if (key !== undefined && key !== "" && (!isHex(key) || key.length !== 66)) {
    throw new Error("KEEPER_KEY must be a 0x-prefixed 32-byte hex private key");
  }
  const keeperKey = key === undefined || key === "" ? undefined : key;
  const hasKey = keeperKey !== undefined;
  const chainId = int(env.CHAIN_ID, 46630);
  const level = env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) throw new Error(`bad LOG_LEVEL: ${level}`);

  const config: Config = {
    earnEnabled: bool(env.EARN_ENABLED, true),
    earnToleranceBps: int(env.EARN_TOLERANCE_BPS, 100),
    earnRewardMinRaw: rawUnits(env.EARN_REWARD_MIN_RAW, "EARN_REWARD_MIN_RAW") ?? 10n ** 18n,
    earnInvestMinRaw: rawUnits(env.EARN_INVEST_MIN_RAW, "EARN_INVEST_MIN_RAW") ?? 10n ** 6n,
    earnMaxAgeSeconds: int(env.EARN_MAX_AGE_SECONDS, 120),
    earnRetryBaseSeconds: int(env.EARN_RETRY_BASE_SECONDS, 30),
    earnAlertAttempts: int(env.EARN_ALERT_ATTEMPTS, 3),
    chainId,
    rpcUrl: env.RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
    rpcFallbackUrl: env.RPC_FALLBACK_URL || undefined,
    deploymentFile: env.DEPLOYMENT_FILE ?? `../../contracts/deployments/${chainId}.json`,
    outDir: env.OUT_DIR ?? "./out",
    // Default to dry-run whenever there is no key; DRY_RUN=true forces it even with one.
    dryRun: bool(env.DRY_RUN, !hasKey) || !hasKey,
    hasKey,
    ratesEnabled: bool(env.RATES_ENABLED, false),
    ratesStartEpoch: int(env.RATES_START_EPOCH, 1),
    minGasWei: parseDecimal(env.MIN_GAS_ETH ?? "0.01", 18),
    maxClipUsdg: env.MAX_CLIP_USDG ?? "1000",
    feeSweepMinUsdg: env.FEE_SWEEP_MIN_USDG ?? "0",
    checkpointBatch: int(env.CHECKPOINT_BATCH, 50),
    registerMaxPerRun: int(env.REGISTER_MAX_PER_RUN, 20),
    positionsSource: env.POSITIONS_SOURCE ?? "chain",
    indexerUrl: env.INDEXER_URL ?? "http://localhost:42069",
    scanFromBlock: env.SCAN_FROM_BLOCK ? BigInt(env.SCAN_FROM_BLOCK) : undefined,
    logChunkBlocks: BigInt(int(env.LOG_CHUNK_BLOCKS, 20_000)),
    epochLookback: int(env.EPOCH_LOOKBACK, 4),
    registrationGraceMs: parseDuration(env.REGISTRATION_GRACE ?? "6h"),
    epochPrepLeadMs: parseDuration(env.EPOCH_PREP_LEAD ?? "24h"),
    lenderShareBps: int(env.LENDER_SHARE_BPS, 5_000),
    twapWindowMs: parseDuration(env.TWAP_WINDOW ?? "24h"),
    streamerBoundaryLeadSeconds: int(env.STREAMER_BOUNDARY_LEAD_SECONDS, 600),
    streamerDepositMinSgage: env.STREAMER_DEPOSIT_MIN_SGAGE ?? "1000",
    backstopEnabled: bool(env.BACKSTOP_ENABLED, false),
    backstopWindowSeconds: int(env.BACKSTOP_WINDOW_SECONDS, 4 * 3_600),
    backstopMinSgage: env.BACKSTOP_MIN_SGAGE ?? "1000000",
    backstopCollateralToken: address(env.BACKSTOP_COLLATERAL_TOKEN, "BACKSTOP_COLLATERAL_TOKEN"),
    backstopCollateralAmount: rawUnits(env.BACKSTOP_COLLATERAL_AMOUNT, "BACKSTOP_COLLATERAL_AMOUNT"),
    intervals: {
      earn: parseDuration(env.EARN_INTERVAL ?? "5s"),
      checkpoint: parseDuration(env.CHECKPOINT_INTERVAL ?? "1h"),
      swapWatch: parseDuration(env.SWAP_WATCH_INTERVAL ?? "5s"),
      register: parseDuration(env.REGISTER_INTERVAL ?? "10m"),
      epoch: parseDuration(env.EPOCH_INTERVAL ?? "1m"),
      fees: parseDuration(env.FEES_INTERVAL ?? "30m"),
      prep: parseDuration(env.PREP_INTERVAL ?? "1h"),
      priceSample: parseDuration(env.PRICE_SAMPLE_INTERVAL ?? "5m"),
      streamerBoundary: parseDuration(env.STREAMER_BOUNDARY_INTERVAL ?? "1m"),
      streamerDeposit: parseDuration(env.STREAMER_DEPOSIT_INTERVAL ?? "1h"),
      backstop: parseDuration(env.BACKSTOP_INTERVAL ?? "30m"),
      tick: parseDuration(env.TICK_INTERVAL ?? "5s"),
    },
    jobs: jobList(env.KEEPER_JOBS),
    runOnce: argv.includes("--once") || bool(env.RUN_ONCE, false),
    logLevel: level as Config["logLevel"],
  };
  if (config.earnToleranceBps > 1000 || config.earnMaxAgeSeconds === 0 || config.earnRetryBaseSeconds === 0 || config.earnAlertAttempts === 0 || config.intervals.earn === 0) throw new Error("Invalid Earn worker bounds");
  if (config.lenderShareBps > 10_000) throw new Error("LENDER_SHARE_BPS must be <= 10000");
  if (config.streamerBoundaryLeadSeconds === 0) throw new Error("STREAMER_BOUNDARY_LEAD_SECONDS must be positive");
  if (config.backstopWindowSeconds === 0) throw new Error("BACKSTOP_WINDOW_SECONDS must be positive");
  return { config, secrets: { keeperKey } };
}

/** What the startup log line may say about the configuration. No secrets by construction. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    chainId: c.chainId,
    rpcConfigured: Boolean(c.rpcUrl),
    rpcFallback: c.rpcFallbackUrl !== undefined,
    deploymentFile: c.deploymentFile,
    outDir: c.outDir,
    dryRun: c.dryRun,
    walletConfigured: c.hasKey,
    ratesEnabled: c.ratesEnabled,
    ratesStartEpoch: c.ratesStartEpoch,
    lenderShareBps: c.lenderShareBps,
    jobs: c.jobs.length === 0 ? "all" : c.jobs,
    streamerBoundaryLeadSeconds: c.streamerBoundaryLeadSeconds,
    streamerDepositMinSgage: c.streamerDepositMinSgage,
    backstopEnabled: c.backstopEnabled,
    backstopWindowSeconds: c.backstopWindowSeconds,
    backstopMinSgage: c.backstopMinSgage,
    backstopCollateralToken: c.backstopCollateralToken ?? null,
    backstopCollateralAmount: c.backstopCollateralAmount?.toString() ?? null,
    minGasEth: Number(c.minGasWei) / 1e18,
    maxClipUsdg: c.maxClipUsdg,
    positionsSource: c.positionsSource,
    scanFromBlock: c.scanFromBlock?.toString() ?? null,
    intervalsMs: c.intervals,
    runOnce: c.runOnce,
  };
}
