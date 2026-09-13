import { readFileSync } from "node:fs";
import { isAddress, type Address, type Hex } from "viem";
import { parseDeployment, type Deployment } from "./deployment.js";

/** Explicitly published V2 engines only. These contexts quote LP creation; legacy readers keep their vaults. */
export function parseNativeZapDeployments(json: unknown): Deployment[] {
  const root = json as Record<string, unknown>;
  if (root.nativeV2 === undefined) return [];
  const v = root.nativeV2 as Record<string, unknown>;
  const address = (raw: unknown): Address => {
    if (typeof raw !== "string" || !isAddress(raw) || BigInt(raw) === 0n) throw new Error("Invalid native V2 contract");
    return raw.toLowerCase() as Address;
  };
  const adapter = address(v.adapter), quoter = address(v.zapQuoter), manager = address(v.v4Manager);
  if (!Array.isArray(v.engines) || !v.engines.length || !Array.isArray(v.routingPools) || !Array.isArray(v.pools)) throw new Error("Invalid native V2 markets");
  const pools: Record<string, unknown> = {};
  for (const raw of [...v.routingPools, ...v.pools]) {
    const p = raw as Record<string,unknown>;
    if (typeof p.poolId !== "string") throw new Error("Invalid native V2 pool");
    pools[p.poolId.toLowerCase()] = p;
  }
  const seen = new Set<string>();
  return v.engines.map(raw => {
    const e = raw as Record<string,unknown>;
    const engine = address(e.engine);
    if (seen.has(engine)) throw new Error("Duplicate native V2 engine");
    seen.add(engine);
    const d = parseDeployment({...root, nativeV2: undefined, collateralNotes: undefined, vaultVersion: 1,
      DealVault: engine, CollateralRegistry: address(e.registry), PositionManager: manager,
      LPZapRouter: address(e.zapRouter), LPZapQuoter: quoter, pools,
      lpZapHookCodeHashes: v.lpZapHookCodeHashes ?? {}});
    return {...d, nativeV2Adapter: adapter,
      ...(typeof e.grace === "number" && Number.isInteger(e.grace) && e.grace > 0 ? {grace: e.grace} : {}),
      ...(v.v3Manager && v.v3Factory ? {nativeV3Manager: address(v.v3Manager), nativeV3Factory: address(v.v3Factory)} : {}),
      nativeV2CollateralPools: new Set((v.pools as {poolId: Hex}[]).map(p=>p.poolId.toLowerCase()))};
  });
}

export function loadNativeZapDeployments(file: string): Deployment[] {
  return parseNativeZapDeployments(JSON.parse(readFileSync(file,"utf8")));
}
