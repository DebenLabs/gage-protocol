import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'services/keeper/package.json'));
export const viem = require('viem');
export const accounts = require('viem/accounts');
export const stringify = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n';
export const sameAddress = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();

export function createArtifactLoader(directory) {
  const loaded = new Map();
  return name => {
    if (!loaded.has(name)) {
      const filename = path.join(directory, `${name}.sol/${name}.json`);
      if (!fs.existsSync(filename)) throw new Error(`Build contracts first; missing ${name} artifact.`);
      loaded.set(name, JSON.parse(fs.readFileSync(filename, 'utf8')));
    }
    return loaded.get(name);
  };
}

// Preflight and deployment share the same bytes even if another Forge job writes out/.
// A final rehearsal may select a frozen build directory, including its local test fixtures.
export const artifact = createArtifactLoader(path.resolve(process.env.HYBRID_LOCAL_ARTIFACTS_DIRECTORY
  ?? path.join(root, 'contracts/out')));

export function writeReport(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, stringify(value), {mode: 0o600});
  fs.renameSync(temporary, filename);
}

export const DEFAULT_RPC = 'http://127.0.0.1:18559';
export const DEFAULT_OUTPUT = path.join(root, '.rehearsal/hybrid-local');
export const ACTOR_NAMES = ['curator', 'alice', 'bob', 'borrowerA', 'borrowerB', 'keeper', 'curator2'];
export const U = 10n ** 6n;
export const E = 10n ** 18n;

export function localRpc(value) {
  const url = new URL(value);
  assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'Hybrid rehearsal requires a plain loopback HTTP URL.');
  return value;
}

export function validateManifest(state) {
  assert(state?.schemaVersion === 1 && state.localOnly === true && state.chainId === 31337,
    'Only a generated local chain 31337 fixture is supported.');
  localRpc(state.rpc);
  assert(Number.isSafeInteger(state.earnStartBlock) && state.earnStartBlock > 0
    && Number.isSafeInteger(state.earnReadyBlock) && state.earnReadyBlock >= state.earnStartBlock,
  'Missing or invalid Earn deployment block range.');
  assert(Number.isInteger(state.grace) && state.grace >= 0 && state.grace <= 604800, 'Missing or invalid Earn core grace.');
  const identities = ['HybridFactory', 'HybridVault', 'HybridFees', 'EarnCore', 'EarnCoreRegistry', 'EarnCoreRewards', 'DealVault', 'USDG', 'CollateralToken', 'MemeToken', 'Reserve'];
  for (const name of identities) {
    const address = state.addresses?.[name];
    assert(viem.isAddress(address ?? '') && BigInt(address) !== 0n, `Missing ${name} address.`);
    assert(/^0x[0-9a-fA-F]{64}$/.test(state.runtimeCodeHashes?.[name] ?? ''), `Missing ${name} runtime hash.`);
  }
  assert(new Set(identities.map(name => state.addresses[name].toLowerCase())).size === identities.length,
    'Fixture identities must differ.');
  for (const name of ACTOR_NAMES) {
    const expected = accounts.privateKeyToAccount(viem.toHex(BigInt(ACTOR_NAMES.indexOf(name) + 1), {size: 32})).address;
    assert(sameAddress(state.accounts?.[name]?.address, expected), `Unexpected local ${name} account.`);
  }
  return state;
}

