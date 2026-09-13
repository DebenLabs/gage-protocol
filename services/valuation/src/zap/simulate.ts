import { BaseError, ContractFunctionRevertedError, parseAbi, type Address, type PublicClient } from "viem";
import type { Pool } from "../deployment.js";
import { ApiError } from "../errors.js";

const key = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const abi = parseAbi([
  `function quote((address inputCurrency,uint128 amountIn,${key} pool,address baseToken,int24 tickLower,int24 tickUpper,uint16 slippageBps,${key}[] route) p) returns (((${key} key,bool zeroForOne,uint128 amountIn,uint128 minOut)[] swaps,(uint128 sell,uint128 output,uint160 sqrtPriceAfterX96,uint128 liquidity,uint256 amount0,uint256 amount1) split,uint128 baseAmount) result)`,
]);

export interface SimulateZapParams {
  inputCurrency: Address; amountIn: bigint; pool: Pool; baseToken: Address;
  tickLower: number; tickUpper: number; slippageBps: number; route: Pool[];
}
export interface SimulatedZap {
  swaps: { key: Pick<Pool, "currency0" | "currency1" | "fee" | "tickSpacing" | "hooks">; zeroForOne: boolean; amountIn: bigint; minOut: bigint }[];
  split: { sell: bigint; output: bigint; sqrtPriceAfterX96: bigint; liquidity: bigint; amount0: bigint; amount1: bigint };
  baseAmount: bigint; block: bigint; at: number;
}
export type ZapSimulator = (quoter: Address, params: SimulateZapParams, blockNumber?: bigint) => Promise<SimulatedZap>;

export function zapSimulator(client: PublicClient): ZapSimulator {
  return async (quoter, params, requiredBlock) => {
    try {
      const block = requiredBlock === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: requiredBlock });
      const { result } = await client.simulateContract({ address: quoter, abi, functionName: "quote", args: [params], blockNumber: block.number, gas: 20_000_000n });
      return { swaps: [...result.swaps], split: result.split, baseAmount: result.baseAmount, block: block.number, at: Number(block.timestamp) };
    } catch (error) {
      if (error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) {
        throw new ApiError("NO_LIQUIDITY", "This route cannot execute for that amount. Reduce the amount or refresh the quote.");
      }
      throw new ApiError("RPC_ERROR", "Could not simulate the live route. Please refresh the quote.");
    }
  };
}
