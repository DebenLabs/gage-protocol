import { createConfig } from "ponder";
import { HybridVaultAbi } from "./abis/HybridVault";
import { HybridReserveAbi } from "./abis/HybridReserve";
import type { Abi, Address } from "viem";

import { DealFeeRouterAbi } from "./abis/DealFeeRouter";
import { BuybackAbi } from "./abis/Buyback";
import { CollateralRegistryAbi } from "./abis/CollateralRegistry";
import { CreatorFeeSplitterAbi } from "./abis/CreatorFeeSplitter";
import { DealRewardsAbi } from "./abis/DealRewards";
import { DealVaultAbi } from "./abis/DealVault";
import { DripAbi } from "./abis/Drip";
import { EmissionsAbi } from "./abis/Emissions";
import { EntryRouterAbi } from "./abis/EntryRouter";
import { ERC721Abi } from "./abis/ERC721";
import { FeeSinkAbi } from "./abis/FeeSink";
import { LPRewardsAbi } from "./abis/LPRewards";
import { LPStreamerAbi } from "./abis/LPStreamer";
import { PoolManagerAbi } from "./abis/PoolManager";
import { ReinvestRouterAbi } from "./abis/ReinvestRouter";
import { SeedTimelockAbi } from "./abis/SeedTimelock";
import { CHAIN_NAME, loadDeployment } from "./src/lib/deployment";
import { envInt, envString } from "./src/lib/env";
import { databaseConfig } from "./src/lib/database";
import { loadPositionHistory } from "./src/lib/position-history";
import { GageV2VaultAbi } from "./abis/v2/GageV2Vault";
import { GageV2RewardsAbi } from "./abis/v2/GageV2Rewards";
import { GageLegacyAdapterAbi } from "./abis/v2/GageLegacyAdapter";

const CHAIN = CHAIN_NAME;
type Chain = typeof CHAIN;

const deployment = loadDeployment();
const { m1, token, startBlock, tokenStartBlock } = deployment;
// Historical approved NFTs are discovered on wallet connection; new transfers remain indexed normally.
const positionHistory = deployment.vaultVersion === 3 ? undefined : loadPositionHistory(deployment.chainId, token.PositionManager, startBlock);
const positionStartBlock = positionHistory ? positionHistory.anchorBlock + 1 : envInt("POSITION_START_BLOCK", deployment.chainId === 4663 ? 0 : tokenStartBlock);

const entry = <A extends Abi>(abi: A, address: Address | undefined, from: number) =>
  address === undefined ? undefined : { chain: CHAIN as Chain, abi, address, startBlock: from };

// The deployment json carries the token layer only once M6 is deployed. Each entry is typed as present so
// `ponder.on("Drip:Granted", ...)` type-checks today, and omitted at runtime when the key is absent; the token
// handlers guard their registration on the same json (src/token.ts).
// The streamer's own Drip (D64) emits the same events as the live one; registering the one `Drip` contract at both
// addresses lets the Drip handlers and /rewards/:wallet carry its drips with no further change (docs/api.md).
const dripAddresses = [token.Drip, token.LPStreamerDrip].filter((a): a is Address => a !== undefined);
const tokenLayer = {
  Drip: dripAddresses.length === 0 ? undefined : { chain: CHAIN as Chain, abi: DripAbi, address: dripAddresses, startBlock: tokenStartBlock },
  Emissions: entry(EmissionsAbi, token.Emissions, tokenStartBlock),
  DealRewards: entry(DealRewardsAbi, token.DealRewards, tokenStartBlock),
  LPRewards: entry(LPRewardsAbi, token.LPRewards, tokenStartBlock),
  // Optional even where the rest of the token layer exists (D64).
  LPStreamer: entry(LPStreamerAbi, token.LPStreamer, tokenStartBlock),
  DealFeeRouter: entry(DealFeeRouterAbi, token.DealFeeRouter, tokenStartBlock),
  Buyback: entry(BuybackAbi, token.Buyback, tokenStartBlock),
  CreatorFeeSplitter: entry(CreatorFeeSplitterAbi, token.CreatorFeeSplitter, tokenStartBlock),
  ReinvestRouter: entry(ReinvestRouterAbi, token.ReinvestRouter, tokenStartBlock),
  SeedTimelock: entry(SeedTimelockAbi, token.SeedTimelock, tokenStartBlock),
  PositionManager: deployment.vaultVersion === 3 ? undefined : entry(ERC721Abi, token.PositionManager, positionStartBlock),
  PoolManager:
    token.PoolManager === undefined || deployment.pools.filter(p=>p.protocol!=="v3").length === 0
      ? undefined
      : {
          chain: CHAIN as Chain,
          abi: PoolManagerAbi,
          address: token.PoolManager,
          startBlock: tokenStartBlock,
          filter: (["Initialize", "ModifyLiquidity", "Swap"] as const).map((event) => ({
            event,
            args: { id: deployment.pools.filter(p=>p.protocol!=="v3").map((p) => p.poolId) },
          })),
        },
};

