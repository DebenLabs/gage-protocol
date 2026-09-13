import path from 'node:path';
import assert from 'node:assert/strict';
import {ACTOR_NAMES, viem, artifact, U, E, writeReport} from './runtime.mjs';

/** A V2 loan is sold in four equal quarters; the local strategy buys every quarter so the loan activates at once. */
export const UNITS = 4;

export async function deployFixture(runtime, {rpc, output, processId, anvilProcessId}) {
  const {pub, address, deploy, write, read, hashOf, transactions} = runtime;
  await runtime.assertLocal();
  assert.equal(await pub.getBlockNumber(), 0n, 'A fresh chain is required.');
  for (const name of ACTOR_NAMES) await pub.request({method: 'anvil_setBalance', params: [address(name), viem.toHex(100n * E)]});
  for (const name of ['alice', 'curator']) await pub.request({method: 'anvil_impersonateAccount', params: [address(name)]});
  const multicall = '0xcA11bde05977b3631167028862bE2a173976CA11';
  await pub.request({method: 'anvil_setCode', params: [multicall, artifact('MockMulticall3').deployedBytecode.object]});
  const term = 604800, grace = 172800;
  const usdg = await deploy('MockERC20', ['Local USDG', 'USDG', 6]);
  const collateral = await deploy('HybridStockRehearsalMock', []);
  const meme = await deploy('MockERC20', ['Local Meme Test Token', 'MEME', 18]);
  const rewardToken = await deploy('MockERC20', ['Local sGAGE', 'sGAGE', 18]);
  // The legacy vault layer still backs the rest of the local app shell; Earn lends through the V2 core below.
  const legacyRegistry = await deploy('CollateralRegistry', [address('curator'), [term, term * 3], 50]);
  const feeSink = await deploy('FeeSink', [usdg, address('curator'), address('curator')]);
  const legacyCore = await deploy('DealVault', [usdg, legacyRegistry, feeSink, viem.zeroAddress, grace]);
  const universalRouter = await deploy('MockUniversalRouter', [usdg, 3000n * U]);
  const entryRouter = await deploy('EntryRouter', [legacyCore, usdg, universalRouter]);
  await write('curator', legacyRegistry, 'CollateralRegistry', 'setRouter', [entryRouter, true]);
  await write('curator', feeSink, 'FeeSink', 'setVault', [legacyCore]);
  // Native V2 core: registry, validator, engine (which deploys its own sGAGE ledger) and a funded reward pool.
  // The V3 pool factory is only consulted for LP collateral; the local ERC-20 fixture pins a code-bearing placeholder.
  const registry = await deploy('GageV2Registry', [address('curator'), [term, term * 3], multicall]);
  await write('curator', registry, 'GageV2Registry', 'setERC20Allowed', [collateral, true, 0, E, 100n * E, 10000n * E]);
  await write('curator', registry, 'GageV2Registry', 'setERC20Allowed', [meme, true, 2, E, 100n * E, 10000n * E]);
  for (const rewardTerm of [term, term * 3]) await write('curator', registry, 'GageV2Registry', 'setRewardTerms', [rewardTerm, 100n * E, 1n, 5000]);
  const validator = await deploy('GageV2CollateralValidator', [registry, usdg, rewardToken, viem.zeroAddress, viem.zeroAddress]);
  const core = await deploy('GageV2Vault', [validator, address('curator'), grace, viem.zeroAddress]);
  const coreRewards = await read(core, 'GageV2Vault', 'REWARDS');
  await write('curator', rewardToken, 'MockERC20', 'mint', [address('curator'), 10_000_000n * E]);
  await write('curator', rewardToken, 'MockERC20', 'approve', [coreRewards, 10_000_000n * E]);
  await write('curator', coreRewards, 'GageV2Rewards', 'fund', [10_000_000n * E]);
  const reserve = await deploy('HybridReserveRehearsalMock', [usdg]);
  for (const name of ACTOR_NAMES) await write('curator', usdg, 'MockERC20', 'mint', [address(name), 100000n * U]);
  for (const name of ['borrowerA', 'borrowerB']) {
    await write('curator', collateral, 'MockERC20', 'mint', [address(name), 1000n * E]);
    await write('curator', meme, 'MockERC20', 'mint', [address(name), 1000n * E]);
    await write(name, collateral, 'MockERC20', 'approve', [core, viem.maxUint256]);
    await write(name, meme, 'MockERC20', 'approve', [core, viem.maxUint256]);
    await write(name, usdg, 'MockERC20', 'approve', [core, viem.maxUint256]);
  }
  const params = {core, reserve, curator: address('curator'), laneWeights: [6000, 4000, 0],
    maxLoanTerm: term, minReturnBps: 300, maxGageExposureBps: 4000,
    minDeposit: 10n * U, maxTotalDeposits: 1000000n * U};
  // The flagship is the first instance of the shared factory; a second curator's instance proves isolation.
  // The legacy FeeSink stands in for the deal fee router: a quarter of every performance fee funds that GAGE floor
  // route in plain USDG, and the curator share stays with each strategy's curator. Creation itself is free.
  const protocolShareBps = 2500;
  const factory = await deploy('HybridFactory', [{core, reserve, feeRouter: feeSink, protocolShareBps, initialOwner: address('curator')}]);
  const mandate = ({core: _core, reserve: _reserve, ...rest}) => rest;
  await write('curator', factory, 'HybridFactory', 'create', [mandate(params)]);
  const hybrid = await read(factory, 'HybridFactory', 'vaults', [0n]);
  const earnStartBlock = Number(transactions.find(tx => tx.label === 'curator:create').blockNumber);
  // records(vault) = {fees, curator, creator, createdAt}: the fee companion is the strategy's only companion (D82).
  const record = await read(factory, 'HybridFactory', 'records', [hybrid]);
  const hybridFees = record[0];
  await write('curator', factory, 'HybridFactory', 'create', [mandate({...params, curator: address('curator2')})]);
  const secondVault = await read(factory, 'HybridFactory', 'vaults', [1n]);
  await write('curator', hybrid, 'HybridVault', 'setTokenCeiling', [collateral, 70n * U]);
  await write('curator', hybrid, 'HybridVault', 'setTokenCeiling', [meme, 70n * U]);
  await write('curator', hybrid, 'HybridVault', 'setFee', [1000]);
  const earnReadyBlock = Number(await pub.getBlockNumber({cacheTime: 0}));
  // Deposits buy shares at the current price and sit as idle cash until the operator parks them in the reserve.
  for (const [name, amount] of [['alice', 2000n * U], ['bob', 1000n * U]]) {
    await write(name, usdg, 'MockERC20', 'approve', [hybrid, amount]);
    const shares = await read(hybrid, 'HybridVault', 'convertToShares', [amount]);
    await write(name, hybrid, 'HybridVault', 'deposit', [amount, shares]);
  }
  const candidates = [];
  const now = (await pub.getBlock()).timestamp;
  const principal = 600n * U;
  for (const candidate of [
    {who: 'borrowerA', token: collateral, lane: 'STOCK', amount: 10n * E, cap: 630n * U, eligible: true, reason: 'Fits the strategy mandate'},
    {who: 'borrowerB', token: meme, lane: 'MEME', amount: 10n * E, cap: 630n * U, eligible: true, reason: 'Fits the strategy mandate'},
    {who: 'borrowerA', token: collateral, lane: 'STOCK', amount: 8n * E, cap: 630n * U, eligible: false, reason: 'Entry price exceeds the strategy limit'},
    {who: 'borrowerB', token: meme, lane: 'MEME', amount: 10n * E, cap: 610n * U, eligible: false, reason: 'Contractual return is below the strategy minimum'},
  ]) {
    const fundingDeadline = Number(now + 6n * 86400n);
    await write(candidate.who, core, 'GageV2Vault', 'list', [{kind: 0, token: candidate.token, amountOrTokenId: candidate.amount}, principal, candidate.cap, term, fundingDeadline, true]);
    const id = await read(core, 'GageV2Vault', 'loanCount');
    const validUntil = (await pub.getBlock()).timestamp + 3500n;
    if (candidate.eligible) await write('curator', hybrid, 'HybridVault', 'approveLoan', [id, Number(validUntil), UNITS]);
    candidates.push({id: String(id), borrower: address(candidate.who), actor: candidate.who, token: candidate.token, lane: candidate.lane,
      principal: String(principal), units: UNITS, unitPrice: String(principal / BigInt(UNITS)), positionPrincipal: String(principal),
      repayment: String(candidate.cap), collateralAmount: String(candidate.amount), fundingDeadline: String(fundingDeadline),
      eligible: candidate.eligible, reason: candidate.reason, validUntil: candidate.eligible ? String(validUntil) : null});
  }
  const addresses = {HybridFactory: factory, HybridVault: hybrid, HybridFees: hybridFees, HybridReserve: reserve, SecondVault: secondVault, FeeRouter: feeSink,
    EarnCore: core, EarnCoreRegistry: registry, EarnCoreRewards: coreRewards, EarnCoreValidator: validator,
    DealVault: legacyCore, USDG: usdg, CollateralToken: collateral, MemeToken: meme, Reserve: reserve,
    CollateralRegistry: legacyRegistry, FeeSink: feeSink, EntryRouter: entryRouter, MockUniversalRouter: universalRouter,
    RewardToken: rewardToken, Multicall3: multicall};
  const runtimeCodeHashes = Object.fromEntries(await Promise.all(Object.entries(addresses).map(async ([name, target]) => [name, await hashOf(target)])));
  const state = {schemaVersion: 1, localOnly: true, chainId: 31337, rpc, processId, anvilProcessId, grace, protocolShareBps,
    accounts: Object.fromEntries(ACTOR_NAMES.map(name => [name, {address: address(name)}])),
    addresses, runtimeCodeHashes, earnStartBlock, earnReadyBlock, params, candidates, transactions: transactions.splice(0)};
  writeReport(path.join(output, 'manifest.json'), state);
  const catalog = [{id: 'local-hybrid-nvda', chainId: 31337, address: hybrid, startBlock: earnStartBlock, grace, title: 'Earn',
    allocatorLabel: 'Gage', allocatorLogo: '/gage-icon.png', reserveLabel: 'Local USDG reserve', localFixture: true,
    expected: {core, coreRewards, registry, usdg, collateral, reserve, fees: hybridFees, allocator: address('curator')}}];
  writeReport(path.join(output, 'catalog.json'), catalog);
  const readyBlock = Number(await pub.getBlockNumber({cacheTime: 0}));
  const deployment = {chainId: 31337, localFork: true, ...addresses,
    NVDAx: collateral, sGAGE: rewardToken, startBlock: 1, earnStartBlock, earnReadyBlock, readyBlock,
    earnMandate: {...params, laneWeights: {STOCK: 6000, MEME: 4000, LP: 0}, feeBps: 1000, protocolShareBps, feeRecipient: address('curator'),
      admittedTokens: [{token: collateral, ceiling: String(70n * U)}, {token: meme, ceiling: String(70n * U)}]},
    rehearsal: {phase: 'hybrid-local-fixture', owner: address('curator')}};
  // The app shell reads the deployment without a V2 block (its V2 pages need the full router set); services need the engine.
  writeReport(path.join(output, 'web-deployment.json'), deployment);
  writeReport(path.join(output, 'services-deployment.json'), {...deployment, nativeV2: {adapter: multicall,
    engines: [{engine: core, registry, rewards: coreRewards, cashoutRouter: core, entryRouter: core, zapRouter: core,
      startBlock: earnStartBlock, grace, name: 'Local V2'}]}});
  return state;
}
