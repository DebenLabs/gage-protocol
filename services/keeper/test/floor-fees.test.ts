import { expect, it } from "vitest";
import type { Chain, PublicClient, Transport } from "viem";
import { executeFloorClip, feeBatchClip, runFloorFees } from "../src/jobs/floor-fees.js";
import { A, m6Deployment, mockCtx } from "./helpers.js";

it("opens at exactly the trigger, preserves existing batches below it and caps spending", () => {
  expect(feeBatchClip(99n, 99n, 100n, 0n, 100n)).toBe(0n);
  expect(feeBatchClip(100n, 100n, 100n, 0n, 25n)).toBe(25n);
  expect(feeBatchClip(90n, 90n, 100n, 75n, 100n)).toBe(75n);
  expect(feeBatchClip(20n, 20n, 100n, 75n, 100n)).toBe(20n);
});

it("finds an economical clip between a price failure and a smaller gas refusal", async () => {
  const ctx = mockCtx();
  ctx.sender.script.clip = call => call.args?.[0] === 100n
    ? { status: "reverted", revert: {name: "TooLittleOut", args: [], message: "impact"} }
    : call.args?.[0] === 50n ? { status: "refused", reason: "uneconomic_gas" }
    : {status: "dry", result: 75n};
  const out = await executeFloorClip(ctx, 100n, 1n, n => ({label: "clip", address: A.splitter, abi: [], functionName: "process", args: [n], maxGasCostWei: n}));
  expect(out).toEqual({status: "dry", result: 75n});
  expect(ctx.sender.calls.map(c => c.args?.[0])).toEqual([100n, 50n, 75n]);
});

it("waits when the largest allowed clip is uneconomic, without shrinking it", async () => {
  const ctx=mockCtx();ctx.sender.script.clip={status:"refused",reason:"uneconomic_gas"};
  expect(await executeFloorClip(ctx,100n,1n,n=>({label:"clip",address:A.splitter,abi:[],functionName:"process",args:[n]}))).toEqual({status:"refused",reason:"uneconomic_gas"});
  expect(ctx.sender.calls).toHaveLength(1);
});

it("does not submit claims, fee collection or swaps below both triggers", async () => {
  const deployment = m6Deployment();
  delete deployment.addresses.Buyback; deployment.addresses.DealFeeRouter = A.buyback;
  const ctx = mockCtx({deployment, env: {MAX_CLIP_USDG: "100"}});
  const pub = {
    getBalance: () => Promise.resolve(0n),
    simulateContract: () => Promise.resolve({result: 10n ** 15n}),
    readContract: (r: {functionName: string}) => Promise.resolve({ethValueUSDG: 2500_000_000n, threshold: 100_000_000n, batchRemaining: 0n, availableUSDG: 99_000_000n}[r.functionName])
  } as unknown as PublicClient<Transport, Chain>;
  await runFloorFees(ctx, pub);
  expect(ctx.sender.calls).toEqual([]);
});

it("uses the floor half of creator fees for gas budgeting and the full deal fee value", async () => {
  const deployment = m6Deployment();
  delete deployment.addresses.Buyback; deployment.addresses.DealFeeRouter = A.buyback;
  const ctx = mockCtx({deployment, env: {MAX_CLIP_USDG: "100"}});
  const pub = {
    getBalance: () => Promise.resolve(0n),
    simulateContract: () => Promise.resolve({result: 5n * 10n ** 16n}),
    readContract: (r: {functionName: string}) => Promise.resolve({ethValueUSDG: 2500_000_000n, threshold: 100_000_000n, batchRemaining: 0n, availableUSDG: 100_000_000n}[r.functionName])
  } as unknown as PublicClient<Transport, Chain>;
  await runFloorFees(ctx, pub);
  expect(ctx.sender.calls.map(c => c.functionName)).toEqual(["process", "claimAndSplit"]);
  expect(ctx.sender.calls[0]?.maxGasCostWei).toBe(392_000_000_000_000n);
  expect(ctx.sender.calls[1]?.maxGasCostWei).toBe(250_000_000_000_000n);
});
