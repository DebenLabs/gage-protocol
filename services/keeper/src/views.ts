/**
 * Typed chain reads. Jobs depend on the `Views` interface only, so tests replace it with plain objects.
 */
import { getAbiItem, type Address, type Hex } from "viem";
import type { Clients } from "./chain.js";
import {
  buybackAbi,
  collateralRegistryAbi,
  dealRewardsAbi,
  dealVaultAbi,
  dripAbi,
  emissionsAbi,
  erc20Abi,
  feeSinkAbi,
  lpRewardsAbi,
  lpStreamerAbi,
  poolManagerAbi,
  positionManagerAbi,
  stateViewAbi,
} from "./abi.js";

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface FundedLog {
  dealId: bigint;
  bidId: bigint;
  lender: Address;
  price: bigint;
  fee: bigint;
  fundedAt: bigint;
  expiry: bigint;
  blockNumber: bigint;
}

export interface TransferLog {
  from: Address;
  to: Address;
  tokenId: bigint;
  blockNumber: bigint;
}

export interface SwapLog {
  blockNumber: bigint;
  sender: Address;
  tick: number;
  sqrtPriceX96: bigint;
}

export interface FeeSinkState {
  vault: Address;
  route: number;
  buyback: Address;
  treasury: Address;
}

export interface EmissionsState {
  launchAt: bigint;
  currentEpoch: bigint;
  weeks: bigint;
  epochSeconds: bigint;
  scheduleOver: boolean;
}

export interface EpochFlags {
  released: boolean;
  rolledOver: boolean;
}

/** `DealRewards.effectiveRates(epoch)`. */
export interface EpochRates {
  rate7: bigint;
  rate21: bigint;
  priceUSDGPerSGAGE: bigint;
  lenderShareBps: number;
  set: boolean;
}

/** What the backstop deal must satisfy on the registry, read in one multicall. */
export interface RegistryConfig {
  allowed: boolean;
  minAmount: bigint;
  maxDealRaw: bigint;
  maxOpenRaw: bigint;
  feeBps: number;
  term7Allowed: boolean;
  term21Allowed: boolean;
  newDealsPaused: boolean;
}

/** `DealVault.getDeal`, the fields the backstop reads. */
export interface DealView {
  borrower: Address;
  lender: Address;
  state: number;
  term: number;
  token: Address;
  amountOrTokenId: bigint;
  cap: bigint;
  price: bigint;
  fee: bigint;
  fundedAt: bigint;
}

