import { keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { ChainReader, TokenMeta } from "../chain/reader.js";
import { NATIVE, type Deployment, type Pool } from "../deployment.js";

const abi = parseAbi([
  "function VAULT() view returns(address)", "function POSM() view returns(address)", "function WETH() view returns(address)",
  "function USDG() view returns(address)", "function REGISTRY() view returns(address)",
  "function zapListingVersion() view returns(uint256)", "function memeUSDGZapVersion() view returns(uint256)",
  "function POOL_MANAGER() view returns(address)",
  "function BRIDGE() view returns(address)", "function activeEngine() view returns(address)",
  "function routingPoolAllowed(bytes32) view returns(bool)",
  "function isRouter(address) view returns(bool)", "function newDealsPaused() view returns(bool)",
  "function feeBps() view returns(uint16)", "function allowedTerms() view returns(uint32[])",
  "function getPoolConfig(bytes32) view returns((bool allowed,uint128 minLiquidity))",
  "function isMemePairAllowed(uint8) view returns(bool)", "function removalHookCodeHash(bytes32) view returns(bytes32)"
]);

export interface ZapPool {
  pool: Pool;
  token0: TokenMeta;
  token1: TokenMeta;
  baseToken: Address;
  minLiquidity: string;
}

export interface ZapStatus {
  enabled: boolean;
  reason: string | null;
  chainId: number;
  vault: Address;
  router: Address | null;
  quoter: Address | null;
  weth: Address | null;
  feeBps: number;
  terms: number[];
  items: ZapPool[];
  routingPools: Pool[];
}

export async function readZapStatus(client: PublicClient, reader: ChainReader, d: Deployment): Promise<ZapStatus> {
  const status: ZapStatus = { enabled: false, reason: "LP creation is not available on this deployment yet.", chainId: d.chainId,
    vault: d.dealVault, router: d.lpZapRouter ?? null, quoter: d.lpZapQuoter ?? null, weth: d.tokens.WETH ?? null, feeBps: 0, terms: [], items: [], routingPools: [] };
  const router = d.lpZapRouter;
  if (!router || !d.lpZapQuoter || !d.positionManager) return status;
  const blockNumber = await reader.blockNumber();
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
  const [chain, vault, pm, weth, usdg, registry, allowed, paused, fee, terms, memeStock, version, quoteManager] = await Promise.all([
    client.getChainId(), read<Address>(router, "VAULT"), read<Address>(router, "POSM"), read<Address>(router, "WETH"),
    read<Address>(router, "USDG"), read<Address>(d.dealVault, "REGISTRY"), read<boolean>(d.registry, "isRouter", [router]),
    read<boolean>(d.registry, "newDealsPaused"), read<number>(d.registry, "feeBps"), read<number[]>(d.registry, "allowedTerms"),
    read<boolean>(d.registry, "isMemePairAllowed", [0]), d.nativeV2Adapter ? Promise.resolve(1n) : read<bigint>(d.dealVault, "zapListingVersion"),
    read<Address>(d.lpZapQuoter, "POOL_MANAGER")
  ]);
  if (version !== 1n || chain !== d.chainId || vault.toLowerCase() !== d.dealVault || pm.toLowerCase() !== d.positionManager
    || usdg.toLowerCase() !== d.usdg || registry.toLowerCase() !== d.registry || quoteManager.toLowerCase() !== d.poolManager
    || (d.tokens.WETH && weth.toLowerCase() !== d.tokens.WETH)) {
    return { ...status, reason: "LP creation configuration does not match this deployment." };
  }
  if (d.nativeV2Adapter) {
    const [bridge, active] = await Promise.all([read<Address>(d.dealVault,"BRIDGE"), read<Address>(d.nativeV2Adapter,"activeEngine")]);
    if (bridge.toLowerCase() !== d.nativeV2Adapter || active.toLowerCase() !== d.dealVault) return {...status,reason:"This contract is not accepting new V2 loans."};
  }
  // Earlier zap vaults reject meme/USDG even when their registry pair flag is enabled.
  let memeUSDG = false;
  if (d.nativeV2Adapter) {
    memeUSDG = await read<boolean>(d.registry, "isMemePairAllowed", [1]);
  } else if (d.vaultVersion === 2) {
    const [capability, pairAllowed] = await Promise.all([
      read<bigint>(d.dealVault, "memeUSDGZapVersion"), read<boolean>(d.registry, "isMemePairAllowed", [1])
    ]);
    if (capability !== 1n) return { ...status, reason: "Meme/USDG zap capability is unavailable." };
    memeUSDG = pairAllowed;
  }
  status.weth = weth.toLowerCase() as Address;
  status.feeBps = Math.min(fee, 200);
  status.terms = terms.filter(t => t === 7 * 86400 || t === 21 * 86400);
  if (!allowed || paused || status.terms.length === 0) return { ...status, reason: "New LP listings are currently unavailable." };

  const rows = await Promise.all(Object.values(d.pools).map(async pool => {
    if (pool.protocol === "v3") return null;
    // Swap fees are simulated. Hook identity must still match the reviewed release.
    if (pool.hooks !== NATIVE) {
      const code = await client.getCode({ address: pool.hooks, blockNumber });
      if (!code || keccak256(code) !== d.lpZapHookCodeHashes?.[pool.poolId]) return null;
    }
    const [route, config] = await Promise.all([
      read<boolean>(router, "routingPoolAllowed", [pool.poolId]),
      read<{ allowed: boolean; minLiquidity: bigint }>(d.registry, "getPoolConfig", [pool.poolId])
    ]);
    let item: ZapPool | null = null;
    if (config.allowed && (!d.nativeV2CollateralPools || d.nativeV2CollateralPools.has(pool.poolId)) && pool.currency0 !== NATIVE && pool.currency1 !== NATIVE) {
      const [c0, c1, token0, token1] = await Promise.all([
        reader.getERC20Config(pool.currency0), reader.getERC20Config(pool.currency1),
        reader.tokenMeta(pool.currency0), reader.tokenMeta(pool.currency1)
      ]);
      let baseToken: Address | null = null;
      if (memeUSDG && pool.currency0 === d.usdg && c1.allowed && c1.lane === "MEME") baseToken = d.usdg;
      else if (memeUSDG && pool.currency1 === d.usdg && c0.allowed && c0.lane === "MEME") baseToken = d.usdg;
      else if (d.vaultVersion !== 2 && pool.currency0 === d.usdg && c1.allowed && c1.lane === "STOCK") baseToken = d.usdg;
      else if (d.vaultVersion !== 2 && pool.currency1 === d.usdg && c0.allowed && c0.lane === "STOCK") baseToken = d.usdg;
      else if (d.vaultVersion !== 2 && memeStock && c0.allowed && c1.allowed) {
        if (c0.lane === "STOCK" && c1.lane === "MEME") baseToken = pool.currency0;
        if (c1.lane === "STOCK" && c0.lane === "MEME") baseToken = pool.currency1;
      }
      const flags = BigInt(pool.hooks) & ((1n << 9n) | (1n << 8n) | 1n);
      let hookSafe = flags === 0n;
      if (flags === 1n << 8n) {
        const [approvedHash, code] = await Promise.all([
          read<Hex>(d.registry, "removalHookCodeHash", [pool.poolId]), client.getCode({ address: pool.hooks, blockNumber })
        ]);
        hookSafe = Boolean(code && code !== "0x" && keccak256(code) === approvedHash);
      }
      if (baseToken && hookSafe) item = { pool, token0, token1, baseToken, minLiquidity: config.minLiquidity.toString() };
    }
    return { route: route ? pool : null, item };
  }));
  for (const row of rows) {
    if (row?.route) status.routingPools.push(row.route);
    if (row?.item) status.items.push(row.item);
  }
  status.enabled = status.items.length > 0;
  status.reason = status.enabled ? null : "No supported LP pools are currently enabled.";
  return status;
}
