/**
 * gage keeper entrypoint. Permissionless maintenance plus an explicitly enabled owner rate job.
 *
 *   pnpm dev                 run the scheduler (dry-run unless KEEPER_KEY is set and DRY_RUN is not "true")
 *   pnpm once                run every job once, then exit
 *   pnpm prep-epoch [-- n]   write an unsigned owner proposal for epoch n (default: the next epoch), then exit
 */
import { createHealthServer } from "./health.js";
import { safeErrorCode } from "./errors.js";
import { TransactionJournal } from "./transaction-journal.js";
import { runGraduation, runSeed } from "./jobs/launch.js";
import { join, resolve } from "node:path";
import { describeConfig, loadConfig } from "./config.js";
import { makeClients } from "./chain.js";
import type { JobContext } from "./context.js";
import { readDeployment, summarise, type Deployment } from "./deployment.js";
import { runEarn, earnHealth, earnHealthResponse, earnStrategyHealths } from "./jobs/earn.js";
import { runBackstop } from "./jobs/backstop.js";
import { runCheckpoint } from "./jobs/checkpoint.js";
import { runEpoch } from "./jobs/epoch.js";
import { runFees } from "./jobs/fees.js";
import { runPrep } from "./jobs/prep.js";
import { runPriceSample } from "./jobs/price.js";
import { runRegister } from "./jobs/register.js";
import { runRates } from "./jobs/rates.js";
import { runStreamerBoundary } from "./jobs/streamer-boundary.js";
import { runStreamerDeposit } from "./jobs/streamer-deposit.js";
import { runSwapWatch } from "./jobs/swap-watch.js";
import { createLogger } from "./log.js";
import { Scheduler, selectJobs, type Job } from "./scheduler.js";
import { makeSender } from "./sender.js";
import { loadState, saveState } from "./state.js";
import { makeViews } from "./views.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { config, secrets } = loadConfig(process.env, argv);
  const log = createLogger({ service: "keeper" }, { level: config.logLevel });
  const clients = makeClients(config, secrets);
  delete process.env.KEEPER_KEY;
  const views = makeViews(clients);
  const sender = makeSender({ ...clients, dryRun: config.dryRun, minGasWei: config.minGasWei, log, journal: new TransactionJournal(join(config.outDir, "pending-transaction.json")) });
  const statePath = join(config.outDir, "keeper-state.json");
  const state = loadState(statePath);
  const deploymentPath = resolve(process.cwd(), config.deploymentFile);

  let lastGood: Deployment | undefined;
  const deployment = (): Deployment => {
    try {
      lastGood = readDeployment(deploymentPath);
    } catch (err) {
      if (lastGood === undefined) throw err;
      log.warn("deployment_reload_failed", { path: deploymentPath, error: safeErrorCode(err) });
    }
    return lastGood;
  };

  let usdgDecimalsCache: number | undefined;
  const ctx: JobContext = {
    publicClient: clients.publicClient,
    ...(clients.account ? { signerAddress: clients.account.address } : {}),
    config,
    log,
    views,
    sender,
    state,
    deployment,
    now: () => Date.now(),
    usdgDecimals: async () => {
      if (usdgDecimalsCache === undefined) {
        const usdg = deployment().addresses.USDG;
        usdgDecimalsCache = usdg === undefined ? 6 : await views.erc20Decimals(usdg);
      }
      return usdgDecimalsCache;
    },
  };

  const d = deployment();
  if (d.chainId !== config.chainId) throw new Error(`deployment json is for chain ${d.chainId}, config says ${config.chainId}`);
  const chainId = await clients.publicClient.getChainId();
  if (chainId !== config.chainId) throw new Error(`RPC is chain ${chainId}, config says ${config.chainId}`);
  const gas = await sender.gasBalance();
  log.info("keeper_start", {
    ...describeConfig(config),
    keeper: clients.account?.address ?? null,
    gasWei: gas ?? null,
    gasBelowFloor: gas !== undefined && gas < config.minGasWei,
    contracts: summarise(d),
    head: await views.blockNumber(),
  });
  if (!config.dryRun && gas !== undefined && gas < config.minGasWei) {
    log.warn("gas_below_floor", { balance: gas, minGasWei: config.minGasWei, keeper: clients.account?.address });
  }

  const persist = (run: (ctx: JobContext) => Promise<void>) => async (): Promise<void> => {
    try {
      await run(ctx);
    } finally {
      saveState(statePath, state);
    }
  };
  const gasLine = async (): Promise<void> => {
    const balance = await sender.gasBalance();
    if (balance === undefined) return;
    const fields = { balance, minGasWei: config.minGasWei, keeper: clients.account?.address, stats: sender.stats };
    if (balance < config.minGasWei) log.warn("gas_below_floor", fields);
    else log.info("gas_balance", fields);
  };

  const everyJob: Job[] = [
    { name: "earn", intervalMs: config.intervals.earn, run: persist(runEarn) },
    { name: "graduation", intervalMs: 30_000, run: persist(c => runGraduation(c, clients.publicClient)) },
    { name: "seed", intervalMs: 300_000, run: persist(c => runSeed(c, clients.publicClient, clients.account)) },
    { name: "fees", intervalMs: config.intervals.fees, run: persist(ctx => runFees(ctx, clients.publicClient)) },
    { name: "register", intervalMs: config.intervals.register, run: persist(runRegister) },
    { name: "epoch", intervalMs: config.intervals.epoch, run: persist(runEpoch) },
    { name: "checkpoint", intervalMs: config.intervals.checkpoint, run: persist(runCheckpoint) },
    { name: "swapWatch", intervalMs: config.intervals.swapWatch, run: persist(runSwapWatch) },
    { name: "streamerBoundary", intervalMs: config.intervals.streamerBoundary, run: persist(runStreamerBoundary) },
    { name: "streamerDeposit", intervalMs: config.intervals.streamerDeposit, run: persist(runStreamerDeposit) },
    { name: "backstop", intervalMs: config.intervals.backstop, run: persist(runBackstop) },
    { name: "price", intervalMs: config.intervals.priceSample, run: persist(ctx => runPriceSample(ctx, clients.publicClient)) },
    ...(config.ratesEnabled ? [{ name: "rates", intervalMs: 300_000, run: persist(runRates) }] : []),
    { name: "prep", intervalMs: config.intervals.prep, run: persist((c) => runPrep(c)) },
    { name: "gas", intervalMs: 60 * 60 * 1000, run: gasLine },
  ];
  const jobs = selectJobs(everyJob, config.jobs);

  if (argv.includes("--rates-once")) {
    if (!config.ratesEnabled) throw Error("RATES_ENABLED is required");
    await persist(runRates)();
    return;
  }

  const prepFlag = argv.indexOf("--prep-epoch");
  if (prepFlag >= 0) {
    const n = argv[prepFlag + 1];
    await persist((c) => runPrep(c, true, n !== undefined && /^\d+$/.test(n) ? BigInt(n) : undefined))();
    return;
  }

  const scheduler = new Scheduler(jobs, { tickMs: config.intervals.tick, log });
  if (config.runOnce) {
    await scheduler.runAllOnce();
    log.info("keeper_done", { stats: sender.stats });
    return;
  }
  let stopping = false;
  const healthServer = createHealthServer({
    log,
    earn: url => earnHealthResponse(ctx, url),
    process: async () => {
      if (stopping) throw new Error("keeper-stopping");
      const head = await views.blockNumber();
      const failures = jobs.filter(j => (scheduler.state(j.name)?.consecutiveFailures ?? 0) > 0).map(j => j.name);
      return { ok: true, chainId, mode: config.dryRun ? "simulation" : "live", dealVault: d.addresses.DealVault, seed: d.seed ? String(d.seed.tokenId) : null, head: String(head), lastCheck: Date.now(), failures, jobs: scheduler.health(), stats: sender.stats, earn: earnHealth(ctx), earnStrategies: earnStrategyHealths(ctx), rates: config.ratesEnabled ? ctx.state.ratesHealth ?? { status: "pending" } : { status: "disabled" }, swapWatch: { cursor: state.swapCursor ?? null, lastSwapBlock: state.lastSwapBlock ?? null, lastCheckpoint: state.lastSwapCheckpoint ?? null },
        streamer: { deployed: deployment().addresses.LPStreamer !== undefined, boundary: { lastPre: state.streamerBoundary.lastPre ?? null, lastPost: state.streamerBoundary.lastPost ?? null }, lastDeposit: state.lastStreamerDeposit ?? null },
        backstop: { armed: config.backstopEnabled && config.hasKey, deals: state.backstopDeals.length, open: Object.values(state.backstop).filter(r => !r.done).map(r => r.dealId) } };
    },
  });
  if (process.env.PORT) healthServer.listen(Number(process.env.PORT), "0.0.0.0");
  scheduler.start();
  log.info("scheduler_started", { jobs: jobs.map((j) => ({ name: j.name, intervalMs: j.intervalMs })) });
  const stop = (): void => { void (async () => {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    healthServer.close();
    const drained = await scheduler.drain(20_000);
    saveState(statePath, state);
    log.info("keeper_stop", { drained, stats: sender.stats });
    process.exit(0);
  })().catch(error => {
    log.error("keeper_stop_failed", { error: safeErrorCode(error) });
    process.exit(1);
  }); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ level: "error", msg: "keeper_crashed", error: safeErrorCode(error) }) + "\n");
  process.exit(1);
});
