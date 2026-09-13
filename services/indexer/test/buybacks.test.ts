import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { creatorGageBought, type PurchaseLog } from "../src/lib/buybacks";
const buyer = `0x${"1".repeat(40)}` as Address;
const curve = `0x${"2".repeat(40)}` as Address;
const poolManager = `0x${"3".repeat(40)}` as Address;
const other = `0x${"4".repeat(40)}` as Address;
const poolId = `0x${"a".repeat(64)}` as Hex;
const abi = parseAbi([
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const gage = `0x${"5".repeat(40)}` as Address;
const market = { buyer, gage, curve, poolManager, poolId };
const transferLog = (to = buyer, value = 693n): PurchaseLog => ({ address: gage,
  topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: poolManager, to } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});
const curveLog = (who = buyer, emitter = curve): PurchaseLog => ({ address: emitter,
  topics: encodeEventTopics({ abi, eventName: "CurveBuy", args: { buyer: who, recipient: who } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1n, 123456789012345678901234567n, 0n, 0n]),
});
const swapLog = (id = poolId, sender = buyer, output = 700n): PurchaseLog => ({ address: poolManager,
  topics: encodeEventTopics({ abi, eventName: "Swap", args: { id, sender } }) as Hex[],
  data: encodeAbiParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }], [-1n, output, 1n, 1n, 0, 0]),
});
describe("creator-fee GAGE purchases", () => {
  it("sums pre/post-graduation purchases net of hook fees, excluding later recycled transfers", () => {
    expect(creatorGageBought([curveLog(), swapLog(), transferLog(other, 7n), transferLog(), transferLog(buyer, 123n)], market)).toBe(123456789012345678901235260n);
  });
  it("excludes other buyers, other pools, wrong emitters, sells and recycled transfers", () => {
    const recycled: PurchaseLog = { address: other,
      topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: poolManager, to: buyer } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [999999n]),
    };
    expect(creatorGageBought([curveLog(other), curveLog(buyer, poolManager), swapLog(`0x${"b".repeat(64)}`), swapLog(poolId, other), swapLog(poolId, buyer, -5n), recycled], market)).toBe(0n);
  });
});
