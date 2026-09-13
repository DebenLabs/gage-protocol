import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { envInt, envString, loadDotEnv } from "./env";
import { parseNativeV2, type NativeV2 } from "./v2-deployment";

/** Ponder chain name; also the key of `publicClients` in the API. */
export const CHAIN_NAME = "robinhood";

export const M1_KEYS = ["DealVault", "CollateralRegistry", "FeeSink", "EntryRouter", "USDG"] as const;
export const TOKEN_KEYS = [
  "WETH",
  "GAGE",
  "sGAGE",
  "Drip",
  "Emissions",
  "DealRewards",
  "LPRewards",
  "LPHook",
  "LPStreamer",
  "LPStreamerDrip",
  "Buyback",
  "DealFeeRouter",
  "CreatorFeeSplitter",
  "ReinvestRouter",
  "SeedTimelock",
  "PoolManager",
  "PositionManager",
  "StateView",
] as const;
/** Pools the token layer always deploys; the json may carry more (faucet assets), every entry is indexed. */
export const POOL_NAMES = ["gageSgage", "gageEth", "usdgEth", "nvdaUsdg", "nvdogNvda"] as const;

export type M1Key = (typeof M1_KEYS)[number];
export type TokenKey = (typeof TOKEN_KEYS)[number];
export type PoolName = (typeof POOL_NAMES)[number] | (string & {});

export type PoolDef = {
  protocol?: "v3";
  poolAddress?: Address;
  name: PoolName;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  poolId: Hex;
};

/** `core` is the Gage V2 engine the strategy lends through; it must be one of the published nativeV2 engines. */
export type EarnDeployment = { id: string; title: string; HybridVault: Address; HybridReserve: Address; core: Address; startBlock: number };
export const EARN_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type Deployment = {
  /** The flagship, entry [0] of `earnStrategies`; kept for callers that only know one strategy. */
  earn?: EarnDeployment;
  /** Every published strategy of the factory, the flagship first (docs/api.md, deployment manifest). */
  earnStrategies: EarnDeployment[];
  nativeV2?: NativeV2;
  vaultVersion?: number;
  v3Factory?: Address;
  chainId: number;
  file: string;
  startBlock: number;
  tokenStartBlock: number;
  tokenLaunchBlock?: number;
  m1: Record<M1Key, Address>;
  token: Partial<Record<TokenKey, Address>>;
  pools: PoolDef[];
};

/** M1 deployment blocks per chain, used when START_BLOCK is unset. */
const DEFAULT_START_BLOCK: Record<number, number> = { 46630: 114_725_045 };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHex32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const lower = <T extends string>(s: T): T => s.toLowerCase() as T;

function parsePool(name: PoolName, raw: unknown, file: string): PoolDef {
  if (!isRecord(raw)) throw new Error(`${file}: pools.${name} is not an object`);
  const { currency0, currency1, fee, tickSpacing, hooks, poolId } = raw;
  if (!isAddress(currency0) || !isAddress(currency1) || !isAddress(hooks) || !isHex32(poolId)) {
    throw new Error(`${file}: pools.${name} needs currency0, currency1, hooks (addresses) and poolId (bytes32)`);
  }
  if (typeof fee !== "number" || typeof tickSpacing !== "number") {
    throw new Error(`${file}: pools.${name} needs numeric fee and tickSpacing`);
  }
  if(raw.protocol === "v3" && (!isAddress(raw.poolAddress) || poolId.toLowerCase() !== "0x"+raw.poolAddress.slice(2).toLowerCase().padStart(64,"0"))) throw new Error("Invalid v3 pool identity");
  return {
    name,
    ...(raw.protocol === "v3" ? {protocol:"v3" as const,poolAddress:lower(raw.poolAddress as Address)} : {}),
    currency0: lower(currency0),
    currency1: lower(currency1),
    fee,
    tickSpacing,
    hooks: lower(hooks),
    poolId: lower(poolId),
  };
}

export function parseDeployment(text: string, file: string): Pick<Deployment, "chainId" | "m1" | "token" | "pools" | "vaultVersion" | "v3Factory" | "tokenLaunchBlock" | "nativeV2" | "earn" | "earnStrategies"> {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error(`${file}: not a JSON object`);
  const chainId = raw.chainId;
  if (typeof chainId !== "number") throw new Error(`${file}: chainId missing`);

  const m1 = {} as Record<M1Key, Address>;
  for (const key of M1_KEYS) {
    const value = raw[key];
    if (!isAddress(value)) throw new Error(`${file}: ${key} missing or not an address`);
    m1[key] = lower(value);
  }

  const token: Partial<Record<TokenKey, Address>> = {};
  for (const key of TOKEN_KEYS) {
    const value = raw[key];
    if (isAddress(value)) token[key] = lower(value);
  }

  const earnStrategies = parseEarnStrategies(raw, file);
  const earn = earnStrategies[0];

  const pools: PoolDef[] = [];
  if (isRecord(raw.pools)) {
    for (const [name, value] of Object.entries(raw.pools)) pools.push(parsePool(name, value, file));
  }
  if(raw.vaultVersion === 3 && !isAddress(raw.V3Factory)) throw new Error("V3Factory missing");
  if (raw.tokenLaunchBlock !== undefined && (!Number.isSafeInteger(raw.tokenLaunchBlock) || Number(raw.tokenLaunchBlock) <= 0)) {
    throw new Error(`${file}: tokenLaunchBlock must be a positive safe integer`);
  }
  const nativeV2 = raw.nativeV2 === undefined ? undefined : parseNativeV2(raw.nativeV2);
  for (const strategy of earnStrategies) if (!nativeV2?.engines.some(engine => lower(engine.engine) === strategy.core)) throw new Error(`${file}: EarnCore is not a published nativeV2 engine`);
  return { chainId, m1, token, pools, earnStrategies, ...(earn ? { earn } : {}), ...(nativeV2 === undefined ? {} : { nativeV2 }), ...(raw.tokenLaunchBlock === undefined ? {} : { tokenLaunchBlock: Number(raw.tokenLaunchBlock) }), vaultVersion:Number(raw.vaultVersion ?? 1), ...(isAddress(raw.V3Factory) ? {v3Factory:lower(raw.V3Factory)} : {}) };
}

