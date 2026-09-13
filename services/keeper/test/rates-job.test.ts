import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRates } from "../src/jobs/rates.js";
import { samplePrice } from "../src/jobs/price.js";
import { buildProposal } from "../src/jobs/prep.js";
import { m6Deployment, mockCtx } from "./helpers.js";
import type { JobContext } from "../src/context.js";
import type { Rates } from "../src/rate-policy.js";

vi.mock("../src/jobs/price.js", () => ({ samplePrice: vi.fn() }));
vi.mock("../src/jobs/prep.js", () => ({ buildProposal: vi.fn(), writeProposal: vi.fn() }));
const OWNER = "0x1111111111111111111111111111111111111111";
const EMPTY: Rates = { rate7: 0n, rate21: 0n, priceUSDGPerSGAGE: 0n, lenderShareBps: 0, set: false };
const ZERO: Rates = { ...EMPTY, priceUSDGPerSGAGE: 100n, lenderShareBps: 5000, set: true };
const OLD: Rates = { ...ZERO, rate7: 4n * 10n ** 23n, rate21: 4n * 10n ** 23n, priceUSDGPerSGAGE: 2n };
const GOOD: Rates = { ...ZERO, rate7: 6n * 10n ** 21n, rate21: 6n * 10n ** 21n };
const paths: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => paths.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));

function fixture(current = 0n, nextOpensIn = 400_000) {
  const d = m6Deployment();
  const ctx = mockCtx({ deployment: d, env: { CHAIN_ID: "46630", RATES_ENABLED: "true" } });
  ctx.config.dryRun = false;
  ctx.config.outDir = mkdtempSync(join(tmpdir(), "gage-rates-test-")); paths.push(ctx.config.outDir);
  ctx.signerAddress = OWNER;
  const now = Math.floor(ctx.now() / 1000);
  ctx.state.priceSamples = Array.from({ length: 145 }, (_, i) => ({ t: now - 86_400 + i * 600, priceUSDGPerSGAGE: "100" }));
  const stored = new Map<bigint, Rates>([[0n, OLD]]);
  const effective = (e: bigint) => [...stored.entries()].filter(([n]) => n <= e).sort(([a], [b]) => Number(b - a))[0]?.[1] ?? EMPTY;
  const readContract = vi.fn(async (r: { functionName: string; args?: readonly unknown[] }) => {
    await Promise.resolve();
    switch (r.functionName) {
      case "owner": return OWNER;
      case "EMISSIONS": return d.addresses.Emissions;
      case "USDG_UNIT": return 1_000_000n;
      case "MAX_REWARD_SHARE_BPS": return 8000;
      case "currentEpoch": return current;
      case "WEEKS": return 52n;
      case "epochRates": return stored.get(r.args![0] as bigint) ?? EMPTY;
      case "effectiveRates": return effective(r.args![0] as bigint);
      case "epochStart": return BigInt(now + (current === 0n ? nextOpensIn : 3600));
      default: throw Error(`unexpected ${r.functionName}`);
    }
  });
  const pub = { getChainId: vi.fn(() => Promise.resolve(46630)), readContract, multicall: vi.fn(({ contracts }: { contracts: { args: readonly [bigint] }[] }) => Promise.resolve(contracts.map(c => stored.get(c.args[0]) ?? EMPTY))) };
  ctx.publicClient = pub as unknown as JobContext["publicClient"] & object;
  ctx.sender.script["DealRewards.setEpochRates"] = call => {
    const [epoch, rate7, rate21, priceUSDGPerSGAGE, lenderShareBps] = call.args as [bigint, bigint, bigint, bigint, number];
    stored.set(epoch, { rate7, rate21, priceUSDGPerSGAGE, lenderShareBps, set: true });
    return { status: "sent", hash: `0x${"1".repeat(64)}`, gasUsed: 100000n, result: undefined };
  };
  vi.mocked(samplePrice).mockResolvedValue(100n);
  vi.mocked(buildProposal).mockImplementation((_ctx, epoch) => Promise.resolve({ epoch: String(epoch), generatedAt: new Date(ctx.now()).toISOString(), chainId: 46630, dealRewards: d.addresses.DealRewards!, basis: { price: {} }, proposal: { rate7: String(GOOD.rate7), rate21: String(GOOD.rate21), priceUSDGPerSGAGE: "100", lenderShareBps: ctx.config.lenderShareBps }, notes: [], tx: { to: d.addresses.DealRewards!, data: "0x", cast: "" } }));
  return { ctx, stored, pub };
}

