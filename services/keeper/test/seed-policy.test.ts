import { describe, expect, it } from "vitest";
import { compoundQuote, gasAllowed, seedConfig } from "../src/seed-policy.js";

const env = {
  CHAIN_ID: "46630", RPC_URL: "https://rpc.testnet.chain.robinhood.com",
  SEED_LOCK_ADDRESS: "0x1111111111111111111111111111111111111111",
  SEED_LOCK_CODEHASH: `0x${"ab".repeat(32)}`, SEED_TOKEN_ID: "34",
};
describe("seed worker boundaries", () => {
  it("defaults to simulation even when a key is configured", () => {
    expect(seedConfig({ ...env, KEEPER_KEY: `0x${"01".repeat(32)}` }).dryRun).toBe(true);
    expect(seedConfig({ ...env, DRY_RUN: "false" }).dryRun).toBe(false);
  });
  it("requires explicit chain, target code and NFT; rejects typo live flags", () => {
    for (const change of [{ CHAIN_ID: "1" }, { CHAIN_ID: "" }, { SEED_TOKEN_ID: "0" }, { SEED_LOCK_CODEHASH: "0x" }, { DRY_RUN: "flase" }, { SEED_INTERVAL_SECONDS: "0" }]) {
      expect(() => seedConfig({ ...env, ...change })).toThrow();
    }
  });
  it("does not spend gas for zero, one-sided or dust fees", () => {
    expect(compoundQuote(100n, 1000000n, 0n, 100n)).toBeNull();
    expect(compoundQuote(100n, 1000000n, 99n, 100n)).toBeNull();
    expect(compoundQuote(100n, 0n, 100n, 100n)).toBeNull();
  });
  it("enforces the threshold and a positive 0.5 percent liquidity tolerance", () => {
    expect(compoundQuote(100n, 1000000n, 100n, 100n)).toEqual({ referencePrice: 100n, minLiquidity: 99n });
    expect(compoundQuote(100n, 1000000n, 10000n, 100n)?.minLiquidity).toBe(9950n);
  });
  it("requires the gas reserve after maximum transaction cost", () => {
    const limits = { minGasWei: 100n, maxGasCostWei: 50n };
    expect(gasAllowed(150n, 10n, 5n, limits)).toBe(true);
    expect(gasAllowed(149n, 10n, 5n, limits)).toBe(false);
    expect(gasAllowed(999n, 11n, 5n, limits)).toBe(false);
    expect(gasAllowed(999n, 0n, 5n, limits)).toBe(false);
  });
});
