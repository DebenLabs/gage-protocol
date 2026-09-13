import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address, type Hex } from "viem";

/** Keys of `contracts/deployments/<chainId>.json` the keeper reads. Token-layer keys are absent until M6 deploys. */
export const CONTRACT_KEYS = [
  "HybridVault",
  "HybridFees",
  "HybridReserve",
  "EarnCore",
  "DealVault",
  "CollateralRegistry",
  "FeeSink",
  "EntryRouter",
  "USDG",
  "GAGE",
  "sGAGE",
  "Drip",
  "Emissions",
  "DealRewards",
  "LPRewards",
  "LPStreamer",
  "LPStreamerDrip",
  "LPHook",
  "Buyback",
  "DealFeeRouter",
  "FeeFloor",
  "CreatorFeeSplitter",
  "ReinvestRouter",
  "SeedTimelock",
  "CompoundingSeedTimelock",
  "PoolManager",
  "PositionManager",
  "StateView",
  "WETH",
] as const;
export type ContractKey = (typeof CONTRACT_KEYS)[number];

/** Pools the token layer always deploys; the json may carry more (faucet assets), every entry is read. */
export const POOL_NAMES = ["gageSgage", "gageEth", "usdgEth", "nvdaUsdg", "nvdogNvda"] as const;
export type PoolName = (typeof POOL_NAMES)[number] | (string & {});

export interface PoolRef {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  poolId: Hex;
}

/** One Earn strategy of the release (`earnStrategies[]` of the manifest, or the flat flagship keys). Addresses are lowercase. */
export interface EarnStrategyRef {
  /** Manifest slug, the app's `/earn/<id>` route. */
  id: string;
  title: string;
  vault: Address;
  fees: Address | undefined;
  reserve: Address;
  core: Address;
  startBlock: bigint | undefined;
}
export const EARN_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const FLAGSHIP = { id: "gage-mix", title: "Gage USDG Mix" } as const;

export interface Deployment {
  lpFeeForwarders?: Address[];
  v2FeeVaults?: Address[];
  chainId: number;
  seed?: { tokenId: bigint; releaseAt: number; codeHash: Hex; owner: Address };
  pons?: { curve: Address; factory: Address };
  addresses: Partial<Record<ContractKey, Address>>;
  /** Every Earn strategy in manifest order, entry 0 the flagship; absent (fixtures) means "derive from the flat keys". */
  earnStrategies?: EarnStrategyRef[];
  pools: Partial<Record<PoolName, PoolRef>>;
  /** Optional `startBlock` key: first block worth scanning for logs. */
  startBlock: bigint | undefined;
}