let cached: Deployment | undefined;

/** Reads the deployment json once. Token-layer keys are optional so M1 alone runs today and M6 is picked up later. */
export function loadDeployment(): Deployment {
  if (cached) return cached;
  loadDotEnv();
  const chainId = envInt("CHAIN_ID", 46630);
  const file = resolve(process.cwd(), envString("DEPLOYMENT_FILE", `../../contracts/deployments/${chainId}.json`));
  const parsed = parseDeployment(readFileSync(file, "utf8"), file);
  if (parsed.chainId !== chainId) throw new Error(`${file}: chainId ${parsed.chainId} != CHAIN_ID ${chainId}`);
  const startBlock = envInt("START_BLOCK", DEFAULT_START_BLOCK[chainId] ?? 0);
  const tokenStartBlock = envInt("TOKEN_START_BLOCK", startBlock);
  cached = { ...parsed, file, startBlock, tokenStartBlock };
  return cached;
}

export function poolByName(d: Deployment, name: PoolName): PoolDef | undefined {
  return d.pools.find((p) => p.name === name);
}

/** One strategy entry: the flat flagship keys or one item of `earnStrategies`; the fee companion is read from the chain. */
function parseEarnStrategy(entry: Record<string, unknown>, file: string, deployer: unknown, fallback?: { id: string; title: string }): EarnDeployment {
  const keys = ["HybridVault", "HybridReserve", "EarnCore"] as const;
  for (const key of keys) {
    if (!isAddress(entry[key]) || /^0x0{40}$/i.test(entry[key] as string)) throw new Error(`${file}: Earn ${key} missing or invalid`);
  }
  const earnStart = entry.earnStartBlock ?? 0;
  if (!Number.isSafeInteger(earnStart) || Number(earnStart) < 0) throw new Error(`${file}: Earn start block invalid`);
  const curator = isRecord(entry.earnMandate) ? entry.earnMandate.curator : undefined;
  if (curator !== undefined && (!isAddress(curator) || !isAddress(deployer) || lower(curator as Address) !== lower(deployer as Address))) throw new Error(`${file}: Earn strategy is not curated by the deployment EOA`);
  const id = entry.id ?? fallback?.id, title = entry.title ?? fallback?.title;
  if (typeof id !== "string" || !EARN_ID_PATTERN.test(id)) throw new Error(`${file}: Earn strategy id invalid`);
  if (typeof title !== "string" || title.trim().length < 3 || title.length > 48) throw new Error(`${file}: Earn strategy title invalid`);
  return { id, title: title.trim(), HybridVault: lower(entry.HybridVault as Address), HybridReserve: lower(entry.HybridReserve as Address), core: lower(entry.EarnCore as Address), startBlock: Number(earnStart) };
}

/** `earnStrategies` when published, else the flat flagship keys as the only entry; the flat keys must mirror entry [0].
 * Only Gage-curated strategies are served: an entry whose mandate names another curator than the deployment EOA is refused. */
export function parseEarnStrategies(raw: Record<string, unknown>, file: string): EarnDeployment[] {
  const flat = ["HybridVault", "HybridReserve", "EarnCore"].some(key => raw[key] !== undefined) ? parseEarnStrategy(raw, file, raw.deployer, { id: "gage-mix", title: "Gage USDG Mix" }) : undefined;
  if (raw.earnStrategies === undefined) return flat ? [flat] : [];
  if (!Array.isArray(raw.earnStrategies) || raw.earnStrategies.length === 0) throw new Error(`${file}: Earn strategies list must not be empty`);
  const strategies = raw.earnStrategies.map(item => {
    if (!isRecord(item)) throw new Error(`${file}: Earn strategy entry invalid`);
    return parseEarnStrategy(item, file, raw.deployer);
  });
  const ids = new Set<string>(), vaults = new Set<string>();
  for (const strategy of strategies) {
    if (ids.has(strategy.id) || vaults.has(strategy.HybridVault)) throw new Error(`${file}: Earn strategies repeat an id or vault`);
    ids.add(strategy.id); vaults.add(strategy.HybridVault);
    if (strategy.HybridReserve !== strategies[0]!.HybridReserve || strategy.core !== strategies[0]!.core) throw new Error(`${file}: Earn strategies must share the factory reserve and core`);
  }
  if (flat && (flat.HybridVault !== strategies[0]!.HybridVault || flat.startBlock !== strategies[0]!.startBlock)) throw new Error(`${file}: Earn flat keys do not mirror the first strategy`);
  return strategies;
}
