// The drip curve (spec 12.1, IDrip, D48): unlocked(t) = total * min(t - start, length)^2 / length^2.

export const CURVE_POINTS = 13;

export function unlockedAt(total: bigint, start: bigint, length: bigint, t: bigint): bigint {
  if (length <= 0n) return total;
  const elapsed = t <= start ? 0n : t - start >= length ? length : t - start;
  return (total * elapsed ** 2n) / length ** 2n;
}

export function claimableAt(total: bigint, claimed: bigint, start: bigint, length: bigint, t: bigint): bigint {
  const unlocked = unlockedAt(total, start, length, t);
  return unlocked > claimed ? unlocked - claimed : 0n;
}

export type CurvePoint = { t: number; unlocked: string };

/** 13 points, t = start + i * length / 12 (floored), so the last point is the end of the drip at 100%. */
export function curvePoints(total: bigint, start: bigint, length: bigint): CurvePoint[] {
  const steps = BigInt(CURVE_POINTS - 1);
  const points: CurvePoint[] = [];
  for (let i = 0n; i <= steps; i++) {
    const t = start + (i * length) / steps;
    points.push({ t: Number(t), unlocked: unlockedAt(total, start, length, t).toString() });
  }
  return points;
}
