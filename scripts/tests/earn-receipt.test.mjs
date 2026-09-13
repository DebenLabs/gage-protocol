import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {bindEarnReceipt, earnTransactions, recoverEarnAddress, recoverEarnInstance, earnDeployment, earnStrategyEntries} from '../lib/earn-receipt.mjs';
const require = createRequire(new URL('../../services/keeper/package.json', import.meta.url));
const viem = require('viem');
const address = '0x0000000000000000000000000000000000000001';
const deployed = '0x0000000000000000000000000000000000000002';
const blockHash = '0x' + 'ab'.repeat(32);
const binding = {chainId: 4663, owner: address, localFork: true, mandateHash: 'm', releaseHash: 'r', baseHash: 'b', artifacts: {HybridVault: 'v', HybridFees: 'f'}};
function fixture() {
  let nonce = 0, broadcasts = 0, saved = 0, signs = 0;
  const receipts = new Map();
  const journal = bindEarnReceipt(null, binding);
  const missing = name => Object.assign(new Error('missing'), {name});
  const account = {address, signTransaction: async tx => {signs++; return viem.stringToHex(JSON.stringify(tx, (_, v) => typeof v === 'bigint' ? String(v) : v));}};
  const receipt = hash => ({transactionHash: hash, status: 'success', blockNumber: 10n, blockHash, contractAddress: deployed, gasUsed: 100n, effectiveGasPrice: 2n});
  const pub = {
    getChainId: async () => 4663, getTransactionCount: async () => nonce,
    estimateGas: async () => 100n, estimateFeesPerGas: async () => ({maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}),
    getBalance: async () => 10n ** 18n,
    getTransactionReceipt: async ({hash}) => {if (!receipts.has(hash)) throw missing('TransactionReceiptNotFoundError'); return receipts.get(hash);},
    getTransaction: async () => {throw missing('TransactionNotFoundError');},
    sendRawTransaction: async ({serializedTransaction}) => {broadcasts++; nonce++; const hash = viem.keccak256(serializedTransaction); receipts.set(hash, receipt(hash)); return hash;},
    waitForTransactionReceipt: async ({hash}) => receipts.get(hash),
  };
  const send = earnTransactions({pub, account, chainId: 4663, journal, save: () => {saved++;}, viem});
  return {pub, journal, send, receipts, receipt, stats: () => ({nonce, broadcasts, saved, signs}), setNonce: x => {nonce = x;}};
}

test('receipt binds owner, base, mandate, artifacts and source proof', () => {
  const journal = bindEarnReceipt(null, binding);
  assert.equal(bindEarnReceipt(journal, binding), journal);
  for (const key of Object.keys(binding)) assert.throws(() => bindEarnReceipt(journal, {...binding, [key]: 'different'}), /receipt binding/);
  journal.addresses.DealVault = deployed;
  assert.throws(() => bindEarnReceipt(journal, binding), /unexpected address/);
});

test('confirmed deployment recovers its exact address and consumes no additional nonce', async () => {
  const f = fixture();
  await f.send('deploy:HybridVault', {data: '0x1234'});
  const before = f.stats();
  delete f.journal.addresses.HybridVault;
  f.journal.steps['deploy:HybridVault'].status = 'prepared';
  await f.send('deploy:HybridVault', {data: '0x1234'});
  assert.equal(recoverEarnAddress(f.journal, 'HybridVault', deployed), deployed);
  assert.equal(f.stats().broadcasts, before.broadcasts);
  assert.equal(f.stats().signs, before.signs);
  assert.equal(f.journal.steps['deploy:HybridVault'].blockHash, blockHash);
  assert.throws(() => recoverEarnAddress(f.journal, 'HybridVault', address), /deployment address/);
});

test('one-time fee companion wiring resumes without another transaction', async () => {
  const f = fixture();
  await f.send('configure:fees', {to: deployed, data: '0x5678'});
  await f.send('configure:fees', {to: deployed, data: '0x5678'});
  assert.equal(f.stats().broadcasts, 1);
  await assert.rejects(f.send('configure:fees', {to: deployed, data: '0xabcd'}), /intent changed/);
});

test('prepared but unsent transaction retries the saved hash and nonce', async () => {
  const f = fixture();
  f.pub.sendRawTransaction = async () => {throw new Error('connection stopped');};
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}));
  const old = structuredClone(f.journal.steps['deploy:HybridVault']);
  f.pub.sendRawTransaction = async ({serializedTransaction}) => {const hash = viem.keccak256(serializedTransaction); assert.equal(hash, old.hash); f.receipts.set(hash, f.receipt(hash)); return hash;};
  await f.send('deploy:HybridVault', {data: '0x1234'});
  assert.deepEqual(f.journal.steps['deploy:HybridVault'].tx, old.tx);
});

test('known pending transaction is awaited without another signature or broadcast', async () => {
  const f = fixture();
  f.pub.sendRawTransaction = async () => {throw Error('broadcast response lost');};
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}));
  const before = f.stats();
  const step = f.journal.steps['deploy:HybridVault'];
  f.pub.getTransaction = async () => ({hash: step.hash});
  f.pub.waitForTransactionReceipt = async () => f.receipt(step.hash);
  await f.send('deploy:HybridVault', {data: '0x1234'});
  assert.equal(f.stats().signs, before.signs);
  assert.equal(f.stats().broadcasts, before.broadcasts);
});

