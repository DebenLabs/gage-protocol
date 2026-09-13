import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";

const purchases = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
export type PurchaseLog = { address: Address; data: Hex; topics: readonly Hex[] };
export type PurchaseMarket = { buyer: Address; gage: Address; curve: Address; poolManager: Address; poolId: Hex };

/** Actual launch-market purchases, not FloorAdded (which can also contain recycled fees/donations).
 * The deployment's ETH/GAGE market has ETH as currency0 and GAGE as currency1.
 */
export function creatorGageBought(logs: readonly PurchaseLog[], market: PurchaseMarket): bigint {
  let total = 0n;
  let awaitingSwapOutput = false;
  for (const log of logs) {
    const emitter = log.address.toLowerCase();
    if (emitter !== market.curve.toLowerCase() && emitter !== market.poolManager.toLowerCase() && emitter !== market.gage.toLowerCase()) continue;
    let event;
    try { event = decodeEventLog({ abi: purchases, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] }); }
    catch { continue; }
    if (event.eventName === "CurveBuy" && emitter === market.curve.toLowerCase()
      && event.args.buyer.toLowerCase() === market.buyer.toLowerCase()
      && event.args.recipient.toLowerCase() === market.buyer.toLowerCase()) total += event.args.tokensOut;
    if (event.eventName === "Swap" && emitter === market.poolManager.toLowerCase()
      && event.args.id.toLowerCase() === market.poolId.toLowerCase()
      && event.args.sender.toLowerCase() === market.buyer.toLowerCase()
      && event.args.amount0 < 0n && event.args.amount1 > 0n) awaitingSwapOutput = true;
    // PoolManager.Swap reports the amount before the Pons after-swap output fee.
    // Count only the subsequent GAGE transfer received by the buying contract.
    if (event.eventName === "Transfer" && awaitingSwapOutput && emitter === market.gage.toLowerCase()
      && event.args.from.toLowerCase() === market.poolManager.toLowerCase()
      && event.args.to.toLowerCase() === market.buyer.toLowerCase()) {
      total += event.args.value;
      awaitingSwapOutput = false;
    }
  }
  return total;
}
