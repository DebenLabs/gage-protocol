import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createArtifactLoader, localRpc, validateManifest, webEnvironment, ACTOR_NAMES, viem, accounts} from './runtime.mjs';

test('artifact preflight freezes deployment bytes across concurrent compiler writes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'earn-artifacts-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.mkdirSync(path.join(directory, 'HybridVault.sol'));
  const filename = path.join(directory, 'HybridVault.sol/HybridVault.json');
  const original = {abi: [], bytecode: {object: '0x6000'}};
  fs.writeFileSync(filename, JSON.stringify(original));
  const load = createArtifactLoader(directory);
  assert.deepEqual(load('HybridVault'), original);
  fs.writeFileSync(filename, JSON.stringify({...original, bytecode: {object: '0x6001'}}));
  assert.deepEqual(load('HybridVault'), original);
  assert.equal(createArtifactLoader(directory)('HybridVault').bytecode.object, '0x6001');
  assert.throws(() => load('Missing'), /missing Missing artifact/);
  fs.writeFileSync(filename, '{');
  assert.throws(() => createArtifactLoader(directory)('HybridVault'), SyntaxError);
  assert.deepEqual(load('HybridVault'), original);
});

function fixture() {
  const names = ['HybridFactory', 'HybridVault', 'HybridFees', 'EarnCore', 'EarnCoreRegistry', 'EarnCoreRewards', 'DealVault', 'USDG', 'CollateralToken', 'MemeToken', 'Reserve', 'CollateralRegistry', 'EntryRouter', 'FeeSink'];
  const addresses = Object.fromEntries(names.map((name, i) => [name, viem.getAddress(viem.toHex(BigInt(100 + i), {size: 20}))]));
  const state = {schemaVersion: 1, chainId: 31337, localOnly: true, rpc: 'http://127.0.0.1:18559', earnStartBlock: 10, earnReadyBlock: 20, grace: 172800, addresses,
    runtimeCodeHashes: Object.fromEntries(names.map(name => [name, `0x${'1'.repeat(64)}`])),
    accounts: Object.fromEntries(ACTOR_NAMES.map((name, i) => [name, {address: accounts.privateKeyToAccount(viem.toHex(BigInt(i + 1), {size: 32})).address}]))};
  const deployment = {...addresses, HybridReserve: addresses.Reserve, chainId: 31337, localFork: true};
  const catalog = [{id: 'local-hybrid-nvda', chainId: 31337, localFixture: true, address: addresses.HybridVault, startBlock: state.earnStartBlock, grace: state.grace,
    expected: {core: addresses.EarnCore, coreRewards: addresses.EarnCoreRewards, registry: addresses.EarnCoreRegistry, usdg: addresses.USDG,
      collateral: addresses.CollateralToken, reserve: addresses.Reserve, fees: addresses.HybridFees, allocator: state.accounts.curator.address}}];
  return {state, deployment, catalog};
}

test('RPC guard admits only plain loopback HTTP endpoints', () => {
  for (const good of ['http://127.0.0.1:18559', 'http://localhost:18559/', 'http://[::1]:18559']) assert.equal(localRpc(good), good);
  for (const bad of ['https://127.0.0.1:18559', 'http://127.0.0.1.example.com', 'http://example.com',
    'http://user:secret@127.0.0.1', 'http://127.0.0.1/private', 'http://127.0.0.1?key=secret', 'http://127.0.0.1#fragment']) {
    assert.throws(() => localRpc(bad), /plain loopback/);
  }
});

test('manifest rejects wrong chain, identities and unknown signing accounts', () => {
  const {state} = fixture();
  assert.equal(validateManifest(state), state);
  for (const changed of [{chainId: 4663}, {localOnly: false}, {rpc: 'https://rpc.example.com'},
    {earnStartBlock: 0}, {earnStartBlock: undefined}, {earnReadyBlock: 9}, {grace: undefined}, {grace: 604801},
    {accounts: {...state.accounts, alice: {address: state.accounts.bob.address}}},
    {addresses: {...state.addresses, Reserve: state.addresses.USDG}},
    {runtimeCodeHashes: {...state.runtimeCodeHashes, Reserve: ''}}]) {
    assert.throws(() => validateManifest({...state, ...changed}));
  }
});

test('share-vault manifest pins the fee companion, the V2 core and both collateral identities without a rewards contract', () => {
  const {state} = fixture();
  assert.equal('HybridRewards' in state.addresses, false, 'rewards accrue per share inside the vault (D82)');
  for (const name of ['HybridFees', 'MemeToken', 'EarnCore', 'EarnCoreRegistry', 'EarnCoreRewards']) {
    const missingAddress = structuredClone(state);
    delete missingAddress.addresses[name];
    assert.throws(() => validateManifest(missingAddress), /Missing/);
    const missingHash = structuredClone(state);
    delete missingHash.runtimeCodeHashes[name];
    assert.throws(() => validateManifest(missingHash), /runtime hash/);
  }
  assert.throws(() => validateManifest({...state, addresses: {
    ...state.addresses, HybridFees: state.addresses.HybridVault,
  }}), /identities must differ/);
});

