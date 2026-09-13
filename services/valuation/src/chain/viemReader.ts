import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseEventLogs,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient
} from "viem";
import { dealVaultAbi, dealVaultLegacyAbi, erc20Abi, poolManagerEventsAbi, positionManagerAbi, registryAbi, stateViewAbi, transferProbeAbi, transferProbeBytecode, unlockAbi } from "../abi/index.js";
import { BlockCache, ForeverCache } from "../cache.js";
import type { Deployment, PoolKey } from "../deployment.js";
import { NATIVE } from "../deployment.js";
import { ApiError } from "../errors.js";
import {
  KIND_NAMES,
  LANE_NAMES,
  STATE_NAMES,
  type ChainReader,
  type PonsCurveState,
  type Deal,
  type ERC20Config,
  type PoolPosition,
  type PositionFeeState,
  type PositionInfo,
  type Slot0,
  type TokenMeta,
  type TransferProbeResult
} from "./reader.js";

import { v3ManagerAbi, v3PoolAbi, v3FactoryAbi } from "../abi/v3.js";
import { wrappingSub256 } from "../math/fullMath.js";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11" as const;

function signExtend24(v: bigint): number {
  const masked = v & 0xffffffn;
  return Number(masked >= 0x800000n ? masked - 0x1000000n : masked);
}

/** Unpack PositionInfo (v4-periphery PositionInfoLibrary): 200 bits poolId | 24 tickUpper | 24 tickLower | 8 hasSubscriber. */
export function unpackPositionInfo(info: bigint): { tickLower: number; tickUpper: number; hasSubscriber: boolean } {
  return {
    hasSubscriber: (info & 0xffn) !== 0n,
    tickLower: signExtend24(info >> 8n),
    tickUpper: signExtend24(info >> 32n)
  };
}

function wrapRpc<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (e instanceof ApiError) throw e;
    const message = e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
    throw new ApiError("RPC_ERROR", `chain read failed: ${message}`);
  });
}

export class ViemChainReader implements ChainReader {
  readonly client: PublicClient;
  private readonly blocks: BlockCache;
  private readonly forever: ForeverCache;
  private readonly fixedBlock: bigint | null;
  private readonly snapshotCaches: Map<bigint, BlockCache>;

  constructor(
    rpcUrl: string,
    private readonly deployment: Deployment,
    blockTtlMs: number,
    snapshot?: { client: PublicClient; block: bigint; blocks?: BlockCache; forever: ForeverCache; caches?: Map<bigint, BlockCache> }
  ) {
    this.client = snapshot?.client ?? createPublicClient({
      transport: http(rpcUrl, { batch: true, timeout: 20_000, retryCount: 2 }),
      batch: { multicall: { wait: 8 } }
    });
    this.fixedBlock = snapshot?.block ?? null;
    this.forever = snapshot?.forever ?? new ForeverCache();
    this.snapshotCaches = snapshot?.caches ?? new Map();
    this.blocks = snapshot?.blocks ?? (this.fixedBlock === null
      ? new BlockCache(() => this.client.getBlockNumber({ cacheTime: 0 }), blockTtlMs)
      : new BlockCache(() => Promise.resolve(this.fixedBlock!), Number.MAX_SAFE_INTEGER));
  }

  async snapshot(): Promise<ChainReader> {
    if (this.fixedBlock !== null) return this;
    const block = await this.blockNumber();
    let blocks = this.snapshotCaches.get(block);
    if (blocks === undefined) {
      blocks = new BlockCache(() => Promise.resolve(block), Number.MAX_SAFE_INTEGER);
      while (this.snapshotCaches.size >= 4) {
        const oldest = this.snapshotCaches.keys().next().value as bigint | undefined;
        if (oldest === undefined) break;
        this.snapshotCaches.delete(oldest);
      }
      this.snapshotCaches.set(block, blocks);
    }
    return new ViemChainReader("", this.deployment, 0, { client: this.client, block, blocks, forever: this.forever, caches: this.snapshotCaches });
  }

