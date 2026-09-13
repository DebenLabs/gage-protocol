import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { SampleStore } from "../src/facts/store.js";
import { Pricer } from "../src/pricing/pricer.js";
import { RANGE_NOTE } from "../src/range/suggest.js";
import { A, FakeExplorer, FakeIndexer, FakeReader, fixtureDeployment, NVDA_KEY } from "./helpers/fake.js";

function build(withV4 = true): { deps: AppDeps; reader: FakeReader } {
  const reader = new FakeReader();
  const deployment = fixtureDeployment(withV4);
  const deps: AppDeps = {
    reader,
    pricer: new Pricer(reader, deployment),
    deployment,
    explorer: new FakeExplorer(),
    indexer: new FakeIndexer(),
    store: SampleStore.inMemory(),
    sampler: null,
    config: { knownLockers: [], rangeSigmaMultiplier: 1.5, factsTtlMs: 60_000 },
    log: () => undefined
  };
  return { deps, reader };
}

async function get(deps: AppDeps, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await createApp(deps).request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("app", () => {
  it("routes V2 zap reads to the selected published engine and rejects unknown engines",async()=>{
    const {deps,reader}=build();
    const nativeReader=new FakeReader();
    const status={enabled:false,reason:"paused",chainId:46630,vault:A.bob,router:null,quoter:null,weth:null,feeBps:100,terms:[604800],items:[],routingPools:[]};
    deps.zapContexts={[A.bob]:{reader:nativeReader,deployment:{...deps.deployment,dealVault:A.bob},zapStatus:async()=>status}};
    expect(await get(deps,`/zap/pools?engine=${A.bob}`)).toMatchObject({status:200,body:{vault:A.bob,reason:"paused"}});
    expect(nativeReader.snapshotCalls).toBe(1);
    expect(reader.snapshotCalls).toBe(0);
    expect(await get(deps,`/zap/pools?engine=${A.alice}`)).toMatchObject({status:404});
    expect(await get(deps,`/quote/lp-zap?engine=${A.alice}`)).toMatchObject({status:404});
    expect(await get(deps,"/zap/pools?engine=invalid")).toMatchObject({status:400});
  });
  it("values a wallet LP before it has been listed as a deal", async () => {
    const { deps, reader } = build();
    reader.addPositionDeal(1n, 7n, 100n, NVDA_KEY, -887220, 887220, 10n ** 15n);
    reader.deals.clear();
    const result = await get(deps, "/positions/7/value");
    expect(result.status).toBe(200);
    expect(BigInt(result.body.valueUSDG as string)).toBeGreaterThan(0n);
    expect(result.body.position).toMatchObject({ quoteAsset: { symbol: "USDG" }, assetIsCurrency0: false });
    expect(await get(deps, "/positions/0/value")).toMatchObject({ status: 400 });
    expect(await get(deps, "/positions/8/value")).toMatchObject({ status: 404 });
  });
  it("serves /health with chain, block, deployment and indexer state", async () => {
    const { deps } = build();
    const r = await get(deps, "/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, chainId: 46630, block: 1000 });
    expect(r.body.deployment).toMatchObject({ v4: true, pools: ["nvdaUsdg", "nvdogNvda", "gageSgage", "gageEth", "usdgEth"] });
    expect(r.body.indexer).toMatchObject({ ok: false });
  });

  it("fails health and economic requests when RPC and deployment chains differ", async () => {
    const { deps, reader } = build();
    reader.chainId = () => Promise.resolve(1);
    const health = await get(deps, "/health");
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ ok: false, chainId: 1, deployment: { chainId: 46630 } });
    expect(health.body.reason).toContain("does not match");
    const value = await get(deps, `/assets/${A.NVDAx}/value`);
    expect(value.status).toBe(503);
    expect(value.body).toMatchObject({ error: { code: "WRONG_CHAIN" } });
    expect(reader.snapshotCalls).toBe(0);
  });

  it("answers NO_POOL (503) for pool-backed endpoints while the token layer is absent", async () => {
    const { deps, reader } = build(false);
    reader.addDeal(1n, A.NVDAx, 10n ** 18n, 10n ** 6n, "STOCK");
    for (const path of ["/deals/1/valuation", `/assets/${A.NVDAx}/value`, "/range/suggest?pool=gageSgage&term=7", "/quote/reinvest?amount=1&tickLower=-60&tickUpper=60", "/quote/entry?eth=1", "/quote/payout?usdg=1&to=ETH"]) {
      const r = await get(deps, path);
      expect(r.status, path).toBe(503);
      expect((r.body.error as { code: string }).code, path).toBe("NO_POOL");
    }
  });

  it("values a deal and an asset", async () => {
    const { deps, reader } = build();
    reader.addDeal(1n, A.NVDAx, 10n ** 18n, 80n * 10n ** 6n, "STOCK");
    const deal = await get(deps, "/deals/1/valuation");
    expect(deal.status).toBe(200);
    expect(deal.body).toMatchObject({ dealId: 1, valueUSDG: (100n * 10n ** 6n).toString(), priceUSDG: "100" });
    const asset = await get(deps, `/assets/${A.NVDAx}/value`);
    expect(asset.body).toMatchObject({ token: A.NVDAx, priceUSDG: "100" });
    expect(await get(deps, "/deals/7/valuation")).toMatchObject({ status: 404 });
    expect(await get(deps, "/deals/x/valuation")).toMatchObject({ status: 400 });
  });

  it("suggests a range with the mandated note and rejects bad terms", async () => {
    const { deps } = build();
    const r = await get(deps, "/range/suggest?pool=gageSgage&term=21");
    expect(r.status).toBe(200);
    const rec = r.body.recommended as { note: string; tickLower: number; tickUpper: number };
    expect(rec.note).toBe(RANGE_NOTE);
    expect(rec.tickLower).toBeLessThan(0);
    expect(rec.tickUpper).toBeGreaterThan(0);
    expect(await get(deps, "/range/suggest?pool=gageSgage&term=45")).toMatchObject({ status: 400 });
    expect(await get(deps, "/range/suggest?pool=nope&term=7")).toMatchObject({ status: 404 });
  });

  it("quotes reinvest, entry and payout", async () => {
    const { deps } = build();
    const m = await get(deps, "/quote/reinvest?amount=1000000000000000000&tickLower=-6000&tickUpper=6000&route=match&payAsset=USDG");
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ route: "match", payAsset: "USDG" });
    const z = await get(deps, "/quote/reinvest?amount=1000000000000000000&tickLower=-6000&tickUpper=6000&route=zap");
    expect(z.body).toMatchObject({ route: "zap" });
    expect(await get(deps, "/quote/reinvest?amount=1&tickLower=-60&tickUpper=60&route=other")).toMatchObject({ status: 400 });
    expect(await get(deps, "/quote/reinvest?amount=1&tickLower=-60&tickUpper=60&route=zap&inputAsset=BTC")).toMatchObject({ status: 400 });
    expect(await get(deps, "/quote/reinvest?amount=1000000000000000000&tickLower=-6000&tickUpper=6000&route=match&inputAsset=GAGE")).toMatchObject({ status: 400 });
    expect(await get(deps, "/quote/reinvest?amount=1000000000000000000&tickLower=-6000&tickUpper=6000&route=zap&inputAsset=GAGE")).toMatchObject({ status: 200, body: { route: "gage-zap", inputAsset: "GAGE", pools: ["gageSgage"] } });
    for (const [input, amount] of [["ETH", "1000000000000000"], ["USDG", "1000000"]]) {
      expect(await get(deps, `/quote/reinvest?amount=${amount}&tickLower=-6000&tickUpper=6000&route=zap&inputAsset=${input}`)).toMatchObject({ status: 200, body: { route: "funded-zap", inputAsset: input } });
    }
    const e = await get(deps, "/quote/entry?eth=1000000000000000000");
    expect(e.status).toBe(200);
    expect(BigInt(e.body.usdgOut as string)).toBeGreaterThan(0n);
    const p = await get(deps, `/quote/payout?usdg=1000000000&to=${A.NVDAx}&slippageBps=50`);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ slippageBps: 50 });
    expect((p.body.route as { pools: string[] }).pools).toEqual(["nvdaUsdg"]);
    expect(await get(deps, "/quote/payout?usdg=1&to=USDC")).toMatchObject({ status: 400 });
  });

  it("serves facts and caches them per token", async () => {
    const { deps, reader } = build();
    reader.configs.set(A.NVDOG, { allowed: true, lane: "MEME", minAmount: 1n, maxDealRaw: 1n, maxOpenRaw: 1n });
    reader.configs.set(A.NVDAx, { allowed: true, lane: "STOCK", minAmount: 1n, maxDealRaw: 1n, maxOpenRaw: 1n });
    reader.supplies.set(A.NVDOG, 10n ** 24n);
    const app = createApp(deps);
    const a = (await (await app.request(`/assets/${A.NVDOG}/facts`)).json()) as { checkedAt: number; eligible: boolean; lane: string };
    expect(a.lane).toBe("MEME");
    expect(a.eligible).toBe(false);
    const b = (await (await app.request(`/assets/${A.NVDOG}/facts`)).json()) as { checkedAt: number };
    expect(b.checkedAt).toBe(a.checkedAt);
    reader.chainId = () => Promise.resolve(1);
    const wrongChain = await app.request(`/assets/${A.NVDOG}/facts`);
    expect(wrongChain.status).toBe(503);
    expect(await wrongChain.json()).toMatchObject({ error: { code: "WRONG_CHAIN" } });
    expect(await get(deps, "/assets/notanaddress/facts")).toMatchObject({ status: 400 });
  });

  it("404s unknown routes as JSON", async () => {
    const { deps } = build();
    const r = await get(deps, "/nope");
    expect(r.status).toBe(404);
    expect((r.body.error as { code: string }).code).toBe("NOT_FOUND");
  });
});
