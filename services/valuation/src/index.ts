/**
 * gage valuation entrypoint: Hono on PORT (default 4100), viem against RPC_URL, the deployment json for addresses,
 * Blockscout for holders, the indexer when it is up, an hourly sampler persisted under DATA_DIR.
 */
import path from "node:path";
import { seedAdmissionHistory } from "./facts/admission-history.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ViemChainReader } from "./chain/viemReader.js";
import type { ChainReader } from "./chain/reader.js";
import { loadConfig } from "./config.js";
import { hasV4, loadDeployment } from "./deployment.js";
import { ExplorerClient } from "./facts/explorer.js";
import { Sampler } from "./facts/sampler.js";
import { SampleStore } from "./facts/store.js";
import { IndexerClient } from "./indexer/client.js";
import { Pricer } from "./pricing/pricer.js";
import { readZapStatus } from "./zap/status.js";
import { zapSimulator } from "./zap/simulate.js";
import { loadNativeZapDeployments } from "./native-v2.js";
import { RatingStore } from "./ratings/store.js";

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
  console.log(`[valuation] ${new Date().toISOString()} ${line}`);
}

function main(): void {
  const config = loadConfig();
  const deployment = loadDeployment(config.deploymentFile);
  const reader = new ViemChainReader(config.rpcUrl, deployment, config.blockTtlMs);
  const pricer = new Pricer(reader, deployment);
  const store = new SampleStore(path.join(config.dataDir, `samples-${deployment.chainId}.json`));
  seedAdmissionHistory(store, deployment);
  const explorer = new ExplorerClient(config.explorerApi);
  const indexer = new IndexerClient(config.indexerUrl);
  const sampler = new Sampler(reader, pricer, deployment, store, config.sampleIntervalMs, log);
  let ratingStore: RatingStore | undefined;
  try { ratingStore = new RatingStore(path.join(config.dataDir, `ratings-${deployment.chainId}.sqlite`)); }
  catch { log("rating_evidence_store_unavailable"); }
  const zapContexts = Object.fromEntries(loadNativeZapDeployments(config.deploymentFile).map(d=>{
    const source = new ViemChainReader(config.rpcUrl,d,config.blockTtlMs);
    return [d.dealVault,{reader:source,deployment:d,
      ...(d.nativeV3Manager && d.nativeV3Factory ? {v3Reader: new ViemChainReader(config.rpcUrl, {...d, vaultVersion: 3, positionManager: d.nativeV3Manager, v3Factory: d.nativeV3Factory}, config.blockTtlMs)} : {}),
      zapStatus:(requestReader: ChainReader)=>readZapStatus(source.client,requestReader,d)}];
  }));
  const app = createApp({ reader, pricer, deployment, explorer, indexer, store, sampler, config, log,
    zapContexts, ...(ratingStore ? { ratingStore } : {}),
    zapStatus: (requestReader) => readZapStatus(reader.client, requestReader, deployment), zapSimulator: zapSimulator(reader.client) });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log("valuation_start", {
      port: info.port,
      chainId: deployment.chainId,
      rpc: "[configured]",
      deployment: config.deploymentFile,
      v4: hasV4(deployment),
      pools: Object.keys(deployment.pools),
      indexer: config.indexerUrl,
      explorer: config.explorerApi,
      samples: store.counts()
    });
    if (!hasV4(deployment)) log("no PoolManager / StateView in the deployment yet: pool-backed endpoints answer NO_POOL until the token layer is deployed");
    sampler.start();
  });

  const stop = (): void => {
    sampler.stop();
    try {
      store.save();
    } catch (e) {
      log("store_save_failed", { error: e instanceof Error ? e.message : String(e) });
    }
    server.close();
    log("valuation_stop");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