  ponsCurve(curve: Address): Promise<PonsCurveState> {
    const abi = parseAbi([
      "function graduated() view returns(bool)",
      "function quoteReserve() view returns(uint256)",
      "function tokenReserve() view returns(uint256)",
      "function realQuoteReserve() view returns(uint256)",
      "function sellableTokens() view returns(uint256)",
      "function feeBps() view returns(uint256)"
    ]);
    return this.memo(`pons:${curve}`, async (block) => {
      const [graduated, quoteReserve, tokenReserve, realQuoteReserve, sellableTokens, feeBps] = await Promise.all([
        this.client.readContract({ address: curve, abi, functionName: "graduated", blockNumber: block }),
        this.client.readContract({ address: curve, abi, functionName: "quoteReserve", blockNumber: block }),
        this.client.readContract({ address: curve, abi, functionName: "tokenReserve", blockNumber: block }),
        this.client.readContract({ address: curve, abi, functionName: "realQuoteReserve", blockNumber: block }),
        this.client.readContract({ address: curve, abi, functionName: "sellableTokens", blockNumber: block }),
        this.client.readContract({ address: curve, abi, functionName: "feeBps", blockNumber: block })
      ]);
      return { graduated, quoteReserve, tokenReserve, realQuoteReserve, sellableTokens, feeBps: Number(feeBps), block };
    });
  }

  chainId(): Promise<number> {
    return this.forever.memo("chainId", () => wrapRpc(this.client.getChainId()));
  }

  blockNumber(): Promise<bigint> {
    return wrapRpc(this.blocks.blockNumber());
  }

  blockTimestamp(block: bigint): Promise<number> {
    return this.forever.memo(`ts:${block}`, async () => Number((await wrapRpc(this.client.getBlock({ blockNumber: block }))).timestamp));
  }

  private memo<T>(key: string, fn: (block: bigint) => Promise<T>): Promise<T> {
    return wrapRpc(this.blocks.memo(key, fn));
  }

  /** Raw call so the 13-word (pre-`fee`) and 14-word Deal shapes both decode; the missing fee reads as 0. */
  private async readDeal(id: bigint, blockNumber: bigint): Promise<{ d: ReturnType<typeof decodeFunctionResult<typeof dealVaultAbi, "getDeal">>; legacy: boolean }> {
    const data = encodeFunctionData({ abi: dealVaultAbi, functionName: "getDeal", args: [id] });
    const { data: ret } = await this.client.call({ to: this.deployment.dealVault, data, blockNumber });
    if (ret === undefined || ret === "0x") throw new ApiError("RPC_ERROR", "getDeal returned no data");
    const words = (ret.length - 2) / 64;
    if (words === 13) {
      const d = decodeFunctionResult({ abi: dealVaultLegacyAbi, functionName: "getDeal", data: ret });
      return { d: { ...d, fee: 0n }, legacy: true };
    }
    return { d: decodeFunctionResult({ abi: dealVaultAbi, functionName: "getDeal", data: ret }), legacy: false };
  }

  getDeal(id: bigint): Promise<Deal | null> {
    return this.memo(`deal:${id}`, async (blockNumber) => {
      const { d } = await this.readDeal(id, blockNumber);
      const state = STATE_NAMES[d.state];
      const kind = KIND_NAMES[d.kind];
      if (state === undefined || state === "NONE" || kind === undefined) return null;
      return {
        id,
        borrower: d.borrower.toLowerCase() as Address,
        kind,
        state,
        term: d.term,
        listingExpiry: Number(d.listingExpiry),
        token: d.token.toLowerCase() as Address,
        fundedAt: Number(d.fundedAt),
        expiry: Number(d.expiry),
        amountOrTokenId: d.amountOrTokenId,
        cap: d.cap,
        minPrice: d.minPrice,
        lender: d.lender.toLowerCase() as Address,
        price: d.price,
        fee: d.fee
      };
    });
  }

  memePairMask(): Promise<number> {
    return this.memo("memePairMask", (blockNumber) => this.client.readContract({ address: this.deployment.registry,
      abi: parseAbi(["function memePairMask() view returns(uint8)"]), functionName: "memePairMask", blockNumber }));
  }

  getERC20Config(token: Address): Promise<ERC20Config> {
    return this.memo(`cfg:${token}`, async (blockNumber) => {
      const c = await this.client.readContract({ address: this.deployment.registry, abi: registryAbi, functionName: "getERC20Config", args: [token], blockNumber });
      return { allowed: c.allowed, lane: LANE_NAMES[c.lane] ?? "STOCK", minAmount: c.minAmount, maxDealRaw: c.maxDealRaw, maxOpenRaw: c.maxOpenRaw };
    });
  }

