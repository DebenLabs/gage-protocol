/**
 * In-memory ChainReader, explorer and indexer fakes plus a fixture deployment with the five pools of docs/api.md.
 * Prices are round numbers so tests can reason about them: NVDA 100 USDG, NVDOG 0.001 NVDA, ETH 3000 USDG,
 * 1 ETH = 10000 GAGE, GAGE:sGAGE 1:1. USDG has 6 decimals, every other token 18.
 */
import type { Address, Hex } from "viem";
import type { PonsCurveState, ChainReader, Deal, ERC20Config, PoolPosition, PositionFeeState, PositionInfo, Slot0, TokenMeta, TransferProbeResult } from "../../src/chain/reader.js";
import { NATIVE, parseDeployment, poolIdOf, type Deployment, type PoolKey } from "../../src/deployment.js";
import type { AddressInfo, ExplorerResult, Holder } from "../../src/facts/explorer.js";
import type { IndexerPool, IndexerResult } from "../../src/indexer/client.js";
import { Q192, isqrt } from "../../src/math/fullMath.js";
import { getTickAtSqrtPrice } from "../../src/math/tickMath.js";

export const A = {
  vault: "0x00000000000000000000000000000000000000aa" as Address,
  registry: "0x00000000000000000000000000000000000000bb" as Address,
  posm: "0x00000000000000000000000000000000000000cc" as Address,
  pm: "0x00000000000000000000000000000000000000dd" as Address,
  stateView: "0x00000000000000000000000000000000000000ee" as Address,
  timelock: "0x00000000000000000000000000000000000000ff" as Address,
  USDG: "0x1000000000000000000000000000000000000001" as Address,
  NVDAx: "0x2000000000000000000000000000000000000002" as Address,
  NVDOG: "0x3000000000000000000000000000000000000003" as Address,
  GAGE: "0x4000000000000000000000000000000000000004" as Address,
  sGAGE: "0x5000000000000000000000000000000000000005" as Address,
  hook: "0x6000000000000000000000000000000000000006" as Address,
  alice: "0x7000000000000000000000000000000000000007" as Address,
  bob: "0x8000000000000000000000000000000000000008" as Address
};

/** sqrtPriceX96 for a price given as num/den (currency1 raw per currency0 raw). */
export function sqrtPriceOf(num: bigint, den: bigint): bigint {
  return isqrt((Q192 * num) / den);
}

export interface FakePool {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  lpFee: number;
}

const rawPools = {
  nvdaUsdg: { currency0: A.USDG, currency1: A.NVDAx, fee: 3000, tickSpacing: 60, hooks: NATIVE },
  nvdogNvda: { currency0: A.NVDAx, currency1: A.NVDOG, fee: 10000, tickSpacing: 200, hooks: NATIVE },
  gageSgage: { currency0: A.GAGE, currency1: A.sGAGE, fee: 30000, tickSpacing: 60, hooks: A.hook },
  gageEth: { currency0: NATIVE, currency1: A.GAGE, fee: 3000, tickSpacing: 60, hooks: NATIVE },
  usdgEth: { currency0: NATIVE, currency1: A.USDG, fee: 500, tickSpacing: 10, hooks: NATIVE }
};

export function fixtureDeploymentJson(withV4 = true): Record<string, unknown> {
  const base: Record<string, unknown> = {
    chainId: 46630,
    DealVault: A.vault,
    CollateralRegistry: A.registry,
    USDG: A.USDG,
    NVDAx: A.NVDAx,
    NVDOG: A.NVDOG
  };
  if (!withV4) return base;
  return {
    ...base,
    GAGE: A.GAGE,
    sGAGE: A.sGAGE,
    SeedTimelock: A.timelock,
    PoolManager: A.pm,
    PositionManager: A.posm,
    StateView: A.stateView,
    pools: Object.fromEntries(Object.entries(rawPools).map(([name, key]) => [name, { ...key, poolId: poolIdOf(key), createdAt: 1_700_000_000, createdBlock: 100 }]))
  };
}

