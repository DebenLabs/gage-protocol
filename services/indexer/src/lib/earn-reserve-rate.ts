import { parseAbi, type Abi } from "viem";
import type { EarnAddress, EarnReserveRate, EarnStrategy } from "../../../../shared/earn";

/** The subset of a viem public client the sampler needs; historical state comes from the indexer's archive RPC. */
export interface ReserveRateClient {
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  readContract(args: { address: EarnAddress; abi: Abi; functionName: "convertToAssets"; args: readonly [bigint]; blockNumber: bigint }): Promise<unknown>;
}

export const RESERVE_RATE_WINDOW_SECONDS = 7 * 86_400;
/** Below six hours a window is dominated by block granularity and single accrual events; the published window says how long it was. */
export const RESERVE_RATE_MIN_SECONDS = 6 * 3600;
export interface ReserveSample { block: bigint; asOf: bigint; assets: bigint }

/** The rate from stored conversion samples: the newest against the oldest inside the window, or the oldest kept while the series is younger. */
export function reserveRateFromSamples(samples: readonly ReserveSample[], windowSeconds = RESERVE_RATE_WINDOW_SECONDS, minSeconds = RESERVE_RATE_MIN_SECONDS): EarnReserveRate | null {
  const ordered = [...samples].sort((a, b) => a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0);
  const to = ordered.at(-1);
  if (!to) return null;
  const from = ordered.find(sample => sample.asOf >= to.asOf - BigInt(windowSeconds)) ?? ordered[0]!;
  const elapsed = to.asOf - from.asOf;
  if (elapsed < BigInt(minSeconds) || from.assets <= 0n) return null;
  const yearlyBps = Number((to.assets - from.assets) * 10_000n * YEAR_SECONDS / (from.assets * elapsed));
  if (!Number.isSafeInteger(yearlyBps)) return null;
  return { yearlyBps, windowSeconds: Number(elapsed), fromBlock: from.block.toString(), toBlock: to.block.toString() };
}
const PROBE_BLOCKS = 100_000n;
const YEAR_SECONDS = 365n * 86_400n;
const reserveAbi = parseAbi(["function convertToAssets(uint256 shares) view returns (uint256)"]);

/**
 * Realized reserve share-price growth over about a week before `toBlock`, as a simple yearly rate in basis points.
 * Deposits and redemptions never move an ERC-4626 conversion, so two `convertToAssets` samples measure accrual alone.
 * Null when the chain is too young or cannot serve the older state; a falling conversion yields a negative rate.
 */
export async function sampleReserveRate(client: ReserveRateClient, reserve: EarnAddress, unit: bigint, toBlock: bigint, windowSeconds = RESERVE_RATE_WINDOW_SECONDS): Promise<EarnReserveRate | null> {
  if (toBlock < 2n || unit <= 0n) return null;
  try {
    const to = await client.getBlock({ blockNumber: toBlock });
    const probeBlock = toBlock > PROBE_BLOCKS ? toBlock - PROBE_BLOCKS : toBlock / 2n;
    if (probeBlock < 1n) return null;
    const probe = await client.getBlock({ blockNumber: probeBlock });
    const probeElapsed = to.timestamp - probe.timestamp;
    if (probeElapsed <= 0n) return null;
    let fromBlock = toBlock - BigInt(windowSeconds) * (toBlock - probeBlock) / probeElapsed;
    if (fromBlock < 1n) fromBlock = 1n;
    if (fromBlock >= toBlock) return null;
    const from = await client.getBlock({ blockNumber: fromBlock });
    const elapsed = to.timestamp - from.timestamp;
    if (elapsed < BigInt(RESERVE_RATE_MIN_SECONDS)) return null;
    const read = async (blockNumber: bigint) => BigInt(String(await client.readContract({ address: reserve, abi: reserveAbi, functionName: "convertToAssets", args: [unit], blockNumber })));
    const [now, then] = await Promise.all([read(toBlock), read(fromBlock)]);
    if (then <= 0n) return null;
    const yearlyBps = Number((now - then) * 10_000n * YEAR_SECONDS / (then * elapsed));
    if (!Number.isSafeInteger(yearlyBps)) return null;
    return { yearlyBps, windowSeconds: Number(elapsed), fromBlock: fromBlock.toString(), toBlock: toBlock.toString() };
  } catch {
    return null;
  }
}

/**
 * One rate per reserve, reused for `ttlMs` and shared between concurrent requests. Stored samples that already span
 * the window need no RPC; a younger series tries two archive reads first and falls back to what the samples cover.
 */
export function createReserveRateSource(client: ReserveRateClient, options: { samples?: (snapshot: EarnStrategy) => Promise<readonly ReserveSample[]>; ttlMs?: number; now?: () => number } = {}): (snapshot: EarnStrategy) => Promise<EarnReserveRate | null> {
  const ttl = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; value: Promise<EarnReserveRate | null> }>();
  return snapshot => {
    const key = snapshot.reserve.toLowerCase();
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttl) return cached.value;
    const value = (async () => {
      const stored = options.samples ? reserveRateFromSamples(await options.samples(snapshot).catch(() => [])) : null;
      if (stored && stored.windowSeconds >= RESERVE_RATE_WINDOW_SECONDS * 0.9) return stored;
      const archive = await sampleReserveRate(client, snapshot.reserve, 10n ** BigInt(snapshot.reserveDecimals), BigInt(snapshot.blockNumber));
      return archive ?? stored;
    })();
    cache.set(key, { at: now(), value });
    return value;
  };
}
