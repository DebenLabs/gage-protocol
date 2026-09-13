/**
 * The five automated contract checks of spec 7.4: mint after launch, pause, transfer tax, blocklist, proxy. Pure
 * over inputs the facts service gathers, so they are unit-testable without a chain.
 */
import { toFunctionSelector, type Address, type Hex } from "viem";
import type { TransferProbeResult } from "../chain/reader.js";
import type { AddressInfo } from "./explorer.js";

export type CheckStatus = "pass" | "fail" | "unknown";
export interface Check {
  status: CheckStatus;
  detail: string;
}
export interface Checks {
  mintAfterLaunch: Check;
  pause: Check;
  transferTax: Check;
  blocklist: Check;
  proxy: Check;
}

const sel = (sig: string): string => toFunctionSelector(sig).slice(2);

export const SELECTORS = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "issue(address,uint256)", "mint(address,uint256,bytes)"],
  pause: ["paused()", "pause()", "unpause()", "setPaused(bool)"],
  blocklist: [
    "isBlocked(address)",
    "isFrozen(address)",
    "blacklist(address)",
    "isBlacklisted(address)",
    "isBlackListed(address)",
    "blocked(address)",
    "frozen(address)",
    "blacklisted(address)",
    "freeze(address)",
    "unfreeze(address)",
    "addToBlacklist(address)",
    "blockAccount(address)",
    "unblockAccount(address)",
    "isBlocklisted(address)"
  ],
  tax: [
    "taxFee()",
    "buyTax()",
    "sellTax()",
    "transferTax()",
    "setTaxes(uint256,uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "excludeFromFee(address)",
    "isExcludedFromFee(address)",
    "excludeFromFees(address,bool)",
    "swapTokensAtAmount()",
    "marketingWallet()"
  ],
  proxy: ["implementation()", "upgradeTo(address)", "upgradeToAndCall(address,bytes)"]
} as const;

/** EIP-1967 slots. */
export const IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

/** Signatures whose selector appears as a PUSH4 immediate (0x63 <selector>) in the runtime bytecode. */
export function selectorsInBytecode(bytecode: Hex, signatures: readonly string[]): string[] {
  const code = bytecode.toLowerCase().replace(/^0x/, "");
  const selectors = new Set<string>();
  for (let pc = 0; pc < code.length; pc += 2) {
    const op = Number.parseInt(code.slice(pc, pc + 2), 16);
    if (op === 0x63) selectors.add(code.slice(pc + 2, pc + 10));
    if (op >= 0x60 && op <= 0x7f) pc += (op - 0x5f) * 2;
  }
  return signatures.filter((sig) => selectors.has(sel(sig)));
}

/** Conservatively detect delegated execution, including minimal clones and immutable-beacon proxies. */
export function hasDelegateCall(bytecode: Hex): boolean {
  const code = bytecode.slice(2);
  for (let pc = 0; pc < code.length; pc += 2) {
    const op = Number.parseInt(code.slice(pc, pc + 2), 16);
    if (op === 0xf4 || op === 0xf2) return true;
    if (op >= 0x60 && op <= 0x7f) pc += (op - 0x5f) * 2;
  }
  return false;
}

export interface CheckInputs {
  bytecode: Hex;
  /** `paused()` return value; null if the call reverted or the selector is absent. */
  pausedCall: boolean | null;
  probe: TransferProbeResult | null;
  probeAmount: bigint;
  probeHolder: Address | null;
  implementationSlot: Hex | null;
  beaconSlot: Hex | null;
  explorer: AddressInfo | null;
  /** totalSupply now and at the pool's creation block (null when unknown). */
  supplyNow: bigint;
  supplyAtLaunch: bigint | null;
}

function nonZeroSlot(v: Hex | null): boolean {
  return v !== null && /^0x0*[1-9a-f]/i.test(v);
}

