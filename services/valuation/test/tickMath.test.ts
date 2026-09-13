import { describe, expect, it } from "vitest";
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  ceilToSpacing,
  floorToSpacing,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  maxUsableTick,
  minUsableTick
} from "../src/math/tickMath.js";

// Vectors printed by forge from lib/v4-periphery/lib/v4-core TickMath (see README, "Maths sources").
const VECTORS: Array<[number, bigint]> = [
  [0, 79228162514264337593543950336n],
  [1, 79232123823359799118286999568n],
  [-1, 79224201403219477170569942574n],
  [60, 79466191966197645195421774833n],
  [-60, 78990846045029531151608375686n],
  [887272, 1461446703485210103287273052203988822378723970342n],
  [-887272, 4295128739n],
  [100000, 11755562826496067164730007768450n],
  [-100000, 533968626430936354154228408n],
  [202919, 2018317010999599141479991542265040n],
  [-50000, 6504256538020985011912221507n],
  [12345, 146870458338965608271414022015n]
];

describe("TickMath", () => {
  it("getSqrtPriceAtTick matches v4-core vectors", () => {
    for (const [tick, sqrt] of VECTORS) expect(getSqrtPriceAtTick(tick)).toBe(sqrt);
  });

  it("bounds", () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow();
    expect(() => getSqrtPriceAtTick(MIN_TICK - 1)).toThrow();
    expect(() => getTickAtSqrtPrice(MAX_SQRT_PRICE)).toThrow();
    expect(() => getTickAtSqrtPrice(MIN_SQRT_PRICE - 1n)).toThrow();
  });

  it("getTickAtSqrtPrice inverts exactly and one-below lands on the previous tick", () => {
    for (const [tick, sqrt] of VECTORS) {
      if (tick === MAX_TICK) continue;
      expect(getTickAtSqrtPrice(sqrt)).toBe(tick);
      if (tick !== MIN_TICK) expect(getTickAtSqrtPrice(sqrt - 1n)).toBe(tick - 1);
    }
  });

  it("usable ticks and snapping", () => {
    expect(maxUsableTick(60)).toBe(887220);
    expect(minUsableTick(60)).toBe(-887220);
    expect(maxUsableTick(1)).toBe(MAX_TICK);
    expect(floorToSpacing(-61, 60)).toBe(-120);
    expect(floorToSpacing(61, 60)).toBe(60);
    expect(ceilToSpacing(-61, 60)).toBe(-60);
    expect(ceilToSpacing(61, 60)).toBe(120);
    expect(ceilToSpacing(60, 60)).toBe(60);
  });
});
