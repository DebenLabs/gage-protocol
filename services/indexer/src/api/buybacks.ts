import { db, publicClients } from "ponder:api";
import { creatorFeeSplits, dealFeeFloorDeposits } from "ponder:schema";
import { parseAbi, type Hex } from "viem";
import { sql } from "ponder";
import { CHAIN_NAME, poolByName } from "../lib/deployment";
import { creatorGageBought } from "../lib/buybacks";
import { buybackFeeAmounts } from "../lib/buyback-fees";
import { deployment } from "./views";

export type BuybackFeesJson = {
  totalUSDG: string; creatorETH: string; dealUSDG: string; usdgDecimals: number;
  launchAt: number; asOf: number; blockNumber: string; chainId: number;
};
export type BuybacksJson = { gageThisWeek: string; gageAllTime: string; fees: BuybackFeesJson | null };
const receiptCache = new Map<string, { expires: number; value: Promise<bigint> }>();
const curveAbi = parseAbi(["function PONS_CURVE() view returns(address)"]);
const priceAbi = parseAbi(["function ethValueUSDG(uint256) view returns(uint256)"]);
const decimalsAbi = parseAbi(["function decimals() view returns(uint8)"]);

/** Read checkpoint before fee rows; a completed indexed second bounds every row in the exported amount. */
async function feeSnapshot() {
  if (!deployment.tokenLaunchBlock || !deployment.token.DealFeeRouter || !deployment.token.CreatorFeeSplitter) return null;
  try {
    const result = await db.execute(sql`select chain_id, latest_checkpoint from _ponder_checkpoint`);
    const rows = (Array.isArray(result) ? result : result.rows) as { chain_id: string | number; latest_checkpoint: string }[];
    const checkpoint = rows.find(r => Number(r.chain_id) === deployment.chainId)?.latest_checkpoint;
    if (!checkpoint || !/^\d{42,}$/.test(checkpoint)) return null;
    const blockNumber = BigInt(checkpoint.slice(26, 42));
    if (blockNumber < BigInt(deployment.tokenLaunchBlock)) return null;
    const client = publicClients[CHAIN_NAME];
    const [block, launch, ethPrice, decimals] = await Promise.all([
      client.getBlock({ blockNumber }),
      client.getBlock({ blockNumber: BigInt(deployment.tokenLaunchBlock) }),
      client.readContract({ address: deployment.token.CreatorFeeSplitter, abi: priceAbi, functionName: "ethValueUSDG", args: [10n ** 18n], blockNumber }),
      client.readContract({ address: deployment.m1.USDG, abi: decimalsAbi, functionName: "decimals", blockNumber }),
    ]);
    if (ethPrice <= 0n || decimals > 18 || block.timestamp < launch.timestamp) return null;
    return { asOf: Number(block.timestamp), launchAt: Number(launch.timestamp), blockNumber: blockNumber.toString(), ethPrice, decimals };
  } catch { return null; }
}

/** Read receipts for already-indexed successful Split transactions. This adds no historical NFT scan
 * or indexing schema change. Failures return unavailable, never a partial/zero purchase total.
 */
export async function buybackTotals(since: bigint): Promise<BuybacksJson | null> {
  const gage = deployment.token.GAGE;
  const buyer = deployment.token.CreatorFeeSplitter;
  const poolManager = deployment.token.PoolManager;
  const pool = poolByName(deployment, "gageEth");
  if (!gage || !buyer || !poolManager || !pool) return null;
  try {
    const snapshot = await feeSnapshot();
    const [creator, deals] = await Promise.all([
      db.select().from(creatorFeeSplits), db.select().from(dealFeeFloorDeposits),
    ]);
    const client = publicClients[CHAIN_NAME];
    const curve = creator.length ? await client.readContract({ address: buyer, abi: curveAbi, functionName: "PONS_CURVE" }) : buyer;
    let allTime = 0n, thisWeek = 0n;
    // A caller can process multiple clips in one transaction; its receipt is counted only once.
    const transactions = [...new Map(creator.map(row => [row.tx, row])).values()];
    for (let i = 0; i < transactions.length; i += 4) {
      const totals = await Promise.all(transactions.slice(i, i + 4).map(async row => {
        const key = `${row.tx}:${row.at}`;
        let cached = receiptCache.get(key);
        if (!cached || cached.expires < Date.now()) {
          const value = client.getTransactionReceipt({ hash: row.tx as Hex }).then(receipt => {
            if (receipt.status !== "success") throw new Error("Purchase receipt unavailable");
            const bought = creatorGageBought(receipt.logs, { buyer, gage, curve, poolManager, poolId: pool.poolId });
            if (bought <= 0n) throw new Error("Purchase event missing");
            return bought;
          }).catch(error => { receiptCache.delete(key); throw error; });
          cached = { expires: Date.now() + 300_000, value };
          receiptCache.set(key, cached);
          if (receiptCache.size > 4096) receiptCache.delete(receiptCache.keys().next().value!);
        }
        return { at: row.at, bought: await cached.value };
      }));
      for (const row of totals) { allTime += row.bought; if (row.at >= since) thisWeek += row.bought; }
    }
    for (const row of deals) { allTime += row.gageBought; if (row.at >= since) thisWeek += row.gageBought; }
    let fees: BuybackFeesJson | null = null;
    if (snapshot) {
      const amounts = buybackFeeAmounts(
        creator.filter(row => row.at < BigInt(snapshot.asOf)),
        deals.filter(row => row.at < BigInt(snapshot.asOf)),
      );
      fees = {
        totalUSDG: (amounts.creatorETH * snapshot.ethPrice / 10n ** 18n + amounts.dealUSDG).toString(),
        creatorETH: amounts.creatorETH.toString(), dealUSDG: amounts.dealUSDG.toString(),
        usdgDecimals: snapshot.decimals, launchAt: snapshot.launchAt, asOf: snapshot.asOf,
        blockNumber: snapshot.blockNumber, chainId: deployment.chainId,
      };
    }
    return { gageThisWeek: thisWeek.toString(), gageAllTime: allTime.toString(), fees };
  } catch { return null; }
}