export function runChecks(i: CheckInputs): Checks {
  const empty = i.bytecode === "0x" || i.bytecode.length <= 2;
  const list = (sigs: string[]): string => sigs.join(", ");

  // mint after launch
  let mintAfterLaunch: Check;
  if (empty) mintAfterLaunch = { status: "unknown", detail: "no bytecode at this address" };
  else {
    const found = selectorsInBytecode(i.bytecode, SELECTORS.mint);
    if (found.length > 0) mintAfterLaunch = { status: "fail", detail: `the contract exposes ${list(found)}, so supply can grow after launch` };
    else if (i.supplyAtLaunch !== null && i.supplyNow > i.supplyAtLaunch) mintAfterLaunch = { status: "fail", detail: `total supply grew from ${i.supplyAtLaunch} to ${i.supplyNow} after the pool was created` };
    else if (i.supplyAtLaunch !== null) mintAfterLaunch = { status: "pass", detail: "no mint function found and total supply is unchanged since the pool was created" };
    else mintAfterLaunch = { status: "pass", detail: "no mint function found; supply history not compared because the pool creation block is unknown" };
  }

  // pause
  let pause: Check;
  if (empty) pause = { status: "unknown", detail: "no bytecode at this address" };
  else {
    const found = selectorsInBytecode(i.bytecode, SELECTORS.pause);
    if (i.pausedCall !== null) pause = { status: "fail", detail: `the contract exposes paused() (currently ${i.pausedCall ? "paused" : "not paused"}); transfers can be stopped` };
    else if (found.length > 0) pause = { status: "fail", detail: `the contract exposes ${list(found)}; transfers can be stopped` };
    else pause = { status: "pass", detail: "no pause function found" };
  }

  // transfer tax
  let transferTax: Check;
  const taxSelectors = empty ? [] : selectorsInBytecode(i.bytecode, SELECTORS.tax);
  if (i.probe !== null && i.probe.ok && i.probe.sentDelta > 0n) {
    if (i.probe.receivedDelta === i.probe.sentDelta && i.probe.sentDelta === i.probeAmount) {
      transferTax = taxSelectors.length > 0
        ? { status: "fail", detail: `a simulated transfer of ${i.probeAmount} arrived in full, but the contract exposes ${list(taxSelectors)}, so a tax can be switched on` }
        : { status: "pass", detail: `a simulated transfer of ${i.probeAmount} from ${i.probeHolder ?? "a holder"} arrived in full` };
    } else {
      const lost = i.probe.sentDelta - i.probe.receivedDelta;
      const bps = Number((lost * 10_000n) / i.probe.sentDelta);
      transferTax = { status: "fail", detail: `a simulated transfer of ${i.probe.sentDelta} delivered ${i.probe.receivedDelta}: ${(bps / 100).toFixed(2)}% is taken on transfer` };
    }
  } else if (i.probe !== null) {
    transferTax = taxSelectors.length > 0
      ? { status: "fail", detail: `the contract exposes ${list(taxSelectors)}; the simulated transfer did not go through` }
      : { status: "unknown", detail: "the simulated transfer did not go through (paused, blocked or empty holder), so the tax could not be measured" };
  } else {
    transferTax = taxSelectors.length > 0
      ? { status: "fail", detail: `the contract exposes ${list(taxSelectors)}` }
      : { status: "unknown", detail: "transfer simulation unavailable (no holder found or the node rejects state overrides) and no tax functions found" };
  }

  // blocklist
  let blocklist: Check;
  if (empty) blocklist = { status: "unknown", detail: "no bytecode at this address" };
  else {
    const found = selectorsInBytecode(i.bytecode, SELECTORS.blocklist);
    blocklist = found.length > 0 ? { status: "fail", detail: `the contract exposes ${list(found)}; accounts can be blocked from transferring` } : { status: "pass", detail: "no blocklist or freeze function found" };
  }

  // proxy
  let proxy: Check;
  if (empty) proxy = { status: "unknown", detail: "no bytecode at this address" };
  else if (nonZeroSlot(i.implementationSlot)) proxy = { status: "fail", detail: `EIP-1967 implementation slot is set (${i.implementationSlot}); the code can be swapped` };
  else if (nonZeroSlot(i.beaconSlot)) proxy = { status: "fail", detail: `EIP-1967 beacon slot is set (${i.beaconSlot}); the code can be swapped` };
  else if (i.explorer !== null && (i.explorer.proxyType !== null || i.explorer.implementations.length > 0)) proxy = { status: "fail", detail: `the explorer marks this contract as a ${i.explorer.proxyType ?? "proxy"}` };
  else {
    const found = selectorsInBytecode(i.bytecode, SELECTORS.proxy);
    if (found.length > 0) proxy = { status: "fail", detail: `the contract exposes ${list(found)}` };
    else if (i.implementationSlot === null && i.beaconSlot === null) proxy = { status: "unknown", detail: "storage slots could not be read" };
    else proxy = { status: "pass", detail: "no EIP-1967 slots set, no upgrade functions, explorer shows no proxy" };
  }

  const delegated = hasDelegateCall(i.bytecode) || nonZeroSlot(i.implementationSlot) || nonZeroSlot(i.beaconSlot)
    || (i.explorer !== null && (i.explorer.proxyType !== null || i.explorer.implementations.length > 0));
  if (delegated) {
    const unknown: Check = { status: "unknown", detail: "execution is delegated; these checks do not inspect the implementation, so absence of controls cannot be confirmed" };
    if (mintAfterLaunch.status === "pass") mintAfterLaunch = unknown;
    if (pause.status === "pass") pause = unknown;
    if (blocklist.status === "pass") blocklist = unknown;
    if (proxy.status === "pass" || proxy.status === "unknown") proxy = { status: "fail", detail: "delegated execution detected; this may be an immutable clone or an upgradeable proxy, and the implementation needs review" };
  }
  return { mintAfterLaunch, pause, transferTax, blocklist, proxy };
}

export function failedChecks(c: Checks): string[] {
  return (Object.keys(c) as Array<keyof Checks>).filter((k) => c[k].status === "fail");
}

export function unknownChecks(c: Checks): string[] {
  return (Object.keys(c) as Array<keyof Checks>).filter((k) => c[k].status === "unknown");
}