/** First block of the M1 deployment per chain, used when the json has no `startBlock` and no env override. */
export const KNOWN_START_BLOCKS: Record<number, bigint> = {
  46630: 114_725_045n,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePool(name: string, v: unknown): PoolRef {
  if (!isRecord(v)) throw new Error(`pools.${name} is not an object`);
  const addr = (k: string): Address => {
    const a = v[k];
    if (typeof a !== "string" || !isAddress(a)) throw new Error(`pools.${name}.${k} is not an address`);
    return getAddress(a);
  };
  const num = (k: string): number => {
    const n = v[k];
    if (typeof n !== "number" && typeof n !== "string") throw new Error(`pools.${name}.${k} is not a number`);
    return Number(n);
  };
  const poolId = v.poolId;
  if (typeof poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
    throw new Error(`pools.${name}.poolId is not a bytes32`);
  }
  return {
    currency0: addr("currency0"),
    currency1: addr("currency1"),
    fee: num("fee"),
    tickSpacing: num("tickSpacing"),
    hooks: addr("hooks"),
    poolId: poolId as Hex,
  };
}

const lowerAddress = (v: unknown): Address | undefined => typeof v === "string" && isAddress(v) && BigInt(v) !== 0n ? (v.toLowerCase() as Address) : undefined;
const blockOf = (v: unknown): bigint | undefined => typeof v === "number" || typeof v === "string" ? BigInt(v) : undefined;

/** The single flagship the flat `HybridVault`/`HybridReserve`/`EarnCore` keys describe, or none. */
function flagshipOf(addresses: Partial<Record<ContractKey, Address>>, startBlock?: unknown): EarnStrategyRef[] {
  const vault = lowerAddress(addresses.HybridVault), reserve = lowerAddress(addresses.HybridReserve), core = lowerAddress(addresses.EarnCore);
  if (!vault || !reserve || !core) return [];
  return [{ ...FLAGSHIP, vault, fees: lowerAddress(addresses.HybridFees), reserve, core, startBlock: blockOf(startBlock) }];
}

/** Resolves `earnStrategies` per docs/api.md: the array when present, else the flat keys as the flagship; the flat keys must mirror entry 0. */
function parseEarnStrategies(json: Record<string, unknown>, addresses: Partial<Record<ContractKey, Address>>): EarnStrategyRef[] {
  const raw = json.earnStrategies;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return flagshipOf(addresses, json.earnStartBlock);
  if (!Array.isArray(raw)) throw new Error("earnStrategies is not an array");
  const list = raw.map((entry, n): EarnStrategyRef => {
    if (!isRecord(entry)) throw new Error(`earnStrategies[${n}] is not an object`);
    const id = entry.id, title = entry.title;
    if (typeof id !== "string" || !EARN_ID_PATTERN.test(id)) throw new Error(`earnStrategies[${n}].id is not a slug`);
    if (typeof title !== "string" || title.trim() === "") throw new Error(`earnStrategies[${n}].title is not a name`);
    const addr = (k: "HybridVault" | "HybridReserve" | "EarnCore"): Address => {
      const a = lowerAddress(entry[k]);
      if (!a) throw new Error(`earnStrategies[${n}].${k} is not an address`);
      return a;
    };
    const curator = isRecord(entry.earnMandate) ? lowerAddress(entry.earnMandate.curator) : undefined, deployer = lowerAddress(json.deployer);
    if (curator && deployer && curator !== deployer) throw new Error(`earnStrategies[${n}] is not curated by the deployment EOA`);
    return { id, title: title.trim(), vault: addr("HybridVault"), fees: lowerAddress(entry.HybridFees), reserve: addr("HybridReserve"), core: addr("EarnCore"), startBlock: blockOf(entry.earnStartBlock) };
  });
  for (const key of ["id", "vault"] as const) {
    if (new Set(list.map(s => s[key])).size !== list.length) throw new Error(`earnStrategies has a duplicate ${key}`);
  }
  const [first] = list, flat = flagshipOf(addresses)[0];
  if (first && flat && (flat.vault !== first.vault || flat.reserve !== first.reserve || flat.core !== first.core)) throw new Error("Flat Earn keys do not mirror earnStrategies[0]");
  return list;
}

/** Every Earn strategy of a deployment; a fixture built without `earnStrategies` derives them from its flat keys. */
export function earnStrategiesOf(d: Deployment): EarnStrategyRef[] {
  return d.earnStrategies ?? flagshipOf(d.addresses);
}

export function parseDeployment(json: unknown): Deployment {
  if (!isRecord(json)) throw new Error("deployment json is not an object");
  const chainId = Number(json.chainId);
  if (!Number.isInteger(chainId)) throw new Error("deployment json has no chainId");
  const addresses: Partial<Record<ContractKey, Address>> = {};
  for (const key of CONTRACT_KEYS) {
    const v = json[key];
    if (typeof v === "string" && isAddress(v) && BigInt(v) !== 0n) addresses[key] = getAddress(v);
  }
  const pools: Partial<Record<PoolName, PoolRef>> = {};
  if (isRecord(json.pools)) {
    for (const [name, value] of Object.entries(json.pools)) pools[name] = parsePool(name, value);
  }
  const sb = json.startBlock;
  const startBlock = typeof sb === "number" || typeof sb === "string" ? BigInt(sb) : undefined;
  const p = isRecord(json.pons) ? json.pons : null;
  const seed = isRecord(json.seed) ? json.seed : null;
  const rawForwarders = json.lpFeeForwarders ?? [];
  if (!Array.isArray(rawForwarders) || rawForwarders.length > 16 || rawForwarders.some(a => typeof a !== "string" || !isAddress(a) || BigInt(a) === 0n)) throw new Error("Invalid LP fee forwarders");
  const lpFeeForwarders = [...new Set(rawForwarders.map(a => getAddress(a as string)))];
  const native = json.nativeV2;
  if (native !== undefined && (!isRecord(native) || !Array.isArray(native.engines))) throw new Error("Invalid V2 engines");
  const v2FeeVaults: Address[] = native === undefined ? [] : (native as {engines: unknown[]}).engines.map(e => {
    if (!isRecord(e) || typeof e.engine !== "string" || !isAddress(e.engine) || BigInt(e.engine) === 0n) throw new Error("Invalid V2 fee vault");
    return getAddress(e.engine);
  });
  if (new Set(v2FeeVaults).size !== v2FeeVaults.length) throw new Error("Duplicate V2 fee vault");
  const earnStrategies = parseEarnStrategies(json, addresses);
  return { chainId, addresses, earnStrategies, pools, startBlock, lpFeeForwarders, v2FeeVaults,
    ...(p && isAddress(String(p.curve)) && isAddress(String(p.factory)) ? { pons: { curve: getAddress(String(p.curve)), factory: getAddress(String(p.factory)) } } : {}),
    ...(seed && isAddress(String(seed.owner)) && /^0x[0-9a-fA-F]{64}$/.test(String(seed.codeHash)) ? { seed: { tokenId: BigInt(String(seed.tokenId)), releaseAt: Number(seed.releaseAt), codeHash: String(seed.codeHash) as Hex, owner: getAddress(String(seed.owner)) } } : {})
  };
}

export function readDeployment(path: string): Deployment {
  return parseDeployment(JSON.parse(readFileSync(path, "utf8")));
}

/** Which of the keys we care about are present, for the startup and per-cycle log lines. */
export function summarise(d: Deployment): { present: ContractKey[]; absent: ContractKey[]; pools: PoolName[] } {
  const present = CONTRACT_KEYS.filter((k) => d.addresses[k] !== undefined);
  const absent = CONTRACT_KEYS.filter((k) => d.addresses[k] === undefined);
  const pools = Object.keys(d.pools);
  return { present, absent, pools };
}
