import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig, parseDecimal, parseDuration } from "../src/config.js";
import { earnStrategiesOf, parseDeployment, summarise } from "../src/deployment.js";
import { redact, serialise } from "../src/log.js";

describe("parseDuration / parseDecimal", () => {
  it("parses units", () => {
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1.5s")).toBe(1_500);
    expect(parseDuration("250")).toBe(250);
    expect(() => parseDuration("soon")).toThrow();
  });
  it("parses decimals into raw units", () => {
    expect(parseDecimal("0.01", 18)).toBe(10n ** 16n);
    expect(parseDecimal("1000", 6)).toBe(1_000_000_000n);
    expect(parseDecimal("1.2345678", 6)).toBe(1_234_567n);
    expect(parseDecimal(".5", 2)).toBe(50n);
    expect(() => parseDecimal("x", 6)).toThrow();
  });
});

describe("loadConfig", () => {
  it("defaults to dry-run without a key and never exposes the key", () => {
    const { config, secrets } = loadConfig({});
    expect(config.dryRun).toBe(true);
    expect(config.hasKey).toBe(false);
    expect(secrets.keeperKey).toBeUndefined();
    expect(JSON.stringify(describeConfig(config))).not.toContain("KEEPER");
  });
  it("goes live with a key unless DRY_RUN=true", () => {
    const key = `0x${"11".repeat(32)}`;
    expect(loadConfig({ KEEPER_KEY: key }).config.dryRun).toBe(false);
    expect(loadConfig({ KEEPER_KEY: key, DRY_RUN: "true" }).config.dryRun).toBe(true);
    expect(JSON.stringify(describeConfig(loadConfig({ KEEPER_KEY: key }).config))).not.toContain(key);
  });
  it("rejects a malformed key", () => {
    expect(() => loadConfig({ KEEPER_KEY: "abc" })).toThrow();
  });
  it("reads the job allowlist and refuses unknown job names", () => {
    expect(loadConfig({}).config.jobs).toEqual([]);
    expect(loadConfig({ KEEPER_JOBS: "earn, gas,earn" }).config.jobs).toEqual(["earn", "gas"]);
    expect(describeConfig(loadConfig({}).config).jobs).toBe("all");
    expect(describeConfig(loadConfig({ KEEPER_JOBS: "earn" }).config).jobs).toEqual(["earn"]);
    expect(() => loadConfig({ KEEPER_JOBS: "earn,fee" })).toThrow(/unknown job/);
  });
  it("reads intervals and the gas floor", () => {
    const { config } = loadConfig({ MIN_GAS_ETH: "0.5", FEES_INTERVAL: "5m" });
    expect(config.minGasWei).toBe(5n * 10n ** 17n);
    expect(config.intervals.fees).toBe(300_000);
  });
  it("makes the configured lender split visible in the safe startup summary", () => {
    const { config } = loadConfig({ LENDER_SHARE_BPS: "6667" });
    expect(describeConfig(config).lenderShareBps).toBe(6_667);
  });
  it("defaults the streamer and backstop settings to the D64 values, backstop off", () => {
    const { config } = loadConfig({});
    expect(config.streamerBoundaryLeadSeconds).toBe(600);
    expect(config.streamerDepositMinSgage).toBe("1000");
    expect(config.backstopEnabled).toBe(false);
    expect(config.backstopWindowSeconds).toBe(4 * 3_600);
    expect(config.backstopMinSgage).toBe("1000000");
    expect(config.backstopCollateralToken).toBeUndefined();
    expect(config.backstopCollateralAmount).toBeUndefined();
    expect(config.intervals.streamerBoundary).toBe(60_000);
    expect(config.intervals.streamerDeposit).toBe(3_600_000);
    expect(config.intervals.backstop).toBe(1_800_000);
  });
  it("parses the streamer and backstop settings", () => {
    const { config } = loadConfig({
      STREAMER_BOUNDARY_LEAD_SECONDS: "300",
      STREAMER_DEPOSIT_MIN_SGAGE: "2500",
      BACKSTOP_ENABLED: "true",
      BACKSTOP_WINDOW_SECONDS: "7200",
      BACKSTOP_MIN_SGAGE: "500000",
      BACKSTOP_COLLATERAL_TOKEN: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      BACKSTOP_COLLATERAL_AMOUNT: "40151162267406354",
      BACKSTOP_INTERVAL: "15m",
    });
    expect(config.streamerBoundaryLeadSeconds).toBe(300);
    expect(config.streamerDepositMinSgage).toBe("2500");
    expect(config.backstopEnabled).toBe(true);
    expect(config.backstopWindowSeconds).toBe(7_200);
    expect(config.backstopMinSgage).toBe("500000");
    expect(config.backstopCollateralToken).toBe("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    expect(config.backstopCollateralAmount).toBe(40_151_162_267_406_354n);
    expect(config.intervals.backstop).toBe(900_000);
    expect(describeConfig(config).backstopEnabled).toBe(true);
    expect(() => loadConfig({ BACKSTOP_COLLATERAL_TOKEN: "weth" })).toThrow();
    expect(() => loadConfig({ BACKSTOP_COLLATERAL_AMOUNT: "0.04" })).toThrow();
    expect(() => loadConfig({ STREAMER_BOUNDARY_LEAD_SECONDS: "0" })).toThrow();
  });
});

describe("logger redaction", () => {
  it("drops secret-looking fields and serialises bigints", () => {
    expect(redact({ keeperKey: "0xabc", KEEPER_KEY: "x", hash: "0x1" })).toEqual({
      keeperKey: "[redacted]",
      KEEPER_KEY: "[redacted]",
      hash: "0x1",
    });
    expect(serialise({ a: 1n })).toBe('{"a":"1"}');
  });
});

describe("parseDeployment", () => {
  const m1 = {
    chainId: 46630,
    DealVault: "0xde66806eee4272000C9c0cE0eAe99902B168453A",
    FeeSink: "0x731C3Ed69508cF1D329324A1Aa22CC38AD7203DF",
    USDG: "0x8639D21a0f8140bC8745D826EF485a787Cfcb91f",
    deployer: "0xa9CCD2D1fC2DFc61Da18cf007f906bDf687407a8",
  };
  it("reads M1 keys and reports the token layer absent", () => {
    const d = parseDeployment(m1);
    expect(d.addresses.DealVault).toBe(m1.DealVault);
    expect(d.addresses.Emissions).toBeUndefined();
    const s = summarise(d);
    expect(s.present).toEqual(["DealVault", "FeeSink", "USDG"]);
    expect(s.absent).toContain("DealRewards");
    expect(s.pools).toEqual([]);
  });
  it("picks up token-layer keys and pools when they appear", () => {
    const d = parseDeployment({
      ...m1,
      Emissions: "0x1000000000000000000000000000000000000002",
      startBlock: "123",
      pools: {
        gageSgage: {
          currency0: "0x1000000000000000000000000000000000000008",
          currency1: "0x1000000000000000000000000000000000000009",
          fee: 30000,
          tickSpacing: 60,
          hooks: "0x1000000000000000000000000000000000000A00",
          poolId: `0x${"11".repeat(32)}`,
        },
      },
    });
    expect(d.addresses.Emissions).toBeDefined();
    expect(d.startBlock).toBe(123n);
    expect(d.pools.gageSgage?.fee).toBe(30_000);
  });
  it("ignores the zero address", () => {
    const d = parseDeployment({ ...m1, Emissions: "0x0000000000000000000000000000000000000000" });
    expect(d.addresses.Emissions).toBeUndefined();
  });

  describe("earnStrategies", () => {
    const flat = { HybridVault: "0x1000000000000000000000000000000000000011", HybridFees: "0x1000000000000000000000000000000000000014", HybridReserve: "0x1000000000000000000000000000000000000012", EarnCore: "0x1000000000000000000000000000000000000013", earnStartBlock: 61590000 };
    const flagship = { id: "gage-mix", title: "Gage USDG Mix", ...flat };
    const stocks = { id: "stocks", title: "Gage USDG Stocks", HybridVault: "0x2000000000000000000000000000000000000021", HybridReserve: "0x2000000000000000000000000000000000000022", EarnCore: flat.EarnCore, earnStartBlock: "61600000" };
    it("reads every entry of the array in order with lowercase addresses", () => {
      const d = parseDeployment({ ...m1, ...flat, earnStrategies: [flagship, stocks] });
      expect(d.earnStrategies).toEqual([
        { id: "gage-mix", title: "Gage USDG Mix", vault: flat.HybridVault, fees: flat.HybridFees, reserve: flat.HybridReserve, core: flat.EarnCore, startBlock: 61590000n },
        { id: "stocks", title: "Gage USDG Stocks", vault: stocks.HybridVault, fees: undefined, reserve: stocks.HybridReserve, core: flat.EarnCore, startBlock: 61600000n },
      ]);
      expect(earnStrategiesOf(d)).toBe(d.earnStrategies);
      expect(d.addresses.HybridVault).toBe(flat.HybridVault);
    });
    it("reads the flat keys as the single flagship when the array is absent, and none without them", () => {
      const checksummed = { ...flat, EarnCore: "0xde66806eee4272000C9c0cE0eAe99902B168453A" };
      expect(parseDeployment({ ...m1, ...checksummed }).earnStrategies).toEqual([{ id: "gage-mix", title: "Gage USDG Mix", vault: flat.HybridVault, fees: flat.HybridFees, reserve: flat.HybridReserve, core: checksummed.EarnCore.toLowerCase(), startBlock: 61590000n }]);
      expect(parseDeployment({ ...m1, ...flat, earnStrategies: [] })).toMatchObject({ earnStrategies: [{ id: "gage-mix" }] });
      expect(parseDeployment({ ...m1, HybridVault: flat.HybridVault }).earnStrategies).toEqual([]);
      const fixture = parseDeployment({ ...m1, ...flat });
      delete fixture.earnStrategies;
      expect(earnStrategiesOf(fixture)).toMatchObject([{ id: "gage-mix", vault: flat.HybridVault, fees: flat.HybridFees, startBlock: undefined }]);
    });
    it("refuses a strategy another curator than the deployment EOA mandates", () => {
      const deployer = "0x" + "7".repeat(40);
      expect(parseDeployment({ ...m1, ...flat, deployer, earnStrategies: [flagship, { ...stocks, earnMandate: { curator: deployer.toUpperCase().replace("0X", "0x") } }] }).earnStrategies).toHaveLength(2);
      expect(() => parseDeployment({ ...m1, ...flat, deployer, earnStrategies: [flagship, { ...stocks, earnMandate: { curator: "0x" + "8".repeat(40) } }] })).toThrow("curated");
    });
    it("requires the flat keys to mirror entry 0", () => {
      expect(() => parseDeployment({ ...m1, ...flat, earnStrategies: [stocks, flagship] })).toThrow("mirror");
      expect(parseDeployment({ ...m1, earnStrategies: [stocks] }).earnStrategies).toHaveLength(1);
    });
    it("rejects an invalid slug, a duplicate id or address, a missing identity and a non-array", () => {
      for (const id of ["Earn", "1earn", "earn_core", "", "a".repeat(33)]) expect(() => parseDeployment({ ...m1, ...flat, earnStrategies: [{ ...flagship, id }] })).toThrow("slug");
      expect(() => parseDeployment({ ...m1, ...flat, earnStrategies: [flagship, { ...stocks, id: "gage-mix" }] })).toThrow("duplicate id");
      expect(() => parseDeployment({ ...m1, ...flat, earnStrategies: [flagship, { ...stocks, HybridVault: flat.HybridVault }] })).toThrow("duplicate vault");
      expect(() => parseDeployment({ ...m1, ...flat, earnStrategies: [{ ...flagship, HybridReserve: "0x0000000000000000000000000000000000000000" }] })).toThrow("HybridReserve");
      expect(() => parseDeployment({ ...m1, ...flat, earnStrategies: [{ ...flagship, title: " " }] })).toThrow("title");
      expect(() => parseDeployment({ ...m1, ...flat, earnStrategies: { earn: flagship } })).toThrow("not an array");
    });
  });
});