test('a changed RPC chain stops before signing', async () => {
  const f = fixture();
  f.pub.getChainId = async () => 1;
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}), /chain changed/);
  assert.equal(f.stats().signs, 0);
});

test('unresolved, failed, consumed and unrelated pending transactions stop advancement', async () => {
  const f = fixture();
  f.journal.steps.old = {status: 'prepared'};
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}), /unresolved/);
  f.journal.steps.old.status = 'failed';
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}), /failed/);
  delete f.journal.steps.old;
  f.pub.getTransactionCount = async ({blockTag}) => blockTag === 'pending' ? 1 : 0;
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}), /pending transaction/);
  assert.equal(f.stats().signs, 0);
  f.pub.getTransactionCount = async () => 0;
  f.pub.sendRawTransaction = async () => {throw new Error('offline');};
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}));
  f.pub.getTransactionCount = async () => 1;
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}), /nonce was consumed/);
});

test('reverted receipt is retained and prevents all later steps; reorg is rejected', async () => {
  const f = fixture();
  f.pub.waitForTransactionReceipt = async ({hash}) => ({...f.receipt(hash), status: 'reverted'});
  await assert.rejects(f.send('deploy:HybridVault', {data: '0x1234'}), /reverted/);
  assert.equal(f.journal.steps['deploy:HybridVault'].status, 'failed');
  assert.equal(f.journal.steps['deploy:HybridVault'].blockHash, blockHash);
  await assert.rejects(f.send('deploy:HybridFees', {data: '0x1234'}), /failed/);
  const g = fixture();
  await g.send('deploy:HybridVault', {data: '0x1234'});
  g.receipts.get(g.journal.steps['deploy:HybridVault'].hash).blockHash = '0x' + 'cd'.repeat(32);
  await assert.rejects(g.send('deploy:HybridVault', {data: '0x1234'}), /block hash/);
});

test('Earn export preserves base fields, start block and deployment owner', () => {
  const base = {chainId: 4663, deployer: address, startBlock: 123, pools: {example: {currency0: address}}, unknown: {preserved: true}};
  const journal = bindEarnReceipt(null, binding);
  journal.steps = {'deploy:HybridFactory': {blockNumber: '150', status: 'confirmed'}, 'create:HybridVault': {blockNumber: '160', status: 'confirmed'}};
  journal.addresses = {HybridFactory: '0x0000000000000000000000000000000000000003', HybridVault: deployed, HybridFees: address};
  const core = '0x0000000000000000000000000000000000000009';
  const result = earnDeployment(base, journal, {reserve: deployed, core}, 'receipt.json');
  for (const [key, value] of Object.entries(base)) assert.deepEqual(result[key], value);
  assert.equal(result.earnStartBlock, 160);
  assert.equal(result.hybridFactoryStartBlock, 150);
  assert.equal(result.HybridFactory, journal.addresses.HybridFactory);
  assert.equal(result.earnMandate.curator, binding.owner);
  assert.equal(result.HybridReserve, deployed);
  assert.equal(result.HybridFees, address);
  assert.equal('HybridRewards' in result, false, 'no rewards companion is exported (D82)');
  assert.equal(result.EarnCore, core);
  assert.equal(result.localFork, true);
  journal.addresses.deployer = deployed;
  assert.equal(earnDeployment(base, journal, {reserve: deployed, core}, 'receipt.json').deployer, base.deployer);
});

