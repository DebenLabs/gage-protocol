import { describe, expect, it } from "vitest";

import { bestBid, costBps, dealLane, graceEnd, isExpired, kindFromIndex, laneFromIndex } from "../src/lib/derive";

describe("costBps", () => {
  it("is what the borrower pays above what they received, in bps of the price", () => {
    expect(costBps(1_824_000_000n, 1_814_880_000n)).toBe(50n);
    expect(costBps(1_000n, 1_000n)).toBe(0n);
  });
  it("is zero for a zero price rather than dividing by zero", () => {
    expect(costBps(1_000n, 0n)).toBe(0n);
  });
});

describe("deadlines (D6, exclusive)", () => {
  it("expires at the deadline itself", () => {
    expect(isExpired(100n, 99n)).toBe(false);
    expect(isExpired(100n, 100n)).toBe(true);
  });
  it("graceEnd is expiry plus GRACE", () => {
    expect(graceEnd(1_000n, 86_400n)).toBe(87_400n);
  });
});

describe("bestBid", () => {
  const now = 1_000n;
  it("picks the highest OPEN unexpired bid, earliest id on a tie", () => {
    const bids = [
      { id: 1n, price: 90n, expiry: 2_000n, state: "OPEN" },
      { id: 2n, price: 95n, expiry: 2_000n, state: "OPEN" },
      { id: 3n, price: 95n, expiry: 2_000n, state: "OPEN" },
      { id: 4n, price: 99n, expiry: 900n, state: "OPEN" },
      { id: 5n, price: 100n, expiry: 2_000n, state: "WITHDRAWN" },
    ];
    expect(bestBid(bids, now)?.id).toBe(2n);
  });
  it("is null with nothing open", () => {
    expect(bestBid([{ id: 1n, price: 1n, expiry: 1n, state: "OPEN" }], now)).toBeNull();
  });
});

describe("enums", () => {
  it("maps Solidity indices", () => {
    expect(kindFromIndex(0)).toBe("ERC20");
    expect(kindFromIndex(1)).toBe("UNIV4_POSITION");
    expect(laneFromIndex(2)).toBe("MEME");
    expect(() => laneFromIndex(3)).toThrow();
  });
  it("derives the deal lane", () => {
    expect(dealLane("UNIV4_POSITION", undefined)).toBe("POSITION");
    expect(dealLane("ERC20", "MEME")).toBe("MEME");
    expect(dealLane("ERC20", undefined)).toBe("STOCK");
  });
});
