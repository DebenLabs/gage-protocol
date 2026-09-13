// Native V2 calls shared by the local indexer, keeper and notifier lifecycle rehearsals.
export function earnRehearsalCore(runtime, addresses) {
  const {read, write, address} = runtime;
  const core = addresses.EarnCore;
  const loan = id => read(core, 'GageV2Vault', 'getLoan', [BigInt(id)]);
  const expiry = async id => {
    const value = await loan(id);
    if (value.fundedAt === 0n || value.fundedAt === 0) throw Error('The native V2 loan has not activated');
    return BigInt(value.fundedAt) + BigInt(value.term);
  };
  return {
    loan, expiry,
    claimableAt: async id => await expiry(id) + BigInt(await read(core, 'GageV2Vault', 'GRACE')),
    async list(who, collateral, principal, cap, term, deadline) {
      await write(who, core, 'GageV2Vault', 'list', [collateral, principal, cap, term, Number(deadline), true]);
      return read(core, 'GageV2Vault', 'loanCount');
    },
    repay: (who, id) => write(who, core, 'GageV2Vault', 'reclaim', [BigInt(id), address(who)]),
    fund(who, id, units) {
      if (!Number.isInteger(units) || units < 1 || units > 4) throw Error('Choose one to four V2 loan quarters');
      return write(who, core, 'GageV2Vault', 'fund', [BigInt(id), units]);
    },
    cashCredit: () => read(core, 'GageV2Vault', 'cashCredit', [addresses.HybridVault]),
  };
}