test('a later strategy joins the published flagship in earnStrategies without touching the flat keys', () => {
  const factory = '0x0000000000000000000000000000000000000003', core = '0x0000000000000000000000000000000000000009';
  const flagshipVault = '0x0000000000000000000000000000000000000004', flagshipFees = '0x0000000000000000000000000000000000000005';
  const stocksVault = '0x0000000000000000000000000000000000000006', stocksFees = '0x0000000000000000000000000000000000000007';
  const base = {chainId: 4663, deployer: address, HybridFactory: factory, hybridFactoryStartBlock: 150, HybridVault: flagshipVault, HybridFees: flagshipFees,
    HybridReserve: deployed, EarnCore: core, earnStartBlock: 160, earnMandate: {feeBps: 1500, curator: address}, earnReceipt: 'flagship.json'};
  assert.deepEqual(earnStrategyEntries(base).map(item => [item.id, item.title, item.HybridVault, item.earnReceipt]), [['gage-mix', 'Gage USDG Mix', flagshipVault, 'flagship.json']]);
  assert.deepEqual(earnStrategyEntries({chainId: 4663}), []);
  const journal = bindEarnReceipt(null, {...binding, deploymentKind: 'factory-instance', strategy: {id: 'stocks', title: 'Gage USDG Stocks'}});
  journal.steps = {'create:HybridVault': {blockNumber: '170', status: 'confirmed'}};
  journal.addresses = {HybridFactory: factory, HybridVault: stocksVault, HybridFees: stocksFees};
  const stocks = {id: 'stocks', title: 'Gage USDG Stocks'};
  const result = earnDeployment(base, journal, {reserve: deployed, core, feeBps: 1500}, 'stocks.json', stocks);
  for (const [key, value] of Object.entries(base)) assert.deepEqual(result[key], value, key + ' stays as published');
  assert.deepEqual(result.earnStrategies.map(item => [item.id, item.HybridVault, item.HybridFees, item.earnStartBlock, item.earnReceipt]),
    [['gage-mix', flagshipVault, flagshipFees, 160, 'flagship.json'], ['stocks', stocksVault, stocksFees, 170, 'stocks.json']]);
  assert.equal(result.earnStrategies[1].earnMandate.curator, binding.owner);
  assert.equal(result.earnStrategies[1].title, 'Gage USDG Stocks');
  // Re-exporting the same id replaces its entry; a third strategy appends behind it.
  const again = earnDeployment(result, journal, {reserve: deployed, core, feeBps: 1500}, 'stocks.json', stocks);
  assert.equal(again.earnStrategies.length, 2);
  const third = earnDeployment(result, {...journal, addresses: {...journal.addresses, HybridVault: '0x0000000000000000000000000000000000000008', HybridFees: '0x000000000000000000000000000000000000000a'}},
    {reserve: deployed, core}, 'memes.json', {id: 'memes', title: 'Gage USDG Memes'});
  assert.deepEqual(third.earnStrategies.map(item => item.id), ['gage-mix', 'stocks', 'memes']);
  assert.throws(() => earnDeployment({chainId: 4663}, journal, {reserve: deployed, core}, 'stocks.json', stocks), /published flagship/);
  assert.throws(() => earnDeployment({...base, HybridFactory: deployed}, journal, {reserve: deployed, core}, 'stocks.json', stocks), /published flagship/);
  assert.throws(() => earnDeployment(base, journal, {reserve: address, core}, 'stocks.json', stocks), /share the factory reserve/);
  assert.throws(() => earnDeployment(base, {...journal, addresses: {...journal.addresses, HybridVault: flagshipVault}}, {reserve: deployed, core}, 'stocks.json', stocks), /already published/);
  assert.throws(() => earnDeployment(base, {...journal, steps: {}}, {reserve: deployed, core}, 'stocks.json', stocks), /confirmed factory instance/);
});

test('factory creation recovers both children from its receipt without another nonce', () => {
  const factory = '0x0000000000000000000000000000000000000003';
  const curator = '0x0000000000000000000000000000000000000004';
  const abi = viem.parseAbi(['event VaultCreated(address indexed vault,address indexed fees,address indexed curator,address creator)']);
  const hash = '0x' + 'cd'.repeat(32);
  const journal = bindEarnReceipt(null, binding);
  journal.steps['create:HybridVault'] = {hash, status: 'confirmed', tx: {to: factory}, blockHash, blockNumber: '10'};
  journal.addresses.HybridFactory = factory;
  const receipt = {transactionHash: hash, status: 'success', to: factory, from: curator, blockHash, blockNumber: 10n, logs: [{address: factory,
    topics: viem.encodeEventTopics({abi, eventName: 'VaultCreated', args: {vault: deployed, fees: address, curator}}),
    data: viem.encodeAbiParameters([{type: 'address'}], [curator])}]};
  const options = {factory, curator, abi, viem};
  assert.deepEqual(recoverEarnInstance(journal, receipt, options), {HybridVault: deployed, HybridFees: address});
  delete journal.addresses.HybridVault;
  assert.equal(recoverEarnInstance(journal, receipt, options).HybridVault, deployed);
  assert.throws(() => recoverEarnInstance(journal, {...receipt, logs: [{...receipt.logs[0], address: curator}]}, options), /creation event/);
  assert.throws(() => recoverEarnInstance(journal, {...receipt, logs: [...receipt.logs, ...receipt.logs]}, options), /creation event/);
  assert.throws(() => recoverEarnInstance(journal, receipt, {...options, curator: factory}), /matching confirmed creation receipt/);
  for (const changed of [
    {...receipt, to: curator}, {...receipt, from: factory}, {...receipt, blockHash: '0x' + 'ef'.repeat(32)},
    {...receipt, blockNumber: 11n}, {...receipt, transactionHash: '0x' + '12'.repeat(32)},
  ]) assert.throws(() => recoverEarnInstance(journal, changed, options), /matching confirmed creation receipt/);
  journal.addresses.HybridFactory = curator;
  assert.throws(() => recoverEarnInstance(journal, receipt, options), /matching confirmed creation receipt/);
  journal.addresses.HybridFactory = factory;
  journal.addresses.HybridFees = curator;
  assert.throws(() => recoverEarnInstance(journal, receipt, options), /instance address/);
});

test('old standalone receipts cannot be silently resumed as factory deployments', () => {
  const journal = bindEarnReceipt(null, binding);
  assert.throws(() => bindEarnReceipt(journal, {...binding, deploymentKind: 'factory-flagship'}), /receipt binding/);
  assert.throws(() => earnDeployment({}, journal, {}, 'receipt.json'), /confirmed factory instance/);
});
