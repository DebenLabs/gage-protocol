/**
 * Liquidity-lock heuristic: the share of the pool's position liquidity held by known lockers (SeedTimelock, the
 * KNOWN_LOCKERS env list, burn addresses) or by contracts that expose an unlock time. Shown to lenders, never
 * required (spec 7.4). Reports false honestly when nothing matches, which is the case on testnet today.
 */
import type { Address } from "viem";
import type { PoolPosition } from "../chain/reader.js";

export const BURN_ADDRESSES: readonly Address[] = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];

export const LOCKED_SHARE_THRESHOLD = 0.8;

export interface LockInput {
  positions: PoolPosition[];
  lockers: ReadonlySet<Address>;
  /** unlock time (unix seconds) for an owner that is a timelock, null otherwise */
  unlockTimeOf: (owner: Address) => Promise<number | null>;
}

export interface LockResult {
  liquidityLocked: boolean;
  lockedUntil: number | null;
  lockedShare: number;
  detail: string;
}

export async function assessLock(input: LockInput): Promise<LockResult> {
  const live = input.positions.filter((p) => p.liquidity > 0n);
  const total = live.reduce((a, p) => a + p.liquidity, 0n);
  if (total === 0n) return { liquidityLocked: false, lockedUntil: null, lockedShare: 0, detail: "no live positions found in the pool" };
  const owners = [...new Set(live.map((p) => p.owner).filter((o): o is Address => o !== null))];
  const unlockTimes = new Map<Address, number | null>();
  // Known lockers count as locked regardless; their unlock time is still read so lockedUntil can be shown.
  await Promise.all(
    owners.map(async (o) => {
      if (BURN_ADDRESSES.includes(o)) {
        unlockTimes.set(o, null);
        return;
      }
      unlockTimes.set(o, await input.unlockTimeOf(o));
    })
  );
  let locked = 0n;
  let until: number | null = null;
  const lockedOwners: string[] = [];
  for (const p of live) {
    if (p.owner === null) continue;
    const known = input.lockers.has(p.owner) || BURN_ADDRESSES.includes(p.owner);
    const t = unlockTimes.get(p.owner) ?? null;
    if (known || t !== null) {
      locked += p.liquidity;
      lockedOwners.push(p.owner);
      if (t !== null) until = until === null ? t : Math.min(until, t);
    }
  }
  const lockedShare = Number((locked * 10_000n) / total) / 10_000;
  const liquidityLocked = lockedShare >= LOCKED_SHARE_THRESHOLD;
  const detail = liquidityLocked
    ? `${(lockedShare * 100).toFixed(1)}% of position liquidity is held by ${[...new Set(lockedOwners)].join(", ")}`
    : lockedShare > 0
      ? `only ${(lockedShare * 100).toFixed(1)}% of position liquidity is held by a locker or timelock; ${live.length} positions, ${owners.length} owners`
      : `no position is held by a known locker, burn address or timelock; ${live.length} positions across ${owners.length} owners`;
  return { liquidityLocked, lockedUntil: until, lockedShare, detail };
}
