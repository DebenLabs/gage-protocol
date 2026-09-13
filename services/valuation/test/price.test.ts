import { describe, expect, it } from "vitest";
import { applyPrice, compare, fractionToDecimal, fractionToNumber, invert, multiply, priceFromSqrtPriceX96, scaleSqrtPrice } from "../src/math/price.js";
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from "../src/math/tickMath.js";
import { Q96 } from "../src/math/fullMath.js";

describe("price fractions", () => {
  it("sqrtPrice at tick 0 is a 1:1 raw price", () => {
    const p = priceFromSqrtPriceX96(Q96);
    expect(applyPrice(12345n, p)).toBe(12345n);
    expect(fractionToDecimal(p, 0)).toBe("1");
  });

  it("two-hop composition: meme -> stock -> USDG", () => {
    // 1 meme = 0.001 stock (18d each); 1 stock = 180 USDG (USDG 6 decimals)
    const memePerStock = { num: 1n, den: 1000n }; // stock raw per meme raw
    const stockUsdg = { num: 180n * 10n ** 6n, den: 10n ** 18n }; // usdg raw per stock raw
    const composed = multiply(memePerStock, stockUsdg);
    // one whole meme = 1e18 raw -> 0.18 USDG = 180000 raw
    expect(applyPrice(10n ** 18n, composed)).toBe(180_000n);
    // priceUSDG per whole token: shift by 18 - 6
    expect(fractionToDecimal(composed, 18 - 6)).toBe("0.18");
    expect(fractionToDecimal(invert(composed), 6 - 18, 6)).toBe("5.555555");
  });

  it("scenario scaling keeps the sqrt price consistent with the tick", () => {
    const s = getSqrtPriceAtTick(12345);
    const down20 = scaleSqrtPrice(s, 8n, 10n);
    // price falls by 20% => tick falls by ln(0.8)/ln(1.0001) ~= -2231.4
    expect(getTickAtSqrtPrice(down20)).toBe(12345 - 2232);
    const p0 = fractionToNumber(priceFromSqrtPriceX96(s));
    const p1 = fractionToNumber(priceFromSqrtPriceX96(down20));
    expect(p1 / p0).toBeCloseTo(0.8, 9);
  });

  it("compare", () => {
    expect(compare({ num: 1n, den: 2n }, { num: 2n, den: 4n })).toBe(0);
    expect(compare({ num: 1n, den: 3n }, { num: 1n, den: 2n })).toBe(-1);
  });
});