export function fixtureDeployment(withV4 = true): Deployment {
  return parseDeployment(fixtureDeploymentJson(withV4));
}

export const POOL_ID = Object.fromEntries(Object.entries(rawPools).map(([n, k]) => [n, poolIdOf(k)])) as Record<keyof typeof rawPools, Hex>;

/** Default pool states: deep liquidity, round prices. */
export function defaultPoolStates(): Map<Hex, FakePool> {
  const m = new Map<Hex, FakePool>();
  // NVDA 100 USDG: 1 USDG raw (1e-6) buys 1e-8 NVDA = 1e10 NVDAx raw
  m.set(POOL_ID.nvdaUsdg, { sqrtPriceX96: sqrtPriceOf(10n ** 10n, 1n), liquidity: 10n ** 20n, lpFee: 3000 });
  // NVDOG 0.001 NVDA: 1 NVDAx raw buys 1000 NVDOG raw
  m.set(POOL_ID.nvdogNvda, { sqrtPriceX96: sqrtPriceOf(1000n, 1n), liquidity: 10n ** 22n, lpFee: 10000 });
  m.set(POOL_ID.gageSgage, { sqrtPriceX96: sqrtPriceOf(1n, 1n), liquidity: 10n ** 24n, lpFee: 30000 });
  // 1 ETH = 10000 GAGE
  m.set(POOL_ID.gageEth, { sqrtPriceX96: sqrtPriceOf(10_000n, 1n), liquidity: 10n ** 24n, lpFee: 3000 });
  // 1 ETH = 3000 USDG: USDG raw per wei = 3000e6 / 1e18 = 3e-9
  m.set(POOL_ID.usdgEth, { sqrtPriceX96: sqrtPriceOf(3n, 10n ** 9n), liquidity: 10n ** 20n, lpFee: 500 });
  return m;
}

export interface FakePosition extends PositionInfo {
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
}

export class FakeReader implements ChainReader {
  snapshotCalls = 0;
  async snapshot(): Promise<ChainReader> {
    this.snapshotCalls += 1;
    const block = await this.blockNumber();
    const fixed: ChainReader = new Proxy(this, {
      get(value, property, receiver) {
        if (property === "blockNumber") return () => Promise.resolve(block);
        if (property === "snapshot") return () => Promise.resolve(fixed);
        return Reflect.get(value, property, receiver) as unknown;
      }
    });
    return fixed;
  }
  curveState: PonsCurveState | null = null;
  async ponsCurve(): Promise<PonsCurveState> {
    if (!this.curveState) throw new Error("No fixture curve");
    return this.curveState;
  }
  block = 1000n;
  timestamp = 1_700_100_000;
  deals = new Map<bigint, Deal>();
  configs = new Map<Address, ERC20Config>();
  metas = new Map<Address, TokenMeta>([
    [A.USDG, { symbol: "USDG", name: "USD Global", decimals: 6 }],
    [A.NVDAx, { symbol: "NVDAx", name: "NVIDIA Stock Token", decimals: 18 }],
    [A.NVDOG, { symbol: "NVDOG", name: "NVDA Dog", decimals: 18 }],
    [A.GAGE, { symbol: "GAGE", name: "gage", decimals: 18 }],
    [A.sGAGE, { symbol: "sGAGE", name: "staked gage", decimals: 18 }]
  ]);
  supplies = new Map<Address, bigint>();
  supplyAt = new Map<string, bigint>();
  codes = new Map<Address, Hex>();
  storage = new Map<string, Hex>();
  pausedMap = new Map<Address, boolean | null>();
  pools: Map<Hex, FakePool> = defaultPoolStates();
  positions = new Map<bigint, FakePosition>();
  feeGrowth = new Map<string, { inside0: bigint; inside1: bigint }>();
  poolInit = new Map<Hex, { block: bigint; timestamp: number }>();
  poolPositionList = new Map<Hex, PoolPosition[]>();
  probeResult: TransferProbeResult | null = { ok: true, sentDelta: 0n, receivedDelta: 0n };
  probeCalls: Array<{ token: Address; holder: Address; to: Address; amount: bigint }> = [];

