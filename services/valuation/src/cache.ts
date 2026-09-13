/** Per-block memoisation: a value read at block N is reused until the block number moves on. */
export class BlockCache {
  private block: { value: bigint; readAt: number } | null = null;
  private readonly entries = new Map<string, { block: bigint; value: Promise<unknown> }>();
  private inflight: Promise<bigint> | null = null;

  constructor(
    private readonly readBlock: () => Promise<bigint>,
    private readonly ttlMs: number
  ) {}

  async blockNumber(): Promise<bigint> {
    const now = Date.now();
    if (this.block !== null && now - this.block.readAt < this.ttlMs) return this.block.value;
    if (this.inflight === null) {
      this.inflight = this.readBlock()
        .then((value) => {
          this.block = { value, readAt: Date.now() };
          if (this.entries.size > 5000) this.entries.clear();
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** Run `fn` once per block per key. */
  async memo<T>(key: string, fn: (block: bigint) => Promise<T>): Promise<T> {
    const block = await this.blockNumber();
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.block === block) return hit.value as Promise<T>;
    // Store the promise before starting the read so concurrent portfolio rows share it too.
    // Failed reads may retry; an older request must never remove a newer block's entry.
    const value = Promise.resolve().then(() => fn(block)).catch((e: unknown) => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
      throw e;
    });
    this.entries.set(key, { block, value });
    return value;
  }
}

/** Values that never change for a deployment: decimals, symbols, bytecode. */
export class ForeverCache {
  private readonly entries = new Map<string, Promise<unknown>>();

  memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit as Promise<T>;
    const p = fn().catch((e: unknown) => {
      this.entries.delete(key);
      throw e;
    });
    this.entries.set(key, p);
    return p;
  }
}
