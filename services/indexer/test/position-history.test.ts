import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { parsePositionHistory, positionHistoryCandidates, type PositionHistory } from "../src/lib/position-history";
import { walletPositions } from "../src/lib/wallet-positions";
const a = `0x${"1".repeat(40)}` as Address, b = `0x${"2".repeat(40)}` as Address, hash = `0x${"3".repeat(64)}` as Hex;
const history: PositionHistory = {chainId:4663,anchorBlock:10,anchorHash:hash,positionManager:a,poolIds:[hash],tokenIds:["1","2"],firstBlock:1,eventCount:2,owners:{"1":a,"2":b}};
describe("pool ownership snapshot discovery", () => {
  it("selects the wallet's snapshot candidates and preserves legacy inventories", () => {
    expect(positionHistoryCandidates(history,a)).toEqual(["1"]);
    expect(positionHistoryCandidates({...history,owners:undefined},a)).toEqual(["1","2"]);
  });
  it("rejects incomplete ownership snapshots", () => {
    expect(() => parsePositionHistory(JSON.stringify({...history,owners:{"1":a}}),4663,a,11)).toThrow("incomplete");
    expect(parsePositionHistory(JSON.stringify(history),4663,a,11).owners).toEqual(history.owners);
  });
  it("combines snapshot candidates with subsequent indexed receipts and rechecks current ownership", async () => {
    let checked: readonly bigint[] = [];
    await walletPositions(a, positionHistoryCandidates(history,a), [2n], {
      blockNumber:async()=>20n,
      owners:async ids=>{checked=ids;return [b,a];},
      position:async id=>{expect(id).toBe(2n);return {key:{currency0:a,currency1:b,fee:3000,tickSpacing:60,hooks:`0x${"0".repeat(40)}`},info:0n,liquidity:1n};},
      allowed:async()=>true,
    }, []);
    expect(checked).toEqual([1n,2n]);
  });
});
