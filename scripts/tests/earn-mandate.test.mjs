import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEarnMandate, earnMandateHash, EARN_RESERVE, UINT128_MAX, LANES, normalizeEarnLaneWeights, normalizeEarnDepositLimits, earnStrategyIdentity} from '../lib/earn-mandate.mjs';

export const mandateFixture = () => ({
  schemaVersion: 1, chainId: 4663, reviewed: true, mainnetExecutionApproved: false,
  reserve: EARN_RESERVE, core: '0x0000000000000000000000000000000000000020', minDeposit: '100000000',
  maxTotalDeposits: '100000000000',
  maxLoanTerm: 1814400, minReturnBps: 0, maxGageExposureBps: 10000,
  laneWeights: {STOCK: 10000, MEME: 0, LP: 0},
  admittedTokens: [{token: '0x0000000000000000000000000000000000000001', ceiling: '1000000000'}],
  feeBps: 1000, protocolShareBps: 2500, feeRecipient: '0x0000000000000000000000000000000000000002',
});

test('a reviewed mandate is canonical and execution approval is independent', () => {
  const input = mandateFixture();
  const local = normalizeEarnMandate(input, {localFork: true});
  assert.equal(local.minDeposit, '100000000');
  assert.equal('minContribution' in local, false, 'the share model has no per-loan contribution floor (D82)');
  assert.throws(() => normalizeEarnMandate(input), /Earn mainnet execution remains disabled/);
  input.mainnetExecutionApproved = true;
  assert.deepEqual(normalizeEarnMandate(input), {...local, mainnetExecutionApproved: true});
});

test('comments and execution approval do not change substantive mandate identity', () => {
  const input = mandateFixture();
  const hash = earnMandateHash(input);
  assert.equal(earnMandateHash({...input, mainnetExecutionApproved: true, _comments: {fee: 'review'}}), hash);
  assert.notEqual(earnMandateHash({...input, feeBps: 0}), hash);
  assert.notEqual(earnMandateHash({...input, reviewed: false}), hash);
});

test('every founder placeholder and invalid bound fails before deployment', () => {
  const cases = [
    ['schemaVersion', 2], ['chainId', 46630], ['reviewed', false], ['reserve', null],
    ['reserve', '0x0000000000000000000000000000000000000001'],
    ['core', null], ['core', EARN_RESERVE], ['core', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'],
    ['minDeposit', null], ['minDeposit', 0], ['minDeposit', '-1'],
    ['maxTotalDeposits', String(UINT128_MAX + 1n)], ['maxTotalDeposits', 1.1],
    ['maxLoanTerm', 7776001], ['maxLoanTerm', 86400], ['maxLoanTerm', null],
    ['minReturnBps', 10001], ['maxGageExposureBps', 0], ['feeBps', 5001], ['feeBps', 1.5],
    ['protocolShareBps', 10001], ['protocolShareBps', -1], ['protocolShareBps', null],
    ['feeRecipient', '0x0000000000000000000000000000000000000000'],
    ['laneWeights', {STOCK: 6000, MEME: 4000, LP: 1}],
    ['laneWeights', {STOCK: -1, MEME: 0, LP: 0}],
    ['admittedTokens', [{token: null, ceiling: null}]],
    ['admittedTokens', [{token: EARN_RESERVE, ceiling: '1'}]],
    ['admittedTokens', [{token: '0x0000000000000000000000000000000000000020', ceiling: '1'}]],
    ['admittedTokens', [{token: '0x0000000000000000000000000000000000000001', ceiling: '0'}]],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => normalizeEarnMandate({...mandateFixture(), [field]: value}, {localFork: true}), undefined, field);
  }
  const input = mandateFixture();
  assert.throws(() => normalizeEarnMandate({...input, admittedTokens: [...input.admittedTokens, ...input.admittedTokens]}, {localFork: true}), /Duplicate/);
});