test('web launcher forwards only allowlisted process environment and local config', () => {
  const {state, deployment, catalog} = fixture();
  const env = webEnvironment({PATH: '/usr/bin', HOME: '/tmp/test', HYBRID_PRIVATE_KEY: 'secret',
    NEXT_PUBLIC_RPC_URL: 'https://remote', GAGE_DEPLOYMENT_FILE: '/remote.json', DATABASE_URL: 'secret'}, state, deployment, catalog);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.NEXT_PUBLIC_RPC_URL, state.rpc);
  assert.equal(env.GAGE_NEXT_DIST_DIR, '.next-hybrid-local');
  assert.equal(env.NEXT_PUBLIC_HYBRID_LOCAL_ACCOUNT, state.accounts.alice.address);
  assert.equal(env.NEXT_PUBLIC_HYBRID_LOCAL, '1');
  assert.deepEqual(JSON.parse(env.NEXT_PUBLIC_HYBRID_LOCAL_STRATEGIES_JSON), catalog);
  assert(!Object.keys(env).some(name => name.includes('ACCUMULATE')));
  assert(!('HYBRID_PRIVATE_KEY' in env) && !('DATABASE_URL' in env) && !('GAGE_DEPLOYMENT_FILE' in env));
  const indexed = webEnvironment({}, state, deployment, catalog, {indexerUrl: 'http://127.0.0.1:42091'});
  assert.equal(indexed.NEXT_PUBLIC_INDEXER_URL, 'http://127.0.0.1:42091');
  assert.throws(() => webEnvironment({}, state, deployment, catalog, {indexerUrl: 'https://remote.example'}), /plain loopback/);
});

test('web launcher rejects production, mixed deployments and foreign catalog identities', () => {
  const {state, deployment, catalog} = fixture();
  for (const env of [{NODE_ENV: 'production'}, {VERCEL: '1'}, {RAILWAY_ENVIRONMENT_ID: 'production'}]) {
    assert.throws(() => webEnvironment(env, state, deployment, catalog), /development-only/);
  }
  assert.throws(() => webEnvironment({}, state, {...deployment, USDG: state.addresses.CollateralToken}, catalog), /differs/);
  assert.throws(() => webEnvironment({}, state, deployment, [{...catalog[0], localFixture: false}]), /catalog/);
  assert.throws(() => webEnvironment({}, state, deployment, [{...catalog[0], expected: {...catalog[0].expected, reserve: state.addresses.USDG}}]), /differs/);
});

test('operator action scope covers the share-vault maintenance pass and excludes underwriting and holder withdrawals', async () => {
  const {actionAllowed} = await import('./operator.mjs');
  for (const name of ['cancelFunding', 'settle', 'markOverdue', 'harvestCash', 'harvestRewards', 'serveRequests', 'investReserve', 'fund']) assert(actionAllowed(name));
  for (const name of ['approveLoan', 'revokeLoan', 'withdrawCommitment', 'divestReserve', 'setPaused', 'setFee', 'deposit', 'redeem', 'withdraw',
    'requestRedeem', 'cancelRequest', 'claim', 'claimPocket', 'claimRewards', 'claimFees', 'transfer', 'approve', 'reclaim', 'recoverDefault',
    'investCash', 'processExit', 'pruneLots', 'requeueLots', 'mergeLots', 'claimCollateral']) assert(!actionAllowed(name), name);
});

test('web discovery pins its deployment block, core, registry and fee companion identities', () => {
  const {state, deployment, catalog} = fixture();
  assert.doesNotThrow(() => webEnvironment({}, state, deployment, catalog));
  for (const startBlock of [undefined, 0, state.earnStartBlock - 1, state.earnStartBlock + 1]) {
    assert.throws(() => webEnvironment({}, state, deployment, [{...catalog[0], startBlock}]), /deployment block/);
  }
  assert.throws(() => webEnvironment({}, state, deployment, [{...catalog[0], grace: 1}]), /grace/);
  for (const field of ['core', 'coreRewards', 'registry', 'fees']) {
    assert.throws(() => webEnvironment({}, state, deployment, [{...catalog[0], expected: {
      ...catalog[0].expected, [field]: state.addresses.USDG,
    }}]), /differs/);
  }
  for (const field of ['HybridVault', 'HybridFees', 'HybridReserve', 'EarnCore']) {
    assert.throws(() => webEnvironment({}, state, {...deployment, [field]: state.addresses.USDG}, catalog), /differs/);
  }
});