  chainId(): Promise<number> {
    return Promise.resolve(46630);
  }
  blockNumber(): Promise<bigint> {
    return Promise.resolve(this.block);
  }
  blockTimestamp(): Promise<number> {
    return Promise.resolve(this.timestamp);
  }
  getDeal(id: bigint): Promise<Deal | null> {
    return Promise.resolve(this.deals.get(id) ?? null);
  }
  getERC20Config(token: Address): Promise<ERC20Config> {
    return Promise.resolve(this.configs.get(token) ?? { allowed: false, lane: "STOCK", minAmount: 0n, maxDealRaw: 0n, maxOpenRaw: 0n });
  }
  tokenMeta(token: Address): Promise<TokenMeta> {
    if (token === NATIVE) return Promise.resolve({ symbol: "ETH", name: "Ether", decimals: 18 });
    const m = this.metas.get(token);
    if (m === undefined) return Promise.reject(new Error(`no meta for ${token}`));
    return Promise.resolve(m);
  }
  totalSupply(token: Address, block?: bigint): Promise<bigint> {
    if (block !== undefined) {
      const v = this.supplyAt.get(`${token}:${block}`);
      if (v !== undefined) return Promise.resolve(v);
    }
    return Promise.resolve(this.supplies.get(token) ?? 0n);
  }
  getCode(address: Address): Promise<Hex> {
    return Promise.resolve(this.codes.get(address) ?? "0x");
  }
  getStorageAt(address: Address, slot: Hex): Promise<Hex> {
    return Promise.resolve(this.storage.get(`${address}:${slot}`) ?? (`0x${"0".repeat(64)}` as Hex));
  }
  paused(token: Address): Promise<boolean | null> {
    return Promise.resolve(this.pausedMap.get(token) ?? null);
  }
  slot0(poolId: Hex): Promise<Slot0 | null> {
    const p = this.pools.get(poolId);
    if (p === undefined) return Promise.resolve(null);
    return Promise.resolve({ sqrtPriceX96: p.sqrtPriceX96, tick: getTickAtSqrtPrice(p.sqrtPriceX96), protocolFee: 0, lpFee: p.lpFee });
  }
  liquidity(poolId: Hex): Promise<bigint> {
    return Promise.resolve(this.pools.get(poolId)?.liquidity ?? 0n);
  }
  feeGrowthInside(poolId: Hex, tickLower: number, tickUpper: number): Promise<{ inside0: bigint; inside1: bigint }> {
    return Promise.resolve(this.feeGrowth.get(`${poolId}:${tickLower}:${tickUpper}`) ?? { inside0: 0n, inside1: 0n });
  }
  positionFeeState(_poolId: Hex, _owner: Address, _tickLower: number, _tickUpper: number, salt: Hex): Promise<PositionFeeState> {
    const p = this.positions.get(BigInt(salt));
    if (p === undefined) return Promise.resolve({ liquidity: 0n, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n });
    return Promise.resolve({ liquidity: p.liquidity, feeGrowthInside0LastX128: p.feeGrowthInside0LastX128, feeGrowthInside1LastX128: p.feeGrowthInside1LastX128 });
  }
  position(tokenId: bigint): Promise<PositionInfo | null> {
    const p = this.positions.get(tokenId);
    if (p === undefined) return Promise.resolve(null);
    return Promise.resolve({ poolKey: p.poolKey, tickLower: p.tickLower, tickUpper: p.tickUpper, hasSubscriber: p.hasSubscriber, liquidity: p.liquidity, owner: p.owner });
  }
  poolInitialised(poolId: Hex): Promise<{ block: bigint; timestamp: number } | null> {
    return Promise.resolve(this.poolInit.get(poolId) ?? null);
  }
  poolPositions(poolId: Hex): Promise<PoolPosition[]> {
    return Promise.resolve(this.poolPositionList.get(poolId) ?? []);
  }
  unlockTimes = new Map<Address, number>();
  unlockTime(owner: Address): Promise<number | null> {
    return Promise.resolve(this.unlockTimes.get(owner) ?? null);
  }
  probeTransfer(token: Address, holder: Address, to: Address, amount: bigint): Promise<TransferProbeResult | null> {
    this.probeCalls.push({ token, holder, to, amount });
    if (this.probeResult === null) return Promise.resolve(null);
    if (this.probeResult.sentDelta === 0n && this.probeResult.ok) return Promise.resolve({ ok: true, sentDelta: amount, receivedDelta: amount });
    return Promise.resolve(this.probeResult);
  }

