import type { Address } from "viem";
import { loadConfig } from "../src/config.js";
import type { JobContext } from "../src/context.js";
import type { Deployment } from "../src/deployment.js";
import { createLogger, type Fields } from "../src/log.js";
import type { Call, Outcome, Sender } from "../src/sender.js";
import { emptyState } from "../src/state.js";
import type { Views } from "../src/views.js";

export const A = {
  vault: "0xde66806eee4272000C9c0cE0eAe99902B168453A" as Address,
  feeSink: "0x731C3Ed69508cF1D329324A1Aa22CC38AD7203DF" as Address,
  usdg: "0x8639D21a0f8140bC8745D826EF485a787Cfcb91f" as Address,
  registry: "0xbc441B019F5C5457c9e65a439B469e0FFB592211" as Address,
  dealRewards: "0x1000000000000000000000000000000000000001" as Address,
  emissions: "0x1000000000000000000000000000000000000002" as Address,
  lpRewards: "0x1000000000000000000000000000000000000003" as Address,
  positionManager: "0x1000000000000000000000000000000000000004" as Address,
  buyback: "0x1000000000000000000000000000000000000005" as Address,
  splitter: "0x1000000000000000000000000000000000000006" as Address,
  streamer: "0x100000000000000000000000000000000000000d" as Address,
  drip: "0x100000000000000000000000000000000000000e" as Address,
  stateView: "0x1000000000000000000000000000000000000007" as Address,
  gage: "0x1000000000000000000000000000000000000008" as Address,
  sgage: "0x1000000000000000000000000000000000000009" as Address,
  weth: "0x100000000000000000000000000000000000000a" as Address,
  hook: "0x1000000000000000000000000000000000000A00" as Address,
  zero: "0x0000000000000000000000000000000000000000" as Address,
};

export function m1Deployment(): Deployment {
  return {
    chainId: 46630,
    addresses: { DealVault: A.vault, FeeSink: A.feeSink, USDG: A.usdg, CollateralRegistry: A.registry },
    pools: {},
    startBlock: 100n,
  };
}

export function m6Deployment(): Deployment {
  const d = m1Deployment();
  d.addresses = {
    ...d.addresses,
    DealRewards: A.dealRewards,
    Emissions: A.emissions,
    LPRewards: A.lpRewards,
    PositionManager: A.positionManager,
    Buyback: A.buyback,
    CreatorFeeSplitter: A.splitter,
    StateView: A.stateView,
    GAGE: A.gage,
    sGAGE: A.sgage,
  };
  d.pools = {
    gageSgage: { currency0: A.gage, currency1: A.sgage, fee: 30_000, tickSpacing: 60, hooks: A.hook, poolId: `0x${"11".repeat(32)}` },
    gageEth: { currency0: A.weth, currency1: A.gage, fee: 0, tickSpacing: 60, hooks: A.zero, poolId: `0x${"22".repeat(32)}` },
    usdgEth: { currency0: A.weth, currency1: A.usdg, fee: 500, tickSpacing: 10, hooks: A.zero, poolId: `0x${"33".repeat(32)}` },
  };
  return d;
}

export interface RecordingSender extends Sender {
  calls: Call[];
  /** Outcome to return per label; default is a dry run with `undefined` result. */
  script: Record<string, Outcome | ((call: Call) => Outcome)>;
}

export function recordingSender(): RecordingSender {
  const calls: Call[] = [];
  const script: RecordingSender["script"] = {};
  const stats = { simulated: 0, sent: 0, reverted: 0, refused: 0, failed: 0 };
  return {
    calls,
    script,
    stats,
    gasBalance: () => Promise.resolve(10n ** 18n),
    execute: (call) => {
      calls.push(call);
      const s = script[call.label];
      const out: Outcome = s === undefined ? { status: "dry", result: undefined } : typeof s === "function" ? s(call) : s;
      return Promise.resolve(out);
    },
  };
}

/** Every view throws unless overridden, so a job touching an unexpected contract fails loudly. */
export function stubViews(overrides: Partial<Views>): Views {
  const missing =
    (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`unexpected view call: ${name}`);
    };
  const base: Views = {
    blockNumber: missing("blockNumber"),
    balance: missing("balance"),
    erc20Balance: missing("erc20Balance"),
    erc20Decimals: missing("erc20Decimals"),
    vaultBalanceUSDG: missing("vaultBalanceUSDG"),
    fundedLogs: missing("fundedLogs"),
    feeSinkState: missing("feeSinkState"),
    registered: missing("registered"),
    dealRewardsConstants: missing("dealRewardsConstants"),
    emissionsState: missing("emissionsState"),
    epochFlags: missing("epochFlags"),
    epochStart: missing("epochStart"),
    dealBudgets: missing("dealBudgets"),
    lpPoolKey: missing("lpPoolKey"),
    lpWeightedPositionLogs: missing("lpWeightedPositionLogs"),
    lpPositionWeights: missing("lpPositionWeights"),
    transferLogs: missing("transferLogs"),
    positionPoolKeys: missing("positionPoolKeys"),
    positionLiquidity: missing("positionLiquidity"),
    swapLogs: missing("swapLogs"),
    slot0: missing("slot0"),
    threshold: missing("threshold"),
    erc20Allowance: missing("erc20Allowance"),
    dripClaimable: missing("dripClaimable"),
    epochRemaining: missing("epochRemaining"),
    effectiveRates: missing("effectiveRates"),
    registryConfig: missing("registryConfig"),
    openRaw: missing("openRaw"),
    deal: missing("deal"),
    vaultBalanceERC20: missing("vaultBalanceERC20"),
    streamerState: missing("streamerState"),
  };
  return { ...base, ...overrides };
}

export interface TestCtx extends JobContext {
  sender: RecordingSender;
  lines: Fields[];
}

/** `m6Deployment` plus the streamer layer (D64): LPStreamer, Drip and a WETH key for the backstop's default collateral. */
export function streamerDeployment(): Deployment {
  const d = m6Deployment();
  d.addresses = { ...d.addresses, LPStreamer: A.streamer, Drip: A.drip, WETH: A.weth };
  return d;
}

export function mockCtx(opts: { deployment?: Deployment; views?: Partial<Views>; now?: number; env?: Record<string, string>; signer?: Address } = {}): TestCtx {
  const lines: Fields[] = [];
  const log = createLogger({}, { level: "debug", write: (line) => lines.push(JSON.parse(line) as Fields) });
  const { config } = loadConfig({ DRY_RUN: "true", ...(opts.env ?? {}) });
  const deployment = opts.deployment ?? m1Deployment();
  const sender = recordingSender();
  return {
    ...(opts.signer ? { signerAddress: opts.signer } : {}),
    config,
    log,
    views: stubViews(opts.views ?? {}),
    sender,
    state: emptyState(),
    deployment: () => deployment,
    now: () => opts.now ?? 1_800_000_000_000,
    usdgDecimals: () => Promise.resolve(6),
    lines,
  };
}

export function msgs(ctx: TestCtx): string[] {
  return ctx.lines.map((l) => String(l.msg));
}
