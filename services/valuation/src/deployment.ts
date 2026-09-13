/**
 * Reads contracts/deployments/<chainId>.json. M1 keys are required; the token layer (PoolManager, PositionManager,
 * StateView, pools) is optional and every consumer degrades to NO_POOL while it is absent.
 */
import { readFileSync } from "node:fs";
import { encodeAbiParameters, isAddress, keccak256, pad, type Address, type Hex } from "viem";

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

export interface PoolKey {
  protocol?: "v3";
  poolAddress?: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface Pool extends PoolKey {
  name: string;
  poolId: Hex;
  /** Optional: unix seconds / block the deploy script recorded for the Initialize call. */
  createdAt: number | null;
  createdBlock: number | null;
}

export interface Deployment {
  /** Internal context for published native V2 LP quotes, never used to reinterpret legacy deals. */
  nativeV2Adapter?: Address;
  nativeV3Manager?: Address;
  nativeV3Factory?: Address;
  nativeV2CollateralPools?: Set<string>;
  /** Exact-token admission disclosures. These do not change automated eligibility. */
  collateralNotes?: Record<string, { poolId: Hex; note: string }>;
  lpZapRouter?: Address;
  lpZapQuoter?: Address;
  lpZapHookCodeHashes?: Record<string, Hex>;
  /** Seconds after the loan term during which the borrower can still repay before lenders may finalize. */
  grace?: number;
  vaultVersion?: 1 | 2 | 3;
  v3Factory?: Address;
  chainId: number;
  dealVault: Address;
  registry: Address;
  usdg: Address;
  tokens: Record<string, Address>;
  poolManager: Address | null;
  positionManager: Address | null;
  stateView: Address | null;
  seedTimelock: Address | null;
  pools: Record<string, Pool>;
  pons?: { curve: Address; factory: Address; hookFeePips: number };
}

type Json = Record<string, unknown>;

function addr(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v)) throw new Error(`deployment: ${what} is not an address`);
  return v.toLowerCase() as Address;
}

function optAddr(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v) ? (v.toLowerCase() as Address) : null;
}

