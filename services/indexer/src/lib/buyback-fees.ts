/** Executed fee spending only. Each indexed Split/FloorFunded event is counted once, including multi-clip txs. */
export function buybackFeeAmounts(
  creator: readonly { ethTotal: bigint; ethToOps: bigint; bounty: bigint }[],
  deals: readonly { usdgIn: bigint }[],
) {
  let creatorETH = 0n, dealUSDG = 0n;
  for (const row of creator) {
    const spent = row.ethTotal - row.ethToOps - row.bounty;
    if (row.ethToOps < 0n || row.bounty < 0n || spent < 0n) throw new Error("Invalid creator fee split");
    creatorETH += spent;
  }
  for (const row of deals) {
    if (row.usdgIn < 0n) throw new Error("Invalid deal fee spending");
    dealUSDG += row.usdgIn;
  }
  return { creatorETH, dealUSDG };
}
