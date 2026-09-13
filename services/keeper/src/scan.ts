/**
 * Chunked, resumable log scanning. Public RPCs cap `eth_getLogs` ranges; the chunk halves on failure down to a
 * floor, then the error propagates so the job logs it and the cursor stays put.
 */

export interface ScanRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/** Splits [from, to] into inclusive chunks of at most `chunk` blocks. Pure. */
export function chunkRanges(fromBlock: bigint, toBlock: bigint, chunk: bigint): ScanRange[] {
  if (chunk <= 0n) throw new Error("chunk must be positive");
  const out: ScanRange[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    out.push({ fromBlock: start, toBlock: end });
  }
  return out;
}

export interface ScanResult<T> {
  items: T[];
  /** The next block to scan (toBlock + 1). */
  nextCursor: bigint;
}

const MIN_CHUNK = 500n;

/**
 * Fetches logs from `fromBlock` to `toBlock` with `fetch`, chunked. Retries a failing chunk at half size until
 * MIN_CHUNK, then throws. Returns the items and the cursor to resume from.
 */
export async function scanLogs<T>(
  fromBlock: bigint,
  toBlock: bigint,
  chunk: bigint,
  fetch: (range: ScanRange) => Promise<T[]>,
): Promise<ScanResult<T>> {
  const items: T[] = [];
  if (toBlock < fromBlock) return { items, nextCursor: fromBlock };
  let start = fromBlock;
  let size = chunk;
  while (start <= toBlock) {
    const end = start + size - 1n < toBlock ? start + size - 1n : toBlock;
    try {
      items.push(...(await fetch({ fromBlock: start, toBlock: end })));
      start = end + 1n;
    } catch (err) {
      if (size <= MIN_CHUNK) throw err;
      size = size / 2n < MIN_CHUNK ? MIN_CHUNK : size / 2n;
    }
  }
  return { items, nextCursor: toBlock + 1n };
}
