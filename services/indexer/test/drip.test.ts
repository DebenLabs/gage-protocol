import { describe, expect, it } from "vitest";

import { CURVE_POINTS, claimableAt, curvePoints, unlockedAt } from "../src/lib/drip";

const total = 1_240n * 10n ** 18n;
const start = 1_756_700_000n;
const length = 7n * 86_400n;

describe("unlockedAt (spec 12.1, D48: (t/L)^2)", () => {
  it("is zero before and at the start", () => {
    expect(unlockedAt(total, start, length, start - 1n)).toBe(0n);
    expect(unlockedAt(total, start, length, start)).toBe(0n);
  });
  it("is 25% half way and 81% at nine tenths", () => {
    expect(unlockedAt(total, start, length, start + length / 2n)).toBe(total / 4n);
    const nineTenths = unlockedAt(total, start, length, start + (length * 9n) / 10n);
    expect((nineTenths * 100n) / total).toBe(81n);
  });
  it("is the whole amount at and after the end", () => {
    expect(unlockedAt(total, start, length, start + length)).toBe(total);
    expect(unlockedAt(total, start, length, start + length * 2n)).toBe(total);
  });
  it("treats a zero length as fully unlocked", () => {
    expect(unlockedAt(total, start, 0n, start)).toBe(total);
  });
});

describe("claimableAt", () => {
  it("is unlocked minus claimed, never negative", () => {
    const t = start + length / 2n;
    expect(claimableAt(total, 0n, start, length, t)).toBe(total / 4n);
    expect(claimableAt(total, total / 4n, start, length, t)).toBe(0n);
    expect(claimableAt(total, total, start, length, t)).toBe(0n);
  });
});

describe("curvePoints", () => {
  it("has 13 points from the start to the end at 100%", () => {
    const points = curvePoints(total, start, length);
    expect(points).toHaveLength(CURVE_POINTS);
    expect(points[0]).toEqual({ t: Number(start), unlocked: "0" });
    expect(points[12]).toEqual({ t: Number(start + length), unlocked: total.toString() });
    expect(points[6]?.t).toBe(Number(start + length / 2n));
    expect(points[6]?.unlocked).toBe((total / 4n).toString());
  });
});