  /** Convenience: a listed ERC-20 deal. */
  addDeal(id: bigint, token: Address, amount: bigint, cap: bigint, lane: ERC20Config["lane"], extra: Partial<Deal> = {}): Deal {
    const deal: Deal = {
      id,
      borrower: A.alice,
      kind: "ERC20",
      state: "LISTED",
      term: 7 * 86_400,
      listingExpiry: this.timestamp + 86_400,
      token,
      fundedAt: 0,
      expiry: 0,
      amountOrTokenId: amount,
      cap,
      minPrice: 0n,
      lender: NATIVE,
      price: 0n,
      fee: 0n,
      ...extra
    };
    this.deals.set(id, deal);
    this.configs.set(token, { allowed: true, lane, minAmount: 1n, maxDealRaw: 10n ** 30n, maxOpenRaw: 10n ** 32n });
    return deal;
  }

  addPositionDeal(id: bigint, tokenId: bigint, cap: bigint, poolKey: PoolKey, tickLower: number, tickUpper: number, liquidity: bigint): Deal {
    this.positions.set(tokenId, { poolKey, tickLower, tickUpper, hasSubscriber: false, liquidity, owner: A.vault, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n });
    const deal: Deal = {
      id,
      borrower: A.alice,
      kind: "UNIV4_POSITION",
      state: "LISTED",
      term: 21 * 86_400,
      listingExpiry: this.timestamp + 86_400,
      token: A.posm,
      fundedAt: 0,
      expiry: 0,
      amountOrTokenId: tokenId,
      cap,
      minPrice: 0n,
      lender: NATIVE,
      price: 0n,
      fee: 0n
    };
    this.deals.set(id, deal);
    return deal;
  }
}

export class FakeExplorer {
  holdersResult: ExplorerResult<Holder[]> = { value: null, reason: "explorer offline" };
  infoResult: ExplorerResult<AddressInfo> = { value: null, reason: "explorer offline" };
  creatorResult: ExplorerResult<{ wallet: Address; via: string }> = { value: null, reason: "explorer offline" };
  holders(): Promise<ExplorerResult<Holder[]>> {
    return Promise.resolve(this.holdersResult);
  }
  addressInfo(): Promise<ExplorerResult<AddressInfo>> {
    return Promise.resolve(this.infoResult);
  }
  creatorWallet(): Promise<ExplorerResult<{ wallet: Address; via: string }>> {
    return Promise.resolve(this.creatorResult);
  }
}

export class FakeIndexer {
  poolResult: IndexerResult<IndexerPool> = { value: null, reason: "indexer unreachable at http://localhost:42069 (test)" };
  healthResult: IndexerResult<{ ok: boolean; indexedBlock: number | null }> = { value: null, reason: "indexer unreachable" };
  pool(): Promise<IndexerResult<IndexerPool>> {
    return Promise.resolve(this.poolResult);
  }
  health(): Promise<IndexerResult<{ ok: boolean; indexedBlock: number | null }>> {
    return Promise.resolve(this.healthResult);
  }
}

export const NVDA_KEY: PoolKey = rawPools.nvdaUsdg;
export const GAGE_SGAGE_KEY: PoolKey = rawPools.gageSgage;