export function poolIdOf(key: PoolKey): Hex {
  if (key.protocol === "v3") {
    if (!key.poolAddress) throw new Error("v3 pool address missing");
    return pad(key.poolAddress.toLowerCase() as Hex, {size:32});
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" }
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

function parsePool(name: string, raw: unknown): Pool {
  if (typeof raw !== "object" || raw === null) throw new Error(`deployment: pool ${name} is not an object`);
  const p = raw as Json;
  const key: PoolKey = {
    ...(p.protocol === "v3" ? {protocol:"v3" as const, poolAddress:addr(p.poolAddress, `pools.${name}.poolAddress`)} : {}),
    currency0: addr(p.currency0, `pools.${name}.currency0`),
    currency1: addr(p.currency1, `pools.${name}.currency1`),
    fee: Number(p.fee),
    tickSpacing: Number(p.tickSpacing),
    hooks: optAddr(p.hooks) ?? NATIVE
  };
  if (!Number.isInteger(key.fee) || !Number.isInteger(key.tickSpacing) || key.tickSpacing <= 0) {
    throw new Error(`deployment: pool ${name} has a bad fee or tickSpacing`);
  }
  const computed = poolIdOf(key);
  const given = typeof p.poolId === "string" ? (p.poolId.toLowerCase() as Hex) : null;
  if (given !== null && given !== computed) {
    throw new Error(`deployment: pool ${name} poolId ${given} does not match its key (${computed})`);
  }
  const createdAt = typeof p.createdAt === "number" ? p.createdAt : null;
  const createdBlock = typeof p.createdBlock === "number" ? p.createdBlock : null;
  return { name, ...key, poolId: computed, createdAt, createdBlock };
}

export function parseDeployment(json: unknown): Deployment {
  if (typeof json !== "object" || json === null) throw new Error("deployment: not an object");
  const d = json as Json;
  const chainId = Number(d.chainId);
  if (!Number.isInteger(chainId)) throw new Error("deployment: chainId missing");
  const pools: Record<string, Pool> = {};
  if (typeof d.pools === "object" && d.pools !== null) {
    for (const [name, raw] of Object.entries(d.pools as Json)) pools[name] = parsePool(name, raw);
  }
  const tokens: Record<string, Address> = {};
  const collateralNotes: NonNullable<Deployment["collateralNotes"]> = {};
  if (d.collateralNotes !== undefined) {
    if (typeof d.collateralNotes !== "object" || d.collateralNotes === null || Array.isArray(d.collateralNotes)) throw new Error("deployment: bad collateral notes");
    for (const [token, rawNote] of Object.entries(d.collateralNotes)) {
      if (typeof rawNote !== "object" || rawNote === null) throw new Error("deployment: bad collateral note");
      const entry = rawNote as Json;
      const tokenAddress = addr(token, "collateral note token");
      const pool = Object.values(pools).find(p => p.poolId === String(entry.poolId).toLowerCase());
      if (!pool || (pool.currency0 !== tokenAddress && pool.currency1 !== tokenAddress)) throw new Error("deployment: collateral note pool mismatch");
      if (typeof entry.note !== "string" || entry.note.trim().length < 20 || entry.note.length > 1000) throw new Error("deployment: bad collateral note");
      collateralNotes[tokenAddress] = { poolId: pool.poolId, note: entry.note.trim() };
    }
  }
  for (const key of ["USDG", "NVDAx", "NVDOG", "AAPLx", "TSLAx", "MSFTx", "APEPE", "MOON", "GAGE", "sGAGE", "WETH"]) {
    const a = optAddr(d[key]);
    if (a !== null) tokens[key] = a;
  }
  const pons = d.pons as Json | undefined;
  const hookFeePips = pons ? Number(pons.hookFeePips) : 0;
  if (pons && (!Number.isInteger(hookFeePips) || hookFeePips < 0 || hookFeePips >= 1_000_000)) throw new Error("deployment: bad Pons hook fee");
  return {
    ...(Object.keys(collateralNotes).length ? { collateralNotes } : {}),
    ...(optAddr(d.LPZapRouter) ? { lpZapRouter: optAddr(d.LPZapRouter)! } : {}),
    ...(optAddr(d.LPZapQuoter) ? { lpZapQuoter: optAddr(d.LPZapQuoter)! } : {}),
    ...(typeof d.lpZapHookCodeHashes === "object" && d.lpZapHookCodeHashes !== null ? { lpZapHookCodeHashes: d.lpZapHookCodeHashes as Record<string, Hex> } : {}),
    ...(pons ? { pons: { curve: addr(pons.curve, "pons.curve"), factory: addr(pons.factory, "pons.factory"), hookFeePips } } : {}),
    chainId,
    vaultVersion: d.vaultVersion === 3 ? 3 : d.vaultVersion === 2 ? 2 : 1,
    ...(d.vaultVersion === 3 ? {v3Factory:addr(d.V3Factory,"V3Factory")} : {}),
    dealVault: addr(d.DealVault, "DealVault"),
    registry: addr(d.CollateralRegistry, "CollateralRegistry"),
    usdg: addr(d.USDG, "USDG"),
    tokens,
    poolManager: optAddr(d.PoolManager),
    positionManager: optAddr(d.PositionManager),
    stateView: optAddr(d.StateView),
    seedTimelock: optAddr(d.SeedTimelock),
    pools
  };
}

export function loadDeployment(file: string): Deployment {
  return parseDeployment(JSON.parse(readFileSync(file, "utf8")));
}

/** True when the v4 reads are possible at all. */
export function hasV4(d: Deployment): d is Deployment & { poolManager: Address; stateView: Address } {
  return d.poolManager !== null && d.stateView !== null;
}

export function findPool(d: Deployment, nameOrId: string): Pool | null {
  const byName = d.pools[nameOrId];
  if (byName !== undefined) return byName;
  const lower = nameOrId.toLowerCase();
  for (const p of Object.values(d.pools)) if (p.poolId === lower) return p;
  return null;
}

export function poolsWith(d: Deployment, token: Address): Pool[] {
  const t = token.toLowerCase();
  return Object.values(d.pools).filter((p) => p.currency0 === t || p.currency1 === t);
}