type Present<T> = { [K in keyof T]: NonNullable<T[K]> };
const presentTokenLayer = Object.fromEntries(
  Object.entries(tokenLayer).filter(([, v]) => v !== undefined),
) as Present<typeof tokenLayer>;

const v2 = deployment.nativeV2;
const v2Start = v2 ? Math.min(...v2.engines.map(e => e.startBlock)) : 0;
const v2Layer = {
  GageV2Vault: v2 ? {chain: CHAIN as Chain, abi: GageV2VaultAbi, address: v2.engines.map(e => e.engine), startBlock: v2Start} : undefined,
  GageV2Rewards: v2 ? {chain: CHAIN as Chain, abi: GageV2RewardsAbi, address: v2.engines.map(e => e.rewards), startBlock: v2Start} : undefined,
  GageLegacyAdapter: v2 ? {chain: CHAIN as Chain, abi: GageLegacyAdapterAbi, address: v2.adapter, startBlock: v2Start} : undefined,
};
const presentV2 = Object.fromEntries(Object.entries(v2Layer).filter(([,value]) => value !== undefined)) as Present<typeof v2Layer>;

// Every published strategy of the factory indexes from the earliest instance; they share one reserve.
const earnStrategies = deployment.earnStrategies;
const earnStart = earnStrategies.length ? Math.min(...earnStrategies.map(s => s.startBlock)) : 0;
const earnLayer = {
  HybridVault: earnStrategies.length ? { chain: CHAIN as Chain, abi: HybridVaultAbi, address: earnStrategies.map(s => s.HybridVault), startBlock: earnStart } : undefined,
  HybridReserve: entry(HybridReserveAbi, earnStrategies[0]?.HybridReserve, earnStart),
};
const presentEarn = Object.fromEntries(Object.entries(earnLayer).filter(([, value]) => value !== undefined)) as Present<typeof earnLayer>;
// Event handlers reconcile and publish their own changes within Ponder's block transaction.
// Keep periodic block sampling sparse: interval 1 would fetch every historical block header on rebuild.
const earnSnapshotInterval = envInt("EARN_SNAPSHOT_INTERVAL", 100);
if (earnSnapshotInterval < 1) throw new Error("EARN_SNAPSHOT_INTERVAL must be positive");
const earnBlocks = earnStrategies.length ? { EarnSnapshot: { chain: CHAIN, startBlock: earnStart, interval: earnSnapshotInterval } } : {};

const rpc = envString("RPC_URL", "https://rpc.testnet.chain.robinhood.com");
const ws = envString("RPC_WS_URL", "");

export default createConfig({
  database: databaseConfig(),
  chains: {
    [CHAIN]: {
      id: deployment.chainId,
      rpc,
      ...(ws === "" ? {} : { ws }),
      // ~100 ms blocks on an Orbit chain; one second keeps the RPC budget sane without falling far behind.
      pollingInterval: 1_000,
    },
  },
  blocks: earnBlocks as { EarnSnapshot: { chain: Chain; startBlock: number; interval: number } },
  contracts: {
    DealVault: { chain: CHAIN, abi: DealVaultAbi, address: m1.DealVault, startBlock },
    CollateralRegistry: { chain: CHAIN, abi: CollateralRegistryAbi, address: m1.CollateralRegistry, startBlock },
    FeeSink: { chain: CHAIN, abi: FeeSinkAbi, address: m1.FeeSink, startBlock },
    EntryRouter: { chain: CHAIN, abi: EntryRouterAbi, address: m1.EntryRouter, startBlock },
    ...presentTokenLayer,
    ...presentV2,
    ...presentEarn,
  },
});
