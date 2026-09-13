/**
 * gage notifier entrypoint: Hono on PORT (default 4200), SQLite subscriptions, a poller against the indexer.
 */
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { createPublicClient, http, verifyMessage } from "viem";
import { createApp } from "./app.js";
import { readUsdgAddress, rpcWalletUSDG } from "./balances.js";
import { buildChannels } from "./channels/index.js";
import { describeConfig, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeIndexer } from "./indexer.js";
import { createLogger } from "./log.js";
import { Poller } from "./poller.js";
import type { Verifier } from "./auth.js";

function main(): void {
  const { config, secrets } = loadConfig(process.env);
  const log = createLogger({ service: "notifier" }, { level: config.logLevel });
  const db = openDb(config.dbPath);
  const { channels, telegram } = buildChannels(config, secrets, log);
  const indexer = makeIndexer({ baseUrl: config.indexerUrl, timeoutMs: config.indexerTimeoutMs });

  // With an RPC the check also accepts ERC-1271 smart-wallet signatures; without one, EOA signatures only.
  const verify: Verifier =
    config.rpcUrl === undefined
      ? (args) => verifyMessage(args)
      : ((client) => (args) => client.verifyMessage(args))(createPublicClient({ transport: http(config.rpcUrl) }));

  // The T−24h line says what the wallet holds when there is an RPC and a USDG address to read it from.
  const usdg = readUsdgAddress(resolve(process.cwd(), config.deploymentFile));
  const walletUSDG =
    config.rpcUrl !== undefined && usdg !== undefined
      ? rpcWalletUSDG(config.rpcUrl, usdg, (error) => log.warn("wallet_balance_failed", { error: error.slice(0, 200) }))
      : undefined;

  const poller = new Poller({ db, indexer, channels, config, log, walletUSDG });
  const app = createApp({ db, channels, config, verify, log, poller: () => poller.status, telegram });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info("notifier_start", { ...describeConfig(config), usdg: usdg ?? null, walletBalanceLine: walletUSDG !== undefined, address: info.address, port: info.port });
    poller.start();
  });

  const stop = (): void => {
    poller.stop();
    server.close();
    db.close();
    log.info("notifier_stop");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
