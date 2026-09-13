#!/usr/bin/env node
import path from 'node:path';
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {startLocal} from './local-chain.mjs';
import {runOperator} from './operator.mjs';
import {UNITS} from './fixture.mjs';
import {EARN_MANDATE_VERSION} from '../lib/earn-mandate.mjs';
import {root, localRpc, U, E, viem, artifact, writeReport} from './runtime.mjs';

const {values} = parseArgs({options: {output: {type: 'string'}, help: {type: 'boolean'}}});
if (values.help) {
  console.log('Usage: node scripts/hybrid/rehearse.mjs [--output DIR]\nStarts and stops its own fresh Anvil on18569; never uses the persistent18559 or existing18558 chains.');
  process.exit(0);
}
const output = path.resolve(values.output ?? path.join(root, '.rehearsal/hybrid-verification'));
const rpc = localRpc(process.env.HYBRID_REHEARSAL_RPC_URL ?? 'http://127.0.0.1:18569');
const {child, runtime, state} = await startLocal({rpc, output});
const checks = [];
const check = (condition, label) => {assert(condition, label); checks.push(label);};
const {pub, read, write, address, warp} = runtime, a = state.addresses;
/** Shares per USDG unit at the initial price (VIRTUAL_SHARES); one whole USDG is 1e18 shares at that price. */
const ONE = 10n ** 12n;
const term = 604800;
const approx = (left, right, tolerance = 2n) => (left > right ? left - right : right - left) <= tolerance;
const vault = (functionName, args = []) => read(a.HybridVault, 'HybridVault', functionName, args);
const account = who => runtime.accountState(a.HybridVault, address(who));
const usdgOf = who => read(a.USDG, 'MockERC20', 'balanceOf', [typeof who === 'string' && who.startsWith('0x') ? who : address(who)]);
const reserveValue = async () => read(a.Reserve, 'HybridReserveMock', 'previewRedeem', [await vault('reserveShares')]);
const coreLoan = id => read(a.EarnCore, 'GageV2Vault', 'getLoan', [id]);
let operatorRun = 0;
async function operate(options = {}) {
  return runOperator({output, execute: true, reportFile: path.join(output, `operator-${++operatorRun}.json`), ...options});
}
const confirmed = (report, name) => report.actions.some(action => action.name === name && action.status === 'confirmed');
const waiting = (report, name) => report.actions.find(action => action.name === name && action.status === 'waiting');
async function reverted(who, functionName, args, target = a.HybridVault, artifactName = 'HybridVault') {
  // Broadcast an actual failing transaction, so rollback is verified against a mined receipt.
  const hash = await runtime.actors[who].wallet.writeContract({chain: null, address: target,
    abi: artifact(artifactName).abi, functionName, args, gas: 12_000_000n});
  const receipt = await pub.waitForTransactionReceipt({hash});
  check(receipt.status === 'reverted', `${functionName} is rejected on chain`);
  runtime.transactions.push({label: `expected-revert:${functionName}`, hash, blockNumber: String(receipt.blockNumber)});
}
/** The custom error a call would revert with, from simulation; the chain is not changed. */
async function revertReason(who, functionName, args) {
  try {
    await pub.simulateContract({address: a.HybridVault, abi: artifact('HybridVault').abi, functionName, args, account: runtime.actors[who].account});
    return null;
  } catch (error) {return error?.cause?.data?.errorName ?? error?.data?.errorName ?? error?.name;}
}
async function listLoan(who, token, cap, deadlineOffset = 6n * 86400n, principal = 600n * U) {
  const now = (await pub.getBlock()).timestamp;
  await write(who, a.EarnCore, 'GageV2Vault', 'list', [{kind: 0, token, amountOrTokenId: 10n * E}, principal, cap, term, Number(now + deadlineOffset), true]);
  return read(a.EarnCore, 'GageV2Vault', 'loanCount');
}
async function approve(id, units = UNITS) {
  await write('curator', a.HybridVault, 'HybridVault', 'approveLoan', [id, Number((await pub.getBlock()).timestamp + 3500n), units]);
}
async function deposit(who, amount) {
  await write(who, a.USDG, 'MockERC20', 'approve', [a.HybridVault, amount]);
  const before = (await account(who)).shares;
  await write(who, a.HybridVault, 'HybridVault', 'deposit', [amount, 1n]);
  return (await account(who)).shares - before;
}
try {
  // ---------------------------------------------------------------- the factory and the wiring
  check(await read(a.CollateralToken, 'HybridStockRehearsalMock', 'uiMultiplier') === E,
    'Local stock metadata reports the ERC-8056 fixed-point multiplier');
  const reserveDecimals = await read(a.Reserve, 'HybridReserveMock', 'decimals');
  const virtualShares = await read(a.Reserve, 'HybridReserveRehearsalMock', 'virtualShares');
  const accrual = await read(a.Reserve, 'HybridReserveRehearsalMock', 'accrueInterestView');
  check(virtualShares === 10n ** BigInt(reserveDecimals - 6), 'Local reserve reports its actual virtual-share offset');
  check(accrual[0] === await read(a.Reserve, 'HybridReserveMock', 'totalAssets')
    && accrual[1] === 0n && accrual[2] === 0n, 'Local reserve exposes fee-free accrued assets to the real indexer');
  check((await read(a.HybridFactory, 'HybridFactory', 'vaults', [0n])).toLowerCase() === a.HybridVault.toLowerCase() && await read(a.HybridFactory, 'HybridFactory', 'isVault', [a.HybridVault]), 'Flagship is the first instance of the shared factory');
  check(await read(a.HybridFactory, 'HybridFactory', 'VAULT_INIT_HASH') === viem.keccak256(artifact('HybridVault').bytecode.object), 'Factory pins the exact strategy creation code');
  const record = await read(a.HybridFactory, 'HybridFactory', 'records', [a.HybridVault]);
  check(record[0].toLowerCase() === a.HybridFees.toLowerCase() && record[1].toLowerCase() === address('curator').toLowerCase() && record[2].toLowerCase() === address('curator').toLowerCase() && record[3] > 0n,
    'Factory records the fee companion, curator, creator and creation time of the flagship');
  check(await read(a.HybridFactory, 'HybridFactory', 'count') === 2n && (await read(a.SecondVault, 'HybridVault', 'CURATOR')).toLowerCase() === address('curator2').toLowerCase(), 'A second curator instance shares the implementation with its own curator');
  check(await usdgOf(a.FeeRouter) === 0n && await usdgOf('curator') === 100000n * U, 'Creating strategies costs nothing beyond gas');
  check(!(await read(a.HybridFactory, 'HybridFactory', 'publicCreation')), 'Public creation stays closed until the owner opens it');
  await reverted('curator2', 'setPaused', [true]);
  check(!(await vault('paused')), 'Another curator cannot pause the flagship');
  check((await vault('VAULT')).toLowerCase() === a.EarnCore.toLowerCase(), 'Strategy lends through the local V2 core');
  check((await vault('CORE_REWARDS')).toLowerCase() === a.EarnCoreRewards.toLowerCase()
    && (await read(a.EarnCore, 'GageV2Vault', 'REWARDS')).toLowerCase() === a.EarnCoreRewards.toLowerCase(), 'Strategy pins the core’s own sGAGE ledger');
  check(Number(await vault('GRACE')) === state.grace && Number(await read(a.EarnCore, 'GageV2Vault', 'GRACE')) === state.grace, 'Strategy grace equals the core grace');
  check(Number(await vault('MANDATE_VERSION')) === EARN_MANDATE_VERSION, 'Strategy reports the STOCK/MEME/LP mandate version');
  const params = await vault('params');
  check(!('maxPerLoan' in params) && !('maxPerBorrower' in params), 'The mandate has no loan or borrower limits');
  check(await vault('laneWeightBps', [0]) === 6000, 'Stock lane cap is 6000 basis points');
  check(await vault('laneWeightBps', [1]) === 4000, 'Meme lane cap is 4000 basis points');
  check(await vault('laneWeightBps', [2]) === 0, 'LP category cap is zero for the ERC-20 fixture');
  check(await vault('feeBps') === 1000, 'Performance fee is one tenth of realized loan profit above the vault’s high-water mark');
  check((await vault('fees')).toLowerCase() === a.HybridFees.toLowerCase()
    && (await read(a.HybridFees, 'HybridFees', 'STRATEGY')).toLowerCase() === a.HybridVault.toLowerCase(), 'Strategy and its fee companion are wired to each other');
  check(await read(a.HybridFees, 'HybridFees', 'PROTOCOL_SHARE_BPS') === state.protocolShareBps
    && (await read(a.HybridFees, 'HybridFees', 'PROTOCOL_RECIPIENT')).toLowerCase() === a.FeeRouter.toLowerCase(), 'A quarter of every fee is routed to the GAGE floor route');
  check((await read(a.HybridFees, 'HybridFees', 'curatorRecipient')).toLowerCase() === address('curator').toLowerCase(), 'Curator share is paid to the curator');

  // ---------------------------------------------------------------- shares, cash and the reserve
  const initialAlice = await account('alice'), initialBob = await account('bob');
  check(initialAlice.shares === 2000n * U * ONE && initialBob.shares === 1000n * U * ONE && await vault('totalSupply') === 3000n * U * ONE,
    'Shares are minted at the initial price of one USDG per 10^12 shares');
  check(await vault('cash') === 3000n * U && await vault('totalAssets') === 3000n * U && await vault('reserveShares') === 0n,
    'Deposits are idle cash until parked');
  check(approx(initialAlice.assets, 2000n * U) && approx(initialBob.assets, 1000n * U), 'Each holder’s shares are worth exactly their deposit at the initial price');
  check(initialAlice.lockedShares === 0n && initialAlice.claimable === 0n && initialAlice.rewards === 0n, 'A fresh holder has nothing locked, claimable or owed');
  await write('alice', a.HybridVault, 'HybridVault', 'investReserve', [2600n * U, await read(a.Reserve, 'HybridReserveMock', 'previewDeposit', [2600n * U])]);
  check(await vault('cash') === 400n * U && approx(await reserveValue(), 2600n * U) && approx(await vault('totalAssets'), 3000n * U), 'Anyone may park idle cash in the reserve without moving the share price');
  const originalValue = (await account('alice')).assets;
  await write('curator', a.USDG, 'MockERC20', 'approve', [a.Reserve, 30n * U]);
  await write('curator', a.Reserve, 'HybridReserveMock', 'donate', [30n * U]);
  const gainedValue = (await account('alice')).assets;
  check(gainedValue > originalValue, 'Actual reserve gains increase existing holder value through the share price');
  await write('curator', a.Reserve, 'HybridReserveMock', 'simulateLoss', [15n * U, address('curator')]);
  const afterLossValue = (await account('alice')).assets;
  check(afterLossValue < gainedValue && afterLossValue > originalValue, 'Actual reserve loss decreases existing holder value through the share price');
  check((await account('alice')).shares === initialAlice.shares && await vault('reserveShares') === await read(a.Reserve, 'HybridReserveMock', 'balanceOf', [a.HybridVault]), 'Gains and losses fabricate neither strategy shares nor reserve shares');
  const lateShares = await deposit('alice', 100n * U);
  check(lateShares > 0n && lateShares < 100n * U * ONE && approx(await vault('cash'), 500n * U), 'A later depositor buys at the higher current price');
  const aliceAfterTopUp = (await account('alice')).assets;
  check(approx(aliceAfterTopUp, afterLossValue + 100n * U), 'The top-up adds exactly its USDG to the holder’s value');
  check(await read(a.Reserve, 'HybridReserveMock', 'reportZeroMax') && await read(a.Reserve, 'HybridReserveMock', 'maxDeposit', [a.HybridVault]) === 0n, 'Reserve conservatively reports zero max views throughout');

  // ---------------------------------------------------------------- funding: cash first, then the reserve, or nothing
  const cashBeforeFailure = await vault('cash'), reserveBeforeFailure = await vault('reserveShares');
  await write('curator', a.Reserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, 0n, 0n]);
  await reverted('keeper', 'fund', [1n, viem.maxUint256]);
  check((await coreLoan(1n)).state === 1 && (await coreLoan(1n)).filled === 0, 'Illiquid reserve leaves the V2 listing unfunded');
  check(!(await vault('funded', [1n])) && await vault('performingPrincipal') === 0n && await vault('cash') === cashBeforeFailure && await vault('reserveShares') === reserveBeforeFailure,
    'Illiquid funding records nothing and moves nothing');
  await write('curator', a.Reserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, viem.maxUint256, viem.maxUint256]);
  await write('curator', a.USDG, 'MockERC20', 'setBlocked', [a.EarnCore, true]);
  await reverted('keeper', 'fund', [1n, viem.maxUint256]);
  check(await vault('cash') === cashBeforeFailure && await vault('reserveShares') === reserveBeforeFailure && await read(a.Reserve, 'HybridReserveMock', 'balanceOf', [a.HybridVault]) === reserveBeforeFailure,
    'Core funding failure rolls back the reserve redemption and the cash debit');
  check(await vault('performingPrincipal') === 0n && (await account('alice')).assets === aliceAfterTopUp, 'Core failure cannot create phantom loan principal or move holder value');
  await write('curator', a.USDG, 'MockERC20', 'setBlocked', [a.EarnCore, false]);
  const dryBlock = await pub.getBlockNumber({cacheTime: 0});
  const dryReport = await runOperator({output, execute: false, reportFile: path.join(output, 'operator-dry-run.json'), loanId: '1', invest: false});
  check(dryReport.actions.some(action => action.name === 'fund' && action.status === 'ready'), 'Dry-run identifies executable funding');
  check(await pub.getBlockNumber({cacheTime: 0}) === dryBlock && (await coreLoan(1n)).state === 1, 'Dry-run never signs or changes the chain');
  const assetsBeforeFunding = await vault('totalAssets'), reserveBeforeFunding = await reserveValue();
  const fundedReport = await operate({loanId: '1', invest: false});
  check(confirmed(fundedReport, 'fund'), 'Operator buys every approved quarter in one transaction');
  const firstLoan = await coreLoan(1n);
  check(firstLoan.state === 2 && firstLoan.filled === UNITS, 'Buying all four quarters activates the V2 loan');
  check((await read(a.EarnCore, 'GageV2Vault', 'lenders', [1n])).every(lender => lender.toLowerCase() === a.HybridVault.toLowerCase()), 'V2 core records the strategy as the one lender in every slot');
  check(Number(await vault('loanSlots', [1n])) === 0b1111 && await vault('positionPrincipal', [1n]) === 600n * U && await vault('performingPrincipal') === 600n * U, 'Strategy records its slot mask and carries the loan at principal');
  check(await vault('cash') === 0n && approx(await reserveValue(), reserveBeforeFunding - 100n * U), 'Funding pays from cash first and redeems the reserve only for the shortfall');
  check(approx(await vault('totalAssets'), assetsBeforeFunding), 'Funding leaves the share value unchanged: a loan is worth what was paid for it');
  const rewardSupplyBeforeBobTopUp = await vault('totalSupply');
  const bobTopUp = await deposit('bob', 200n * U);
  const rewardSupplyAfterBobTopUp = await vault('totalSupply');
  check(bobTopUp > 0n && bobTopUp < 200n * U * ONE, 'A deposit after funding joins the pool at the current price');

  // ---------------------------------------------------------------- repayment: premium locked, then unlocked; fee; rewards
  // Core rewards accrue with time active, so let half the term pass before the borrower repays.
  await warp((await pub.getBlock()).timestamp + BigInt(term) / 2n);
  await write('borrowerA', a.EarnCore, 'GageV2Vault', 'reclaim', [1n, address('borrowerA')]);
  check((await coreLoan(1n)).state === 3 && await read(a.EarnCore, 'GageV2Vault', 'cashCredit', [a.HybridVault]) === 630n * U, 'Repayment is credited to the strategy on the core, pull-only');
  const fullBeforeRepayment = await vault('fullAssets');
  const settledReport = await operate({fund: false});
  check(confirmed(settledReport, 'settle') && await vault('terminal', [1n]) && await vault('performingPrincipal') === 0n, 'Repayment is settled and the loan leaves the book');
  check(await vault('feeAccrued') === 3n * U, 'A 30 USDG realized profit above the vault mark accrues a 3 USDG performance fee');
  const locked = await vault('lockedProfitNow');
  check(locked > 27n * U * 99n / 100n && locked <= 27n * U && approx(await vault('fullAssets'), fullBeforeRepayment + 27n * U)
    && approx(await vault('totalAssets'), await vault('fullAssets') - locked), 'Net premium is included in deposit assets and excluded from the unlocked redemption base');
  check(confirmed(settledReport, 'investReserve') && await vault('cash') === 0n, 'Reserve investment executes despite conservative zero max views');
  const releasedRewards = await read(a.RewardToken, 'MockERC20', 'balanceOf', [a.HybridVault]);
  check(releasedRewards > 0n, 'The settlement checkpoint harvests closed-loan sGAGE from the core ledger into the strategy');
  const aliceRewards = (await account('alice')).rewards, bobRewards = (await account('bob')).rewards;
  const holderRewards = aliceRewards + bobRewards;
  // This path distributes once before Bob's balance change and once at settlement. Each accumulator
  // division can strand less than ceil(supply / precision), and the three holder calculations round once.
  const rewardDustBound = (rewardSupplyBeforeBobTopUp + E - 1n) / E
    + (rewardSupplyAfterBobTopUp + E - 1n) / E + 3n;
  check(aliceRewards > 0n && bobRewards > 0n && holderRewards <= releasedRewards
    && releasedRewards - holderRewards <= rewardDustBound,
    'Released rewards reconcile to holder accrual and division-bounded dust across the balance-change checkpoint');
  await deposit('curator2', 100n * U);
  check((await account('curator2')).rewards === 0n, 'A later depositor acquires none of the rewards already harvested');
  const rewardsBefore = await read(a.RewardToken, 'MockERC20', 'balanceOf', [address('alice')]);
  await write('alice', a.HybridVault, 'HybridVault', 'claimRewards');
  check(await read(a.RewardToken, 'MockERC20', 'balanceOf', [address('alice')]) === rewardsBefore + aliceRewards && (await account('alice')).rewards === 0n, 'Alice withdraws exactly her accrued sGAGE');
  await reverted('alice', 'claimRewards', []);
  check((await account('bob')).rewards === bobRewards, 'One holder’s claim leaves the other’s accrual untouched');
  const fees = await vault('feeAccrued');
  const protocolShare = fees * BigInt(state.protocolShareBps) / 10000n, curatorShare = fees - protocolShare;
  const curatorBefore = await usdgOf('curator'), routerBefore = await usdgOf(a.FeeRouter);
  await write('bob', a.HybridVault, 'HybridVault', 'claimFees');
  check(await vault('feeAccrued') === 0n && await usdgOf(a.HybridFees) === fees, 'Anyone can move accrued fees to the companion, independently of holder funds');
  check(await read(a.HybridFees, 'HybridFees', 'curatorAccrued') === curatorShare && await read(a.HybridFees, 'HybridFees', 'protocolAccrued') === protocolShare,
    'Collected fees split three quarters to the curator and one quarter to the protocol');
  await write('bob', a.HybridFees, 'HybridFees', 'claimCurator');
  await write('bob', a.HybridFees, 'HybridFees', 'claimProtocol');
  check(await usdgOf('curator') === curatorBefore + curatorShare, 'Curator receives exactly its share');
  check(await usdgOf(a.FeeRouter) === routerBefore + protocolShare, 'GAGE floor route receives exactly the protocol share');
  await reverted('bob', 'claimFees', []);
  check(await read(a.HybridFees, 'HybridFees', 'curatorAccrued') === 0n && await read(a.HybridFees, 'HybridFees', 'protocolAccrued') === 0n, 'Claimed fees cannot be claimed twice');
  const unlockStart = await vault('unlockStart'), unlockWindow = await vault('PROFIT_UNLOCK');
  await warp(unlockStart + BigInt(unlockWindow) / 4n);
  check(await vault('lockedProfitNow') === 27n * U * 3n / 4n, 'Locked premium unlocks linearly over the window');

  // ---------------------------------------------------------------- the second loan, a synchronous exit and a queued request
  // The fixture's one-hour approval lapsed during the warp; the curator renews it before the keeper may fund.
  await approve(2n);
  const secondReport = await operate({loanId: '2'});
  check(confirmed(secondReport, 'fund') && (await coreLoan(2n)).state === 2, 'Second approved V2 loan funds independently from the reserve');
  const bobValue = (await account('bob')).assets, bobWallet = await usdgOf('bob');
  await write('bob', a.HybridVault, 'HybridVault', 'redeem', [(await account('bob')).shares, bobValue]);
  check((await account('bob')).shares === 0n && await usdgOf('bob') === bobWallet + bobValue, 'Free liquidity pays a redemption at once, cash first and then the reserve');
  const aliceBefore = await account('alice'), lockedAtRequest = await vault('lockedProfitNow');
  check(aliceBefore.assets > await vault('cash') + await reserveValue(), 'Alice’s stake now exceeds free liquidity');
  await reverted('alice', 'redeem', [aliceBefore.shares, 0n]);
  await write('alice', a.HybridVault, 'HybridVault', 'requestRedeem', [aliceBefore.shares]);
  check((await account('alice')).lockedShares === aliceBefore.shares && await vault('pendingShares') === aliceBefore.shares && await vault('requestCount') === 1n,
    'A request beyond free liquidity queues the shares, which stay owned and priced');
  check(await revertReason('alice', 'redeem', [1n, 0n]) === 'InvalidAmount' && await vault('maxRedeem', [address('alice')]) === 0n, 'Queued shares cannot also be redeemed at once');
  await write('curator', a.Reserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, 0n, 0n]);
  const blockedReport = await operate({fund: false});
  check(waiting(blockedReport, 'serveRequests') && (await account('alice')).claimable === 0n && await vault('pendingShares') === aliceBefore.shares, 'Illiquid reserve leaves the request waiting, with nothing credited');
  await write('curator', a.Reserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, viem.maxUint256, viem.maxUint256]);
  const servedReport = await operate({fund: false});
  const served = await account('alice');
  const request = await vault('requests', [1n]);
  check(confirmed(servedReport, 'serveRequests') && served.claimable > 0n && request[1] > 0n && served.shares === request[1] && await vault('requestHead') === 1n,
    'The request is served as far as cash and the reserve reach; the rest stays at the head of the queue');
  // Premium keeps unlocking between the two reads; the served value may only grow by that drift.
  const unlockDrift = lockedAtRequest - await vault('lockedProfitNow');
  check(await vault('cash') === 0n && (await reserveValue()) <= 2n && served.assets + served.claimable + 4n >= aliceBefore.assets
    && served.assets + served.claimable <= aliceBefore.assets + unlockDrift + 4n, 'Service drains free liquidity at today’s price without touching the loan');
  const aliceWallet = await usdgOf('alice');
  await write('alice', a.HybridVault, 'HybridVault', 'claim');
  check(await usdgOf('alice') === aliceWallet + served.claimable && (await account('alice')).claimable === 0n, 'Served USDG is pulled by the requester alone');
  await write('borrowerB', a.EarnCore, 'GageV2Vault', 'reclaim', [2n, address('borrowerB')]);
  // Settlement is permissionless; settling directly isolates the funding guard from the operator's own ordering.
  await write('keeper', a.HybridVault, 'HybridVault', 'settle', [[2n]]);
  const secondFee = await vault('feeAccrued');
  check(await vault('terminal', [2n]) && secondFee > 0n && secondFee <= 3n * U && await vault('cash') === 630n * U - secondFee, 'Second repayment settles as cash with its fee above the mark');
  // The pool is small after two exits; a 200 USDG listing fits the 40% exposure cap but not the queue's claim on cash.
  const fifthId = await listLoan('borrowerA', a.CollateralToken, 210n * U, 6n * 86400n, 200n * U);
  check(!state.candidates.some(candidate => candidate.id === String(fifthId)), 'New loan is absent from the original fixture candidate list');
  await approve(fifthId);
  check(await vault('cash') >= 200n * U && await revertReason('keeper', 'fund', [fifthId, viem.maxUint256]) === 'RequestsPending', 'A repayment cannot fund a new loan while a request is still owed');
  const queueReport = await operate({loanId: String(fifthId)});
  const fundAttempt = waiting(queueReport, 'fund');
  check(confirmed(queueReport, 'serveRequests') && await vault('pendingShares') === 0n && await vault('requestHead') === 2n && (await account('alice')).shares === 0n,
    'The repayment serves the rest of the request before anything else');
  check(['InsufficientLiquidity', 'IneligibleDeal'].includes(fundAttempt?.error) && !(await vault('funded', [fifthId])), 'The new loan waits until the strategy has liquidity and headroom beyond the queue');
  await write('alice', a.HybridVault, 'HybridVault', 'claim');
  check((await account('alice')).claimable === 0n && (await account('alice')).assets === 0n, 'Alice has left the strategy entirely');
  await deposit('bob', 1500n * U);
  const refilledReport = await operate({loanId: String(fifthId)});
  check(confirmed(refilledReport, 'investReserve') && confirmed(refilledReport, 'fund') && (await coreLoan(fifthId)).state === 2, 'A fresh deposit is parked, then funds the waiting approval from the reserve');

  // ---------------------------------------------------------------- overdue write-down and a side pocket for the holders of record
  const fifth = await coreLoan(fifthId);
  await warp(BigInt(fifth.fundedAt) + BigInt(fifth.term) + 1n);
  check(await vault('lockedProfitNow') === 0n, 'The second premium has fully unlocked by the end of the next term');
  const impairedAssets = await vault('totalAssets'), bobImpairedAssets = (await account('bob')).assets;
  check(!(await vault('overdue', [fifthId])) && await vault('performingPrincipal') === 200n * U
    && approx(impairedAssets, await vault('cash') + await reserveValue()),
    'Pricing excludes matured principal before the keeper records its write-down');
  const overdueReport = await operate({fund: false});
  check(confirmed(overdueReport, 'markOverdue') && await vault('overdue', [fifthId]) && await vault('overduePrincipal') === 200n * U && await vault('performingPrincipal') === 0n,
    'Keeper writes down a loan that passed its term without repaying');
  check(approx(await vault('totalAssets'), impairedAssets) && approx((await account('bob')).assets, bobImpairedAssets), 'Recording the overdue loss preserves the price already shown at term end');
  check(!(await vault('terminal', [fifthId])) && (await coreLoan(fifthId)).state === 2, 'During grace the loan stays open on the core');
  const supplyAtWriteDown = await vault('totalSupply');
  const bobHeld = (await account('bob')).shares, curator2Held = (await account('curator2')).shares;
  await deposit('alice', 100n * U);
  const assetsAfterLateEntry = await vault('totalAssets');
  await warp(BigInt(fifth.fundedAt) + BigInt(fifth.term) + BigInt(state.grace) + 1n);
  const feesBeforeDefault = await vault('feeAccrued');
  const defaultReport = await operate({fund: false});
  check(confirmed(defaultReport, 'settle') && (await coreLoan(fifthId)).state === 4 && await vault('terminal', [fifthId]) && await vault('overduePrincipal') === 0n,
    'Keeper finalizes the default and recovers collateral in one settlement');
  const pocket = await vault('pockets', [1n]);
  check(await vault('pocketCount') === 1n && pocket[0] === fifthId && pocket[1].toLowerCase() === a.CollateralToken.toLowerCase() && pocket[2] === 10n * E && pocket[3] === supplyAtWriteDown && pocket[4] === 0n,
    'The default opens a side pocket of the recovered collateral for the holders of record');
  check(await read(a.CollateralToken, 'MockERC20', 'balanceOf', [a.HybridVault]) === 10n * E && approx(await vault('totalAssets'), assetsAfterLateEntry), 'Recovered collateral stays its own token and is never priced');
  check(await vault('feeAccrued') === feesBeforeDefault, 'Collateral outcomes charge no performance fee');
  check(await vault('balanceOfAt', [address('alice'), 1n]) === 0n && await vault('pocketClaimable', [1n, address('alice')]) === 0n, 'A depositor who arrives after write-down but before collateral collection owns none of the pocket');
  await reverted('alice', 'claimPocket', [1n]);
  check(await vault('balanceOfAt', [address('bob'), 1n]) === bobHeld && await vault('pocketClaimable', [1n, address('bob')]) === 10n * E * bobHeld / supplyAtWriteDown, 'Holders of record keep their exact pocket share');
  const bobTokens = await read(a.CollateralToken, 'MockERC20', 'balanceOf', [address('bob')]);
  await write('bob', a.HybridVault, 'HybridVault', 'claimPocket', [1n]);
  await write('curator2', a.HybridVault, 'HybridVault', 'claimPocket', [1n]);
  check(await read(a.CollateralToken, 'MockERC20', 'balanceOf', [address('bob')]) === bobTokens + 10n * E * bobHeld / supplyAtWriteDown, 'Bob receives his exact collateral entitlement');
  check(approx((await vault('pockets', [1n]))[4], 10n * E, 2n) && await read(a.CollateralToken, 'MockERC20', 'balanceOf', [address('curator2')]) === 10n * E * curator2Held / supplyAtWriteDown, 'The pocket is exhausted by the holders of record');
  await reverted('bob', 'claimPocket', [1n]);
  check(await vault('pocketClaimable', [1n, address('bob')]) === 0n, 'Pocket claims cannot be repeated');

  // ---------------------------------------------------------------- a partial commitment refunded, and an expired listing cancelled
  const partialId = await listLoan('borrowerB', a.MemeToken, 630n * U);
  await approve(partialId, 1);
  const partialReport = await operate({loanId: String(partialId)});
  check(confirmed(partialReport, 'fund'), 'Keeper buys a single approved quarter');
  const partial = await coreLoan(partialId);
  check(partial.state === 1 && partial.filled === 1 && await vault('positionPrincipal', [partialId]) === 150n * U && await vault('performingPrincipal') === 150n * U, 'One quarter leaves the listing funding at a quarter of its principal, carried at cost');
  const feesBeforeRefund = await vault('feeAccrued'), lockedBeforeRefund = await vault('lockedProfitNow'), assetsBeforeRefund = await vault('totalAssets');
  await write('curator', a.HybridVault, 'HybridVault', 'withdrawCommitment', [partialId]);
  check(await vault('withdrawn', [partialId]) && (await coreLoan(partialId)).filled === 0, 'Curator releases the strategy’s quarter from an unfilled listing');
  const refundReport = await operate({fund: false});
  check(confirmed(refundReport, 'settle') && await vault('terminal', [partialId]) && await vault('performingPrincipal') === 0n, 'Released commitment settles as a refund');
  check(await vault('feeAccrued') === feesBeforeRefund && await vault('lockedProfitNow') <= lockedBeforeRefund && approx(await vault('totalAssets'), assetsBeforeRefund), 'Refunds are neither profit nor loss and charge no fee');
  const expiredId = await listLoan('borrowerB', a.MemeToken, 630n * U, 3600n);
  await approve(expiredId, 1);
  await operate({loanId: String(expiredId)});
  check((await coreLoan(expiredId)).filled === 1, 'Keeper buys one quarter of a listing that will expire');
  await warp(BigInt((await coreLoan(expiredId)).fundingDeadline) + 1n);
  const expiryReport = await operate({fund: false});
  check(confirmed(expiryReport, 'cancelFunding'), 'Keeper cancels a listing whose funding window closed');
  check(confirmed(expiryReport, 'settle') && (await coreLoan(expiredId)).state === 5 && await vault('terminal', [expiredId]) && await vault('performingPrincipal') === 0n, 'Cancelled listing settles as a refund in the same pass');
  const strategy = await runtime.vaultState(a.HybridVault);
  check(strategy.pendingShares === 0n && strategy.claimableTotal === 0n && await usdgOf(a.HybridVault) === strategy.cash + strategy.feeAccrued, 'Strategy USDG equals cash plus accrued fees once every request and claim is paid');
  runtime.save(state, output);
  writeReport(path.join(output, 'result.json'), {schemaVersion: 2, localOnly: true, chainId: 31337, rpc,
    passed: true, checks, final: {strategy, alice: await account('alice'), bob: await account('bob'), curator2: await account('curator2')}, transactions: state.transactions});
  console.log(`Hybrid integration rehearsal passed ${checks.length} checks. Evidence: ${path.join(output, 'result.json')}`);
} catch (error) {
  runtime.save(state, output);
  writeReport(path.join(output, 'result.json'), {schemaVersion: 2, localOnly: true, passed: false, checks,
    error: error.shortMessage ?? error.message, transactions: state.transactions});
  throw error;
} finally {
  child.kill('SIGTERM');
}
