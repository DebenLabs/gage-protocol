import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "ponder:registry";
import type * as PonderModule from "ponder";
import type * as EarnSyncModule from "../src/lib/earn-sync";
import type { EarnAddress } from "../../../shared/earn";

type BlockHandler = (input: { event: { block: { number: bigint; timestamp: bigint }; [key: string]: unknown }; context: Context }) => Promise<void>;
const fixture = vi.hoisted(() => ({
  handlers: new Map<string, BlockHandler>(),
  entry: { id: "stocks", title: "Stocks", HybridVault: "0x0000000000000000000000000000000000000001", HybridReserve: "0x0000000000000000000000000000000000000002", core: "0x0000000000000000000000000000000000000003", startBlock: 100 },
  calls: [] as string[],
  current: { ready: true, block: 100n } as { ready: boolean; block: bigint } | undefined,
  failAccounts: false,
  coreTracked: true,
  token: undefined as string | undefined,
}));
vi.mock("ponder:registry", () => ({ ponder: { on: (name: string, handler: BlockHandler) => fixture.handlers.set(name, handler) } }));
vi.mock("ponder:schema", () => Object.fromEntries([
  "earnReserveSamples", "earnTokenInventory", "earnAccountRefresh", "earnAccountHistory", "earnAccountPockets", "earnAccountPocketProgress", "earnShareChanges", "earnLoanSnapshots", "earnPocketClaims", "earnAccounts", "earnApprovals", "earnEvents", "earnLoans", "earnPockets", "earnRequests", "earnRequestCounts", "earnStrategies",
].map(name => [name, { name }])));
vi.mock("ponder", async original => ({ ...await original<typeof PonderModule>(), createConfig: (config: unknown) => config }));
vi.mock("../src/lib/deployment", () => ({
  CHAIN_NAME: "robinhood",
  loadDeployment: () => ({ chainId: 4663, earnStrategies: [fixture.entry], m1: {}, token: {}, pools: [], startBlock: 100, tokenStartBlock: 100 }),
}));
vi.mock("../src/lib/position-history", () => ({ loadPositionHistory: () => undefined }));
vi.mock("../src/lib/earn-sync", async original => ({
  ...await original<typeof EarnSyncModule>(),
  syncEarnLoans: async () => { fixture.calls.push("loans"); },
  syncEarnStrategy: async (_config: unknown, _read: unknown, _store: unknown, block: bigint, _asOf: bigint, token?: string) => {
    fixture.calls.push("strategy");
    fixture.token = token;
    fixture.current = { ready: false, block };
  },
  syncEarnAccounts: async () => {
    fixture.calls.push("accounts");
    if (fixture.failAccounts) throw new Error("Account publication failed");
  },
  syncEarnCoreLoan: async () => { fixture.calls.push("core"); return fixture.coreTracked || undefined; },
}));

import config from "../ponder.config";
import { refreshEarnCoreLoan } from "../src/earn";

const context = {
  db: {
    find: async () => fixture.current,
    update: () => ({ set: async (value: { ready: boolean }) => {
      fixture.calls.push("publish");
      fixture.current!.ready = value.ready;
    } }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => { fixture.calls.push("inventory"); } }) }),
  },
  client: { getCode: async () => { fixture.calls.push("readiness"); return undefined; } },
} as unknown as Context;
const publish = (block: bigint, asOf = BigInt(Math.floor(Date.now() / 1000))) => fixture.handlers.get("EarnSnapshot:block")!({ event: { block: { number: block, timestamp: asOf } }, context });
const vaultEvent = (name: string, block = 101n, args: Record<string, unknown> = {}) => fixture.handlers.get(`HybridVault:${name}`)!({
  event: { block: { number: block, timestamp: BigInt(Math.floor(Date.now() / 1000)) },
    log: { address: fixture.entry.HybridVault, logIndex: 0 }, transaction: { hash: "0x01" }, args }, context,
});

beforeEach(() => {
  fixture.current = { ready: true, block: 100n };
  fixture.calls = [];
  fixture.failAccounts = false;
  fixture.coreTracked = true;
  fixture.token = undefined;
});

describe("Earn block publication", () => {
  it("keeps historical block-header sampling at the 100-block refresh cadence", () => {
    expect(config.blocks?.EarnSnapshot?.interval).toBe(100);
  });

  it.each(["MaxTotalDepositsSet", "FeesSet", "ReserveInvested"])("publishes %s between periodic callbacks after full reconciliation", async name => {
    await vaultEvent(name);
    expect(fixture.calls).toEqual(["loans", "strategy", "accounts", "publish"]);
    expect(fixture.current).toEqual({ ready: true, block: 101n });
    fixture.calls = [];
    await publish(200n);
    expect(fixture.calls).toEqual([]);
  });

  it.each(["vault", "core", "periodic"])("does not publish when %s reconciliation fails", async kind => {
    fixture.failAccounts = true;
    const result = kind === "vault" ? vaultEvent("MaxTotalDepositsSet")
      : kind === "core" ? refreshEarnCoreLoan(context, fixture.entry.core as EarnAddress, 1n, 101n, 1n)
      : publish(200n);
    await expect(result).rejects.toThrow("Account publication failed");
    expect(fixture.current?.ready).toBe(false);
    expect(fixture.calls).not.toContain("publish");
  });

  it("retains the 100-block live refresh cadence on unrelated blocks", async () => {
    await publish(199n);
    expect(fixture.calls).toEqual([]);
    await publish(200n);
    expect(fixture.calls).toEqual(["loans", "strategy", "accounts", "publish"]);
  });

  it("retains the 6000-block backfill cadence", async () => {
    await publish(6099n, 1n);
    expect(fixture.calls).toEqual([]);
    await publish(6100n, 1n);
    expect(fixture.current).toEqual({ ready: true, block: 6100n });
  });

  it("includes newly admitted tokens before publishing their settings", async () => {
    const token = "0x0000000000000000000000000000000000000004";
    await vaultEvent("TokenCeilingSet", 101n, { token });
    expect(fixture.calls).toEqual(["inventory", "loans", "strategy", "accounts", "publish"]);
    expect(fixture.token).toBe(token);
    expect(fixture.current).toEqual({ ready: true, block: 101n });
  });

  it("publishes tracked core changes without waiting for a vault event or periodic callback", async () => {
    await refreshEarnCoreLoan(context, fixture.entry.core as EarnAddress, 1n, 101n, 1n);
    expect(fixture.calls).toEqual(["core", "loans", "strategy", "accounts", "publish"]);
    expect(fixture.current).toEqual({ ready: true, block: 101n });
  });

  it("does not reconcile an unrelated core position", async () => {
    fixture.coreTracked = false;
    await refreshEarnCoreLoan(context, fixture.entry.core as EarnAddress, 1n, 101n, 1n);
    expect(fixture.calls).toEqual(["core"]);
    expect(fixture.current).toEqual({ ready: true, block: 100n });
  });
});