test('only the deposit minimum and total deposit cap remain in constructor amounts', () => {
  const valid = mandateFixture();
  assert.throws(() => normalizeEarnMandate({...valid, minDeposit: '100000000001'}, {localFork: true}), /minimum deposit exceeds/);
  const removed = normalizeEarnMandate({...valid, maxPerLoan: '1', maxPerBorrower: '1'}, {localFork: true});
  assert.equal('maxPerLoan' in removed, false, 'a stale loan limit is never deployed');
  assert.equal('maxPerBorrower' in removed, false, 'a stale borrower limit is never deployed');
  assert.equal(normalizeEarnMandate({...valid, minContribution: '1'}, {localFork: true}).minContribution, undefined, 'a stale contribution field is ignored, never deployed');
  assert.equal(normalizeEarnMandate({...valid, minDeposit: '100000000000'}, {localFork: true}).minDeposit, '100000000000', 'a minimum equal to the cap is the boundary');
  assert.equal(normalizeEarnMandate({...valid, feeBps: 0}, {localFork: true}).feeBps, 0);
  assert.throws(() => normalizeEarnMandate({...valid, feeBps: 0, feeRecipient: '0x0000000000000000000000000000000000000000'}, {localFork: true}), /fee recipient/);
  assert.equal(normalizeEarnMandate({...valid, protocolShareBps: 0}, {localFork: true}).protocolShareBps, 0);
  assert.equal(normalizeEarnMandate({...valid, protocolShareBps: 10000}, {localFork: true}).protocolShareBps, 10000);
  assert.equal(normalizeEarnMandate({...valid, feeBps: 5000, maxLoanTerm: 604800}, {localFork: true}).feeBps, 5000);
});


test('strategy categories have their own order and enforce one combined 100% cap', () => {
  assert.deepEqual(LANES, ['STOCK', 'MEME', 'LP']);
  const weights = normalizeEarnLaneWeights({LP: 2500, MEME: 1500, STOCK: 6000});
  assert.deepEqual(LANES.map(lane => weights[lane]), [6000, 1500, 2500]);
  assert.deepEqual(normalizeEarnLaneWeights({STOCK: 6000, MEME: 4000, LP: 0}), {STOCK: 6000, MEME: 4000, LP: 0});
  assert.deepEqual(normalizeEarnLaneWeights({STOCK: 0, MEME: 0, LP: 0}), {STOCK: 0, MEME: 0, LP: 0});
  for (const value of [
    {STOCK: 6000, MEME: 4000, LP: 1}, {STOCK: 0, MEME: 0, LP: 10001},
    {STOCK: 0, MEME: 0, LP: -1}, {STOCK: 0, MEME: 0, LP: 1.5},
  ]) assert.throws(() => normalizeEarnLaneWeights(value), /bound|100%/);
  for (const value of [
    {STOCK: 0, ETH: 10000, MEME: 0}, {STOCK: 6000, MEME: 4000, LP: 0, ETH: 0},
    {STOCK: 6000, MEME: 4000}, [6000, 2000, 2000], null,
  ]) assert.throws(() => normalizeEarnLaneWeights(value), /STOCK, MEME and LP/);
});

test('constructor deposit limits accept the uint128 boundary without rounding', () => {
  assert.deepEqual(normalizeEarnDepositLimits({minDeposit: String(UINT128_MAX), maxTotalDeposits: String(UINT128_MAX)}),
    {minDeposit: String(UINT128_MAX), maxTotalDeposits: String(UINT128_MAX)});
  assert.throws(() => normalizeEarnDepositLimits({minDeposit: '1', maxTotalDeposits: '0'}), /amount/);
  assert.throws(() => normalizeEarnDepositLimits({minDeposit: '2', maxTotalDeposits: '1'}), /minimum deposit exceeds/);
});

test('an LP-only mandate needs no ERC-20 token ceilings', () => {
  const mandate = normalizeEarnMandate({...mandateFixture(), laneWeights: {STOCK: 0, MEME: 0, LP: 10000}, admittedTokens: []}, {localFork: true});
  assert.deepEqual(mandate.laneWeights, {STOCK: 0, MEME: 0, LP: 10000});
  assert.deepEqual(mandate.admittedTokens, []);
});

test('a mandate names its strategy; the flagship needs no identity and every other strategy needs a slug and title', () => {
  assert.deepEqual(earnStrategyIdentity({}), {id: 'gage-mix', title: 'Gage USDG Mix'});
  assert.deepEqual(earnStrategyIdentity({id: 'stocks', title: ' Gage USDG Stocks '}, 'stocks'), {id: 'stocks', title: 'Gage USDG Stocks'});
  assert.throws(() => earnStrategyIdentity({id: 'stocks', title: 'Gage USDG Stocks'}, 'memes'), /different strategy/);
  assert.throws(() => earnStrategyIdentity({id: 'stocks'}), /title/);
  assert.throws(() => earnStrategyIdentity({id: 'Stocks', title: 'x'}), /slug/);
  assert.throws(() => earnStrategyIdentity({id: 'stocks', title: 'ab'}), /title/);
  assert.equal(earnStrategyIdentity({}, 'gage-mix').id, 'gage-mix');
});