describe("owner rate renewal", () => {
  it("confirms the following zero before correcting the first epoch and is idempotent", async () => {
    const { ctx, stored } = fixture();
    await runRates(ctx);
    expect(ctx.sender.calls.map(c => c.args![0])).toEqual([2n, 1n]);
    expect(stored.get(1n)).toEqual(GOOD); expect(stored.get(2n)).toEqual(ZERO);
    await runRates(ctx);
    expect(ctx.sender.calls).toHaveLength(2);
  });
  it("applies a configured lender-favouring split when renewing from a posted zero", async () => {
    const { ctx, stored } = fixture(0n, 3600);
    stored.set(0n, GOOD);
    stored.set(1n, ZERO);
    ctx.config.lenderShareBps = 6_667;
    await runRates(ctx);
    expect(stored.get(1n)?.lenderShareBps).toBe(6_667);
    expect(stored.get(2n)?.lenderShareBps).toBe(6_667);
  });
  it("does not silently replace an active positive split", async () => {
    const { ctx, stored } = fixture(1n);
    stored.set(1n, OLD);
    stored.set(2n, ZERO);
    ctx.config.lenderShareBps = 6_667;
    await expect(runRates(ctx)).rejects.toThrow("split-changed");
    expect(stored.get(1n)).toEqual(OLD);
  });
  it("never posts positive rates after a failed or only simulated stop", async () => {
    const { ctx } = fixture();
    ctx.sender.script["DealRewards.setEpochRates"] = { status: "failed", error: "rpc" };
    await expect(runRates(ctx)).rejects.toThrow("unconfirmed");
    expect(ctx.sender.calls).toHaveLength(1);
    ctx.sender.calls.length = 0;
    ctx.sender.script["DealRewards.setEpochRates"] = { status: "dry", result: undefined };
    await runRates(ctx); expect(ctx.sender.calls).toHaveLength(1);
  });
  it("refuses another signer, another chain and unexpected future positive rates", async () => {
    const { ctx, stored, pub } = fixture();
    ctx.signerAddress = "0x2222222222222222222222222222222222222222";
    await expect(runRates(ctx)).rejects.toThrow("owner-mismatch");
    ctx.signerAddress = OWNER; pub.getChainId.mockResolvedValue(1);
    await expect(runRates(ctx)).rejects.toThrow("chain-mismatch");
    pub.getChainId.mockResolvedValue(46630); stored.set(5n, GOOD);
    await expect(runRates(ctx)).rejects.toThrow("future-posting");
    expect(ctx.sender.calls).toHaveLength(0);
  });
  it("stops excessive allocations on insufficient history without enabling a new positive rate", async () => {
    const { ctx, stored } = fixture(); ctx.state.priceSamples = [];
    await expect(runRates(ctx)).rejects.toThrow("history-blocked");
    expect(stored.get(1n)).toEqual(ZERO);
    expect(ctx.sender.calls).toHaveLength(1);
  });
  it("keeps an already prepared next epoch when reducing the current one", async () => {
    const { ctx, stored } = fixture(1n); stored.set(1n, OLD); stored.set(2n, GOOD);
    await runRates(ctx);
    expect(ctx.sender.calls.map(c => c.args![0])).toEqual([3n, 1n]);
    expect(stored.get(2n)).toEqual(GOOD); expect(stored.get(3n)).toEqual(ZERO);
  });
  it("blocks expired proposals after safely installing the following zero", async () => {
    const { ctx, stored } = fixture();
    const original = await buildProposal(ctx, 1n);
    vi.mocked(buildProposal).mockResolvedValue({ ...original!, generatedAt: new Date(0).toISOString() });
    await expect(runRates(ctx)).rejects.toThrow("proposal-stale");
    expect(stored.get(1n)).toBeUndefined(); expect(stored.get(2n)).toEqual(ZERO);
  });
  it("rechecks that the scheduled stop was not replaced before signing positive rates", async () => {
    const { ctx, stored } = fixture();
    const proposal = await buildProposal(ctx, 1n);
    vi.mocked(buildProposal).mockImplementation(() => { stored.set(2n, GOOD); return Promise.resolve(proposal); });
    await expect(runRates(ctx)).rejects.toThrow("stop-changed");
    expect(stored.get(1n)).toBeUndefined();
  });
  it("blocks increasing a zero allocation when spot is far below TWAP", async () => {
    const { ctx, stored } = fixture(1n); stored.set(1n, GOOD); stored.set(2n, ZERO);
    ctx.state.priceSamples.forEach(s => s.priceUSDGPerSGAGE = "200");
    const proposal = await buildProposal(ctx, 2n);
    vi.mocked(buildProposal).mockResolvedValue({ ...proposal!, basis: { price: { downsideDivergence: true } } });
    await expect(runRates(ctx)).rejects.toThrow("downside-increase");
    expect(stored.get(2n)).toEqual(ZERO);
  });
  it("posts the 60% target without treating it as an alert or refreshing it again", async () => {
    const { ctx, stored } = fixture(0n, 3600);
    const warn = vi.spyOn(ctx.log, "warn");
    stored.set(0n, GOOD);
    stored.set(1n, ZERO);
    await runRates(ctx);
    expect(stored.get(1n)).toEqual(GOOD);
    expect(warn).not.toHaveBeenCalledWith("rates_value_alert", expect.anything());
    await runRates(ctx);
    expect(ctx.sender.calls).toHaveLength(2);
  });
  it("rejects a price move above 62.5% before posting positive rates", async () => {
    const { ctx, stored } = fixture();
    vi.mocked(samplePrice).mockResolvedValueOnce(100n).mockResolvedValue(105n);
    await expect(runRates(ctx)).rejects.toThrow("rates-price-moved");
    expect(stored.get(1n)).toBeUndefined();
    expect(stored.get(2n)).toEqual(ZERO);
    expect(ctx.sender.calls).toHaveLength(1);
  });
  it("reduces an appreciated 66% allocation back to the target", async () => {
    const { ctx, stored } = fixture(1n);
    stored.set(1n, { ...GOOD, rate7: 66n * 10n ** 20n });
    stored.set(2n, GOOD);
    await runRates(ctx);
    expect(stored.get(1n)).toEqual(GOOD);
    expect(ctx.sender.calls.map(c => c.args![0])).toEqual([3n, 1n]);
  });
  it("is disabled by default", async () => {
    const ctx = mockCtx(); await runRates(ctx); expect(ctx.sender.calls).toHaveLength(0);
  });
});
