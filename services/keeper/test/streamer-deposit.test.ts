import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { decideDeposit, dripIdOf, runStreamerDeposit } from "../src/jobs/streamer-deposit.js";
import type { EmissionsState } from "../src/views.js";
import { A, m6Deployment, mockCtx, msgs, streamerDeployment } from "./helpers.js";

const SGAGE = 10n ** 18n;
const signer = "0x1000000000000000000000000000000000000001" as Address;

function emissions(currentEpoch: bigint): EmissionsState {
  return { launchAt: 1_000n, currentEpoch, weeks: 52n, epochSeconds: 604_800n, scheduleOver: false };
}

describe("dripIdOf", () => {
  it("matches DealRewards.dripIdOf: keccak256(abi.encode(\"deal\", dealId, party))", () => {
    // cast keccak $(cast abi-encode "f(string,uint256,address)" deal 7 0x1000000000000000000000000000000000000001)
    expect(dripIdOf(7n, signer)).toBe("0xc85fc37259c3af1d3685102fbf1ed9274b90cb7ea70a0308c1d2fb7d9a3a8a7d");
  });
});

describe("decideDeposit", () => {
  const minimum = 1_000n * SGAGE;
  it("deposits the whole balance for the next epoch once it clears the minimum", () => {
    expect(decideDeposit({ currentEpoch: 3n, weeks: 52n, balance: 1_000n * SGAGE, minimum })).toEqual({ action: "deposit", amount: 1_000n * SGAGE, forEpoch: 4n });
    expect(decideDeposit({ currentEpoch: 3n, weeks: 52n, balance: 999n * SGAGE, minimum })).toEqual({ action: "skip", reason: "below_minimum" });
    expect(decideDeposit({ currentEpoch: 3n, weeks: 52n, balance: 0n, minimum: 0n })).toEqual({ action: "skip", reason: "below_minimum" });
  });
  it("stops one epoch before the table ends, where the contract reverts ScheduleOver", () => {
    expect(decideDeposit({ currentEpoch: 50n, weeks: 52n, balance: minimum, minimum })).toMatchObject({ action: "deposit", forEpoch: 51n });
    expect(decideDeposit({ currentEpoch: 51n, weeks: 52n, balance: minimum, minimum })).toEqual({ action: "skip", reason: "schedule_over" });
    expect(decideDeposit({ currentEpoch: 52n, weeks: 52n, balance: minimum, minimum })).toEqual({ action: "skip", reason: "schedule_over" });
  });
});

describe("runStreamerDeposit", () => {
  it("skips cleanly without the LPStreamer key", async () => {
    const ctx = mockCtx({ deployment: m6Deployment(), signer });
    await runStreamerDeposit(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "job_skipped")?.missing).toEqual(["LPStreamer"]);
  });

  it("skips without a wallet: there is nothing to claim for and nothing to deposit from", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment() });
    await runStreamerDeposit(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "job_skipped")?.reason).toBe("no_wallet");
  });

  it("skips with a reason once the next epoch would be the table's last", async () => {
    const ctx = mockCtx({ deployment: streamerDeployment(), signer, views: { emissionsState: () => Promise.resolve(emissions(51n)) } });
    ctx.state.backstopDeals = ["7"];
    await runStreamerDeposit(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "streamer_deposit_skipped")?.reason).toBe("schedule_over");
  });

  it("claims the backstop drips, approves and deposits the whole balance", async () => {
    const claimed: string[][] = [];
    const ctx = mockCtx({
      deployment: streamerDeployment(),
      signer,
      views: {
        emissionsState: () => Promise.resolve(emissions(3n)),
        dripClaimable: (drip, account, ids) => {
          expect(drip).toBe(A.drip);
          expect(account).toBe(signer);
          claimed.push([...ids]);
          return Promise.resolve(ids.map((id) => (id === dripIdOf(7n, signer) ? 5n * SGAGE : 0n)));
        },
        erc20Balance: (token, owner) => {
          expect(token).toBe(A.sgage);
          expect(owner).toBe(signer);
          return Promise.resolve(2_000n * SGAGE);
        },
        erc20Allowance: () => Promise.resolve(0n),
      },
    });
    ctx.state.backstopDeals = ["7", "8"];
    ctx.sender.script["LPStreamer.deposit"] = { status: "sent", hash: "0x01", gasUsed: 1n, result: undefined };
    await runStreamerDeposit(ctx);
    expect(claimed).toEqual([[dripIdOf(7n, signer), dripIdOf(8n, signer)]]);
    expect(ctx.sender.calls.map((c) => [c.label, c.address, c.args])).toEqual([
      ["Drip.claimMany", A.drip, [[dripIdOf(7n, signer)]]],
      ["sGAGE.approve", A.sgage, [A.streamer, 2_000n * SGAGE]],
      ["LPStreamer.deposit", A.streamer, [2_000n * SGAGE]],
    ]);
    expect(ctx.state.lastStreamerDeposit).toEqual({ amount: (2_000n * SGAGE).toString(), forEpoch: "4", at: ctx.now() });
    expect(msgs(ctx)).toContain("streamer_deposit");
  });

  it("holds a balance below the minimum and skips the approval when the allowance already covers it", async () => {
    let balance = 500n * SGAGE;
    const ctx = mockCtx({
      deployment: streamerDeployment(),
      signer,
      views: {
        emissionsState: () => Promise.resolve(emissions(3n)),
        erc20Balance: () => Promise.resolve(balance),
        erc20Allowance: () => Promise.resolve(10_000n * SGAGE),
      },
    });
    await runStreamerDeposit(ctx);
    expect(ctx.sender.calls).toEqual([]);
    expect(ctx.lines.find((l) => l.msg === "streamer_deposit_skipped")?.reason).toBe("below_minimum");
    balance = 1_000n * SGAGE;
    await runStreamerDeposit(ctx);
    expect(ctx.sender.calls.map((c) => c.label)).toEqual(["LPStreamer.deposit"]);
  });
});