export interface Views {
  blockNumber(): Promise<bigint>;
  balance(account: Address): Promise<bigint>;
  erc20Balance(token: Address, owner: Address): Promise<bigint>;
  erc20Decimals(token: Address): Promise<number>;
  vaultBalanceUSDG(vault: Address, account: Address): Promise<bigint>;
  fundedLogs(vault: Address, fromBlock: bigint, toBlock: bigint): Promise<FundedLog[]>;
  feeSinkState(feeSink: Address): Promise<FeeSinkState>;
  registered(dealRewards: Address, dealIds: readonly bigint[]): Promise<boolean[]>;
  dealRewardsConstants(dealRewards: Address): Promise<{ usdgUnit: bigint; maxRewardShareBps: number }>;
  emissionsState(emissions: Address): Promise<EmissionsState>;
  epochFlags(emissions: Address, epochs: readonly bigint[]): Promise<EpochFlags[]>;
  epochStart(emissions: Address, epoch: bigint): Promise<bigint>;
  dealBudgets(emissions: Address, epoch: bigint): Promise<{ budget7: bigint; budget21: bigint }>;
  lpPoolKey(lpRewards: Address): Promise<PoolKey>;
  lpWeightedPositionLogs(lpRewards: Address, fromBlock: bigint, toBlock: bigint): Promise<bigint[]>;
  lpPositionWeights(lpRewards: Address, tokenIds: readonly bigint[]): Promise<bigint[]>;
  transferLogs(positionManager: Address, fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  /** `undefined` where the read fails (burned or unknown tokenId). */
  positionPoolKeys(positionManager: Address, tokenIds: readonly bigint[]): Promise<(PoolKey | undefined)[]>;
  positionLiquidity(positionManager: Address, tokenIds: readonly bigint[]): Promise<bigint[]>;
  /** `Swap` events of one pool on the PoolManager, ascending. */
  swapLogs(poolManager: Address, poolId: Hex, fromBlock: bigint, toBlock: bigint): Promise<SwapLog[]>;
  slot0(stateView: Address, poolId: Hex, blockNumber?: bigint): Promise<{ sqrtPriceX96: bigint; tick: number }>;
  /** `threshold()` on Buyback and CreatorFeeSplitter: same signature. */
  threshold(contract: Address): Promise<bigint>;
  erc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** `Drip.claimable(account, dripId)` for every id, in order. */
  dripClaimable(drip: Address, account: Address, dripIds: readonly Hex[]): Promise<bigint[]>;
  /** `Emissions.remaining(epoch, term)` for both buckets. */
  epochRemaining(emissions: Address, epoch: bigint): Promise<{ remaining7: bigint; remaining21: bigint }>;
  effectiveRates(dealRewards: Address, epoch: bigint): Promise<EpochRates>;
  registryConfig(registry: Address, token: Address): Promise<RegistryConfig>;
  /** `DealVault.openRaw(token)`: raw units across every LISTED and FUNDED deal of the token. */
  openRaw(vault: Address, token: Address): Promise<bigint>;
  deal(vault: Address, dealId: bigint): Promise<DealView>;
  vaultBalanceERC20(vault: Address, account: Address, token: Address): Promise<bigint>;
  streamerState(streamer: Address): Promise<{ pending: bigint; assignedThrough: bigint }>;
}

const DAY = 86_400;

export function makeViews({ publicClient }: Clients): Views {
  const fundedEvent = getAbiItem({ abi: dealVaultAbi, name: "Funded" });
  const transferEvent = getAbiItem({ abi: positionManagerAbi, name: "Transfer" });
  const swapEvent = getAbiItem({ abi: poolManagerAbi, name: "Swap" });

  return {
    blockNumber: () => publicClient.getBlockNumber(),
    balance: (account) => publicClient.getBalance({ address: account }),
    erc20Balance: (token, owner) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    erc20Decimals: (token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    vaultBalanceUSDG: (vault, account) =>
      publicClient.readContract({ address: vault, abi: dealVaultAbi, functionName: "balanceUSDG", args: [account] }),

    fundedLogs: async (vault, fromBlock, toBlock) => {
      const logs = await publicClient.getLogs({ address: vault, event: fundedEvent, fromBlock, toBlock, strict: true });
      return logs.map((l) => ({
        dealId: l.args.dealId,
        bidId: l.args.bidId,
        lender: l.args.lender,
        price: l.args.price,
        fee: l.args.fee,
        fundedAt: BigInt(l.args.fundedAt),
        expiry: BigInt(l.args.expiry),
        blockNumber: l.blockNumber,
      }));
    },

    feeSinkState: async (feeSink) => {
      const c = { address: feeSink, abi: feeSinkAbi } as const;
      const [vault, route, buyback, treasury] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "vault" },
          { ...c, functionName: "route" },
          { ...c, functionName: "buyback" },
          { ...c, functionName: "treasury" },
        ],
        allowFailure: false,
      });
      return { vault, route: Number(route), buyback, treasury };
    },

    registered: async (dealRewards, dealIds) => {
      if (dealIds.length === 0) return [];
      return publicClient.multicall({
        contracts: dealIds.map((id) => ({
          address: dealRewards,
          abi: dealRewardsAbi,
          functionName: "registered" as const,
          args: [id] as const,
        })),
        allowFailure: false,
      });
    },

    dealRewardsConstants: async (dealRewards) => {
      const c = { address: dealRewards, abi: dealRewardsAbi } as const;
      const [usdgUnit, maxRewardShareBps] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "USDG_UNIT" },
          { ...c, functionName: "MAX_REWARD_SHARE_BPS" },
        ],
        allowFailure: false,
      });
      return { usdgUnit, maxRewardShareBps: Number(maxRewardShareBps) };
    },

    emissionsState: async (emissions) => {
      const c = { address: emissions, abi: emissionsAbi } as const;
      const [launchAt, weeks, epochSeconds] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "launchAt" },
          { ...c, functionName: "WEEKS" },
          { ...c, functionName: "EPOCH" },
        ],
        allowFailure: false,
      });
      if (Number(launchAt) === 0) {
        return { launchAt: 0n, currentEpoch: 0n, weeks, epochSeconds, scheduleOver: false };
      }
      const [currentEpoch, scheduleOver] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "currentEpoch" },
          { ...c, functionName: "scheduleOver" },
        ],
        allowFailure: false,
      });
      return { launchAt: BigInt(launchAt), currentEpoch, weeks, epochSeconds, scheduleOver };
    },

    epochFlags: async (emissions, epochs) => {
      if (epochs.length === 0) return [];
      const c = { address: emissions, abi: emissionsAbi } as const;
      const flat = await publicClient.multicall({
        contracts: epochs.flatMap((e) => [
          { ...c, functionName: "released" as const, args: [e] as const },
          { ...c, functionName: "rolledOver" as const, args: [e] as const },
        ]),
        allowFailure: false,
      });
      return epochs.map((_, i) => ({ released: flat[2 * i] === true, rolledOver: flat[2 * i + 1] === true }));
    },

    epochStart: async (emissions, epoch) =>
      BigInt(
        await publicClient.readContract({ address: emissions, abi: emissionsAbi, functionName: "epochStart", args: [epoch] }),
      ),

    dealBudgets: async (emissions, epoch) => {
      const c = { address: emissions, abi: emissionsAbi } as const;
      const [budget7, budget21] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "dealBudget", args: [epoch, 7 * DAY] },
          { ...c, functionName: "dealBudget", args: [epoch, 21 * DAY] },
        ],
        allowFailure: false,
      });
      return { budget7, budget21 };
    },

    lpPoolKey: async (lpRewards) => {
      const k = await publicClient.readContract({ address: lpRewards, abi: lpRewardsAbi, functionName: "poolKey" });
      return { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks };
    },

    transferLogs: async (positionManager, fromBlock, toBlock) => {
      const logs = await publicClient.getLogs({
        address: positionManager,
        event: transferEvent,
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((l) => ({ from: l.args.from, to: l.args.to, tokenId: l.args.tokenId, blockNumber: l.blockNumber }));
    },

    lpWeightedPositionLogs: async (lpRewards, fromBlock, toBlock) => {
      const logs = await publicClient.getLogs({ address: lpRewards,
        event: getAbiItem({ abi: lpRewardsAbi, name: "Checkpointed" }), fromBlock, toBlock, strict: true });
      return logs.filter(l => l.args.weight > 0n).map(l => l.args.tokenId);
    },

    lpPositionWeights: async (lpRewards, tokenIds) => {
      if (tokenIds.length === 0) return [];
      const states = await publicClient.multicall({
        contracts: tokenIds.map(id => ({ address: lpRewards, abi: lpRewardsAbi,
          functionName: "positionState" as const, args: [id] as const })), allowFailure: false,
      });
      return states.map(state => state.weight);
    },

    positionPoolKeys: async (positionManager, tokenIds) => {
      if (tokenIds.length === 0) return [];
      const results = await publicClient.multicall({
        contracts: tokenIds.map((id) => ({
          address: positionManager,
          abi: positionManagerAbi,
          functionName: "getPoolAndPositionInfo" as const,
          args: [id] as const,
        })),
        allowFailure: true,
      });
      return results.map((r) => {
        if (r.status !== "success") return undefined;
        const [k] = r.result;
        return { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks };
      });
    },

    positionLiquidity: async (positionManager, tokenIds) => {
      if (tokenIds.length === 0) return [];
      const results = await publicClient.multicall({
        contracts: tokenIds.map((id) => ({
          address: positionManager,
          abi: positionManagerAbi,
          functionName: "getPositionLiquidity" as const,
          args: [id] as const,
        })),
        allowFailure: true,
      });
      return results.map((r) => (r.status === "success" ? r.result : 0n));
    },

    swapLogs: async (poolManager, poolId, fromBlock, toBlock) => {
      const logs = await publicClient.getLogs({
        address: poolManager,
        event: swapEvent,
        args: { id: poolId },
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((l) => ({
        blockNumber: l.blockNumber,
        sender: l.args.sender,
        tick: l.args.tick,
        sqrtPriceX96: l.args.sqrtPriceX96,
      }));
    },
    slot0: async (stateView, poolId, blockNumber) => {
      const [sqrtPriceX96, tick] = await publicClient.readContract({
        address: stateView,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [poolId],
        blockNumber,
      });
      return { sqrtPriceX96, tick };
    },

    threshold: (contract) => publicClient.readContract({ address: contract, abi: buybackAbi, functionName: "threshold" }),

    erc20Allowance: (token, owner, spender) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }),

    dripClaimable: async (drip, account, dripIds) => {
      if (dripIds.length === 0) return [];
      const amounts = await publicClient.multicall({
        contracts: dripIds.map((id) => ({
          address: drip,
          abi: dripAbi,
          functionName: "claimable" as const,
          args: [account, id] as const,
        })),
        allowFailure: false,
      });
      return amounts.map((a) => BigInt(a));
    },

    epochRemaining: async (emissions, epoch) => {
      const c = { address: emissions, abi: emissionsAbi } as const;
      const [remaining7, remaining21] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "remaining", args: [epoch, 7 * DAY] },
          { ...c, functionName: "remaining", args: [epoch, 21 * DAY] },
        ],
        allowFailure: false,
      });
      return { remaining7, remaining21 };
    },

    effectiveRates: async (dealRewards, epoch) => {
      const r = await publicClient.readContract({
        address: dealRewards,
        abi: dealRewardsAbi,
        functionName: "effectiveRates",
        args: [epoch],
      });
      return {
        rate7: r.rate7,
        rate21: r.rate21,
        priceUSDGPerSGAGE: r.priceUSDGPerSGAGE,
        lenderShareBps: Number(r.lenderShareBps),
        set: r.set,
      };
    },

    registryConfig: async (registry, token) => {
      const c = { address: registry, abi: collateralRegistryAbi } as const;
      const [cfg, feeBps, term7Allowed, term21Allowed, newDealsPaused] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "getERC20Config", args: [token] },
          { ...c, functionName: "feeBps" },
          { ...c, functionName: "isTermAllowed", args: [7 * DAY] },
          { ...c, functionName: "isTermAllowed", args: [21 * DAY] },
          { ...c, functionName: "newDealsPaused" },
        ],
        allowFailure: false,
      });
      return {
        allowed: cfg.allowed,
        minAmount: cfg.minAmount,
        maxDealRaw: cfg.maxDealRaw,
        maxOpenRaw: cfg.maxOpenRaw,
        feeBps: Number(feeBps),
        term7Allowed,
        term21Allowed,
        newDealsPaused,
      };
    },

    openRaw: (vault, token) =>
      publicClient.readContract({ address: vault, abi: dealVaultAbi, functionName: "openRaw", args: [token] }),

    deal: async (vault, dealId) => {
      const d = await publicClient.readContract({ address: vault, abi: dealVaultAbi, functionName: "getDeal", args: [dealId] });
      return {
        borrower: d.borrower,
        lender: d.lender,
        state: Number(d.state),
        term: Number(d.term),
        token: d.token,
        amountOrTokenId: d.amountOrTokenId,
        cap: d.cap,
        price: d.price,
        fee: d.fee,
        fundedAt: BigInt(d.fundedAt),
      };
    },

    vaultBalanceERC20: (vault, account, token) =>
      publicClient.readContract({ address: vault, abi: dealVaultAbi, functionName: "balanceERC20", args: [account, token] }),

    streamerState: async (streamer) => {
      const c = { address: streamer, abi: lpStreamerAbi } as const;
      const [pending, assignedThrough] = await publicClient.multicall({
        contracts: [
          { ...c, functionName: "pending" },
          { ...c, functionName: "assignedThrough" },
        ],
        allowFailure: false,
      });
      return { pending, assignedThrough };
    },
  };
}