export function loadManifest(output = DEFAULT_OUTPUT) {
  return validateManifest(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')));
}

export function createRuntime(rpc) {
  localRpc(rpc);
  const pub = viem.createPublicClient({transport: viem.http(rpc, {retryCount: 0, timeout: 5000}), pollingInterval: 100});
  const actors = Object.fromEntries(ACTOR_NAMES.map((name, index) => {
    // Public, deterministic test accounts. Never accept a real signing key.
    const account = accounts.privateKeyToAccount(viem.toHex(BigInt(index + 1), {size: 32}));
    return [name, {account, wallet: viem.createWalletClient({account, transport: viem.http(rpc)})}];
  }));
  const transactions = [];
  const address = name => actors[name].account.address;
  const read = (target, artifactName, functionName, args = [], blockNumber) => pub.readContract({
    address: target, abi: artifact(artifactName).abi, functionName, args,
    ...(blockNumber === undefined ? {} : {blockNumber}),
  });
  /** One holder's view of the pooled share vault (D82): shares, what they are worth now, and what is owed to them. */
  async function accountState(target, owner) {
    const call = (functionName, args = [owner]) => read(target, 'HybridVault', functionName, args);
    const [shares, lockedShares, claimable, rewards] = await Promise.all([
      call('balanceOf'), call('lockedShares'), call('claimable'), call('rewardClaimable')]);
    const assets = await call('convertToAssets', [shares]);
    return {shares, lockedShares, assets, claimable, rewards};
  }
  /** The strategy's own totals, the numbers every holder's value is derived from. */
  async function vaultState(target) {
    const names = ['totalSupply', 'totalAssets', 'fullAssets', 'cash', 'reserveShares', 'performingPrincipal', 'overduePrincipal',
      'lockedProfitNow', 'pendingShares', 'claimableTotal', 'requestHead', 'requestCount', 'pocketCount', 'feeAccrued', 'paused'];
    const values = await Promise.all(names.map(name => read(target, 'HybridVault', name)));
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  }
  async function assertLocal() {
    assert.equal(await pub.getChainId(), 31337, 'Only chain 31337 is supported.');
    assert.match(await pub.request({method: 'web3_clientVersion'}), /anvil/i, 'Only Anvil is supported.');
  }
  async function receipt(hash, label) {
    const result = await pub.waitForTransactionReceipt({hash, timeout: 15_000});
    assert.equal(result.status, 'success', label);
    transactions.push({label, hash, blockNumber: String(result.blockNumber)});
    return result;
  }
  async function write(who, target, artifactName, functionName, args = []) {
    await assertLocal();
    const actor = actors[who];
    assert(actor, 'Unknown local fixture actor.');
    const [latest, pending] = await Promise.all([
      pub.getTransactionCount({address: actor.account.address, blockTag: 'latest'}),
      pub.getTransactionCount({address: actor.account.address, blockTag: 'pending'}),
    ]);
    assert.equal(latest, pending, 'Resolve the actor’s pending transaction before continuing.');
    const request = {chain: null, account: actor.account, address: target, abi: artifact(artifactName).abi, functionName, args};
    await pub.simulateContract(request);
    return receipt(await actor.wallet.writeContract(request), `${who}:${functionName}`);
  }
  async function deploy(name, args) {
    await assertLocal();
    const a = artifact(name);
    return (await receipt(await actors.curator.wallet.deployContract({chain: null, abi: a.abi, bytecode: a.bytecode.object, args}), `deploy:${name}`)).contractAddress;
  }
  async function hashOf(target) {
    const code = await pub.getCode({address: target});
    assert(code && code !== '0x', 'Fixture contract is missing.');
    return viem.keccak256(code);
  }
  async function verify(state) {
    validateManifest(state);
    assert.equal(state.rpc, rpc, 'Manifest belongs to another local RPC.');
    await assertLocal();
    for (const [name, target] of Object.entries(state.addresses)) {
      assert.equal(await hashOf(target), state.runtimeCodeHashes[name], `Local ${name} identity changed.`);
    }
  }
  async function warp(timestamp) {
    await assertLocal();
    if (timestamp <= (await pub.getBlock()).timestamp) return;
    await pub.request({method: 'evm_setNextBlockTimestamp', params: [Number(timestamp)]});
    await pub.request({method: 'evm_mine'});
  }
  function save(state, output) {
    state.transactions.push(...transactions.splice(0));
    writeReport(path.join(output, 'manifest.json'), state);
  }
  return {pub, actors, address, read, accountState, vaultState, assertLocal, write, deploy, hashOf, verify, warp, save, transactions};
}

export function webEnvironment(source, state, deployment, catalog, {indexerUrl} = {}) {
  assert(source.NODE_ENV !== 'production' && !source.VERCEL && !source.RAILWAY_ENVIRONMENT_ID,
    'The local fixture web launcher is development-only.');
  validateManifest(state);
  const localIndexer = indexerUrl === undefined ? undefined : localRpc(indexerUrl);
  assert(deployment.chainId === 31337 && deployment.localFork === true, 'Invalid local deployment.');
  for (const name of ['DealVault', 'CollateralRegistry', 'USDG', 'EntryRouter', 'FeeSink', 'HybridVault', 'HybridFees', 'EarnCore']) {
    assert(sameAddress(deployment[name], state.addresses[name]), `Local deployment ${name} differs from its manifest.`);
  }
  assert(sameAddress(deployment.HybridReserve, state.addresses.Reserve), 'Local deployment HybridReserve differs from its manifest.');
  const localVaults = [state.addresses.HybridVault, state.addresses.SecondVault].filter(Boolean);
  assert(Array.isArray(catalog) && catalog.length > 0 && catalog.every(item => item.chainId === 31337
    && item.localFixture === true && localVaults.some(vault => sameAddress(item.address, vault))), 'Invalid local hybrid catalog.');
  for (const item of catalog) {
    assert(item.startBlock === state.earnStartBlock, 'Local strategy deployment block differs from its manifest.');
    assert(item.grace === state.grace, 'Local strategy core grace differs from its manifest.');
    for (const [field, name] of [['core', 'EarnCore'], ['coreRewards', 'EarnCoreRewards'], ['registry', 'EarnCoreRegistry'], ['usdg', 'USDG'],
      ['reserve', 'Reserve'], ['fees', 'HybridFees'], ['collateral', 'CollateralToken']]) {
      assert(sameAddress(item.expected?.[field], state.addresses[name]), `Local hybrid ${field} differs from its manifest.`);
    }
    assert(sameAddress(item.expected?.allocator, state.accounts.curator.address), 'Local hybrid allocator differs from its manifest.');
  }
  const pass = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM',
    'NO_COLOR', 'FORCE_COLOR', 'PNPM_HOME', 'COREPACK_HOME', 'XDG_CACHE_HOME', 'SystemRoot'];
  const env = Object.fromEntries(pass.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
  return {...env, NODE_ENV: 'development', GAGE_NEXT_DIST_DIR: '.next-hybrid-local',
    ...(localIndexer ? {NEXT_PUBLIC_INDEXER_URL: localIndexer} : {}),
    NEXT_PUBLIC_HYBRID_LOCAL: '1', NEXT_PUBLIC_CHAIN_ID: '31337', NEXT_PUBLIC_RPC_URL: state.rpc,
    NEXT_PUBLIC_HYBRID_LOCAL_ACCOUNT: state.accounts.alice.address,
    NEXT_PUBLIC_HYBRID_LOCAL_CURATOR: state.accounts.curator.address,
    NEXT_PUBLIC_HYBRID_LOCAL_DEPLOYMENT_JSON: JSON.stringify(deployment),
    NEXT_PUBLIC_HYBRID_LOCAL_STRATEGIES_JSON: JSON.stringify(catalog)};
}