  tokenMeta(token: Address): Promise<TokenMeta> {
    if (token === NATIVE) return Promise.resolve({ symbol: "ETH", name: "Ether", decimals: 18 });
    const read = async (blockNumber?: bigint): Promise<TokenMeta> => {
      const [decimals, symbol, name] = await Promise.all([
        this.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber }),
        this.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol", blockNumber }).catch(() => "?"),
        this.client.readContract({ address: token, abi: erc20Abi, functionName: "name", blockNumber }).catch(() => "?")
      ]);
      return { decimals: Number(decimals), symbol, name };
    };
    if (this.fixedBlock !== null) return this.memo(`meta:${token}`, read);
    return this.forever.memo(`meta:${token}`, () => wrapRpc(read()));
  }

  totalSupply(token: Address, block?: bigint): Promise<bigint> {
    if (block !== undefined) {
      return this.forever.memo(`supply:${token}:${block}`, () =>
        wrapRpc(this.client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber: block }))
      );
    }
    return this.memo(`supply:${token}`, (blockNumber) => this.client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber }));
  }

  getCode(address: Address): Promise<Hex> {
    if (this.fixedBlock !== null) return this.memo(`code:${address}`, async (blockNumber) => (await this.client.getCode({ address, blockNumber })) ?? "0x");
    return this.forever.memo(`code:${address}`, async () => (await wrapRpc(this.client.getCode({ address }))) ?? "0x");
  }

  getStorageAt(address: Address, slot: Hex): Promise<Hex> {
    return this.memo(`slot:${address}:${slot}`, async (blockNumber) => (await this.client.getStorageAt({ address, slot, blockNumber })) ?? "0x");
  }

  paused(token: Address): Promise<boolean | null> {
    return this.memo(`paused:${token}`, (blockNumber) =>
      this.client.readContract({ address: token, abi: erc20Abi, functionName: "paused", blockNumber }).catch(() => null)
    );
  }

  private stateView(): Address {
    if (this.deployment.stateView === null) throw new ApiError("NO_POOL", "StateView is not in the deployment yet");
    return this.deployment.stateView;
  }

  private v3Pool(poolId: Hex) { return Object.values(this.deployment.pools).find(p => p.protocol === "v3" && p.poolId === poolId); }

  slot0(poolId: Hex): Promise<Slot0 | null> {
    return this.memo(`slot0:${poolId}`, async (blockNumber) => {
      const p = this.v3Pool(poolId);
      if (p?.poolAddress) {
        const s = await this.client.readContract({address:p.poolAddress,abi:v3PoolAbi,functionName:"slot0",blockNumber});
        return s[0] === 0n ? null : {sqrtPriceX96:s[0],tick:s[1],protocolFee:s[5],lpFee:p.fee};
      }
      const [sqrtPriceX96, tick, protocolFee, lpFee] = await this.client.readContract({ address: this.stateView(), abi: stateViewAbi, functionName: "getSlot0", args: [poolId], blockNumber });
      if (sqrtPriceX96 === 0n) return null; // pool not initialised
      return { sqrtPriceX96, tick, protocolFee, lpFee };
    });
  }

  liquidity(poolId: Hex): Promise<bigint> {
    const p=this.v3Pool(poolId);
    if(p?.poolAddress) return this.memo(`liq:${poolId}`, blockNumber => this.client.readContract({address:p.poolAddress!,abi:v3PoolAbi,functionName:"liquidity",blockNumber}));
    return this.memo(`liq:${poolId}`, (blockNumber) => this.client.readContract({ address: this.stateView(), abi: stateViewAbi, functionName: "getLiquidity", args: [poolId], blockNumber }));
  }

  feeGrowthInside(poolId: Hex, tickLower: number, tickUpper: number): Promise<{ inside0: bigint; inside1: bigint }> {
    return this.memo(`fgi:${poolId}:${tickLower}:${tickUpper}`, async (blockNumber) => {
      const p=this.v3Pool(poolId);
      if(p?.poolAddress) {
        const address=p.poolAddress, abi=v3PoolAbi;
        const [s,g0,g1,lo,hi]=await Promise.all([
          this.client.readContract({address,abi,functionName:"slot0",blockNumber}),
          this.client.readContract({address,abi,functionName:"feeGrowthGlobal0X128",blockNumber}),
          this.client.readContract({address,abi,functionName:"feeGrowthGlobal1X128",blockNumber}),
          this.client.readContract({address,abi,functionName:"ticks",args:[tickLower],blockNumber}),
          this.client.readContract({address,abi,functionName:"ticks",args:[tickUpper],blockNumber})
        ]);
        const inside=(g:bigint,l:bigint,h:bigint)=>wrappingSub256(wrappingSub256(g,s[1]>=tickLower?l:wrappingSub256(g,l)),s[1]<tickUpper?h:wrappingSub256(g,h));
        return {inside0:inside(g0,lo[2],hi[2]),inside1:inside(g1,lo[3],hi[3])};
      }
      const [inside0, inside1] = await this.client.readContract({ address: this.stateView(), abi: stateViewAbi, functionName: "getFeeGrowthInside", args: [poolId, tickLower, tickUpper], blockNumber });
      return { inside0, inside1 };
    });
  }

  positionFeeState(poolId: Hex, owner: Address, tickLower: number, tickUpper: number, salt: Hex): Promise<PositionFeeState> {
    return this.memo(`pfs:${poolId}:${owner}:${tickLower}:${tickUpper}:${salt}`, async (blockNumber) => {
      if(this.v3Pool(poolId)) {
        if(owner.toLowerCase()!==this.deployment.positionManager) throw new ApiError("NO_POOL","Wrong v3 position manager");
        const p=await this.client.readContract({address:owner,abi:v3ManagerAbi,functionName:"positions",args:[BigInt(salt)],blockNumber});
        return {liquidity:p[7],feeGrowthInside0LastX128:p[8],feeGrowthInside1LastX128:p[9],tokensOwed0:p[10],tokensOwed1:p[11]};
      }
      const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = await this.client.readContract({
        address: this.stateView(),
        abi: stateViewAbi,
        functionName: "getPositionInfo",
        args: [poolId, owner, tickLower, tickUpper, salt],
        blockNumber
      });
      return { liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128 };
    });
  }

  position(tokenId: bigint): Promise<PositionInfo | null> {
    const pm = this.deployment.positionManager;
    if (pm === null) throw new ApiError("NO_POOL", "PositionManager is not in the deployment yet");
    return this.memo(`pos:${tokenId}`, async (blockNumber) => {
      if(this.deployment.vaultVersion===3) {
        const [p,owner,factory]=await Promise.all([
          this.client.readContract({address:pm,abi:v3ManagerAbi,functionName:"positions",args:[tokenId],blockNumber}),
          this.client.readContract({address:pm,abi:v3ManagerAbi,functionName:"ownerOf",args:[tokenId],blockNumber}),
          this.client.readContract({address:pm,abi:v3ManagerAbi,functionName:"factory",blockNumber})
        ]);
        if(factory.toLowerCase()!==this.deployment.v3Factory) throw new ApiError("NO_POOL","V3 factory mismatch");
        const poolAddress=await this.client.readContract({address:factory,abi:v3FactoryAbi,functionName:"getPool",args:[p[2],p[3],p[4]],blockNumber});
        const pool=Object.values(this.deployment.pools).find(x=>x.protocol==="v3"&&x.poolAddress===poolAddress.toLowerCase());
        if(!pool||pool.currency0!==p[2].toLowerCase()||pool.currency1!==p[3].toLowerCase()||pool.fee!==p[4]) throw new ApiError("NO_POOL","Unsupported v3 pool");
        return {poolKey:pool,tickLower:p[5],tickUpper:p[6],hasSubscriber:false,liquidity:p[7],owner:owner.toLowerCase() as Address};
      }
      const [[key, info], liquidity, owner] = await Promise.all([
        this.client.readContract({ address: pm, abi: positionManagerAbi, functionName: "getPoolAndPositionInfo", args: [tokenId], blockNumber }),
        this.client.readContract({ address: pm, abi: positionManagerAbi, functionName: "getPositionLiquidity", args: [tokenId], blockNumber }),
        this.client.readContract({ address: pm, abi: positionManagerAbi, functionName: "ownerOf", args: [tokenId], blockNumber }).catch(() => null)
      ]);
      if (info === 0n) return null;
      const poolKey: PoolKey = {
        currency0: key.currency0.toLowerCase() as Address,
        currency1: key.currency1.toLowerCase() as Address,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks.toLowerCase() as Address
      };
      return { poolKey, ...unpackPositionInfo(info), liquidity, owner: owner === null ? null : (owner.toLowerCase() as Address) };
    });
  }

  poolInitialised(poolId: Hex): Promise<{ block: bigint; timestamp: number } | null> {
    const p=this.v3Pool(poolId);
    if(p) return Promise.resolve(p.createdBlock && p.createdAt ? {block:BigInt(p.createdBlock),timestamp:p.createdAt} : null);
    const pm = this.deployment.poolManager;
    if (pm === null) return Promise.resolve(null);
    return this.memo(`init:${poolId}`, async (blockNumber) => {
      const logs = await wrapRpc(
        this.client.getLogs({
          address: pm,
          event: poolManagerEventsAbi[0],
          args: { id: poolId },
          fromBlock: 0n,
          toBlock: blockNumber
        })
      );
      const first = logs[0];
      if (first === undefined) return null;
      return { block: first.blockNumber, timestamp: await this.blockTimestamp(first.blockNumber) };
    });
  }

  poolPositions(poolId: Hex): Promise<PoolPosition[]> {
    if(this.v3Pool(poolId)) return Promise.resolve([]);
    const pm = this.deployment.poolManager;
    const posm = this.deployment.positionManager;
    if (pm === null || posm === null) return Promise.resolve([]);
    return this.memo(`positions:${poolId}`, async (blockNumber) => {
      const raw = await this.client.getLogs({ address: pm, event: poolManagerEventsAbi[1], args: { id: poolId, sender: posm }, fromBlock: 0n, toBlock: blockNumber });
      const logs = parseEventLogs({ abi: poolManagerEventsAbi, eventName: "ModifyLiquidity", logs: raw });
      const byToken = new Map<bigint, { tickLower: number; tickUpper: number }>();
      for (const l of logs) byToken.set(BigInt(l.args.salt), { tickLower: l.args.tickLower, tickUpper: l.args.tickUpper });
      const out: PoolPosition[] = [];
      await Promise.all(
        [...byToken.entries()].map(async ([tokenId, ticks]) => {
          const [liquidity, owner] = await Promise.all([
            this.client.readContract({ address: posm, abi: positionManagerAbi, functionName: "getPositionLiquidity", args: [tokenId], blockNumber }),
            this.client.readContract({ address: posm, abi: positionManagerAbi, functionName: "ownerOf", args: [tokenId], blockNumber }).catch(() => null)
          ]);
          out.push({ tokenId, owner: owner === null ? null : (owner.toLowerCase() as Address), liquidity, ...ticks });
        })
      );
      return out.sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
    });
  }

  unlockTime(owner: Address): Promise<number | null> {
    return this.memo(`unlock:${owner}`, async (blockNumber) => {
      const code = await this.getCode(owner);
      if (code === "0x") return null;
      const now = Math.floor(Date.now() / 1000);
      for (const fn of ["unlockTime", "releaseTime", "unlockAt", "end"] as const) {
        try {
          const v = Number(await this.client.readContract({ address: owner, abi: unlockAbi, functionName: fn, blockNumber }));
          // a plausible unix time: within the last ten years or the next hundred
          if (Number.isFinite(v) && v > now - 10 * 365 * 86_400 && v < now + 100 * 365 * 86_400) return v;
        } catch {
          // selector absent or reverted: try the next
        }
      }
      return null;
    });
  }

  async probeTransfer(token: Address, holder: Address, to: Address, amount: bigint): Promise<TransferProbeResult | null> {
    return this.memo(`probe:${token}:${holder}:${to}:${amount}`, async (blockNumber) => {
      try {
        const { result } = await this.client.simulateContract({
          address: holder,
          abi: transferProbeAbi,
          functionName: "probe",
          args: [token, to, amount],
          account: zeroAddress,
          blockNumber,
          stateOverride: [{ address: holder, code: transferProbeBytecode }]
        });
        const [ok, sentDelta, receivedDelta] = result;
        return { ok, sentDelta, receivedDelta };
      } catch {
        return null;
      }
    });
  }

  /** Whether the chain has multicall3 at the canonical address (informational, for /health). */
  hasMulticall(): Promise<boolean> {
    return this.forever.memo("multicall3", async () => ((await this.client.getCode({ address: MULTICALL3 })) ?? "0x") !== "0x");
  }
}

export function hexSalt(tokenId: bigint): Hex {
  return toHex(tokenId, { size: 32 });
}
