#!/usr/bin/env node
// B4 acceptance: local chain events -> real Ponder -> the production notifier -> in-process channels only.
import assert from 'node:assert/strict';
import { earnRehearsalCore } from '../../../scripts/lib/earn-rehearsal-core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { runEarnIndexerRehearsal } from '../../indexer/scripts/earn-rehearsal.mjs';
import { U, E, viem, writeReport } from '../../../scripts/hybrid/runtime.mjs';
import { runEarn, earnHealth } from '../../keeper/dist/jobs/earn.js';
import { fetchEarnInput } from '../../keeper/dist/earn-indexer.js';
import { earnReadAbi } from '../../keeper/dist/earn-abi.js';
import { loadConfig as keeperConfig } from '../../keeper/dist/config.js';
import { parseDeployment } from '../../keeper/dist/deployment.js';
import { createLogger as keeperLogger } from '../../keeper/dist/log.js';
import { makeSender } from '../../keeper/dist/sender.js';
import { TransactionJournal } from '../../keeper/dist/transaction-journal.js';
import { emptyState } from '../../keeper/dist/state.js';
import { openDb } from '../dist/db.js';
import { makeIndexer } from '../dist/indexer.js';
import { Poller } from '../dist/poller.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/log.js';
import { DEFAULT_PREFS } from '../dist/prefs.js';
import { violations } from '../dist/messages.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requiredKinds = ['earn_listing', 'earn_approval_expiring', 'earn_claimable', 'earn_keeper_revert',
  'earn_harvest_failed', 'earn_reserve_redemption_failed', 'earn_repayment', 'earn_collateral', 'earn_overdue', 'earn_served'];
const modulePaths = ['../dist/earn.js', '../dist/indexer.js', '../dist/poller.js', '../dist/db.js',
  '../../keeper/dist/jobs/earn.js', '../../keeper/dist/sender.js'];
const moduleHashes = () => Object.fromEntries(modulePaths.map(file => [file,
  createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')]));

export async function rehearseEarnNotifier({ output, rpc = 'http://127.0.0.1:18575', port = 42109 } = {}) {
  const loadedModuleHashes = moduleHashes();
  // B4 always starts after this B2 acceptance run has succeeded, on its own isolated local chain.
  const fixture = await runEarnIndexerRehearsal({ output, rpc, port, keep: true });
  const { runtime, state, base, chain, indexer } = fixture;
  output = fixture.output;
  const { pub, read, write, address, warp, save } = runtime, a = state.addresses;
  const core = earnRehearsalCore(runtime, a);
  const proof = { task: 'B4', localOnly: true, chainId: 31337, strategy: a.HybridVault, runtimeCodeHashes: { ...state.runtimeCodeHashes }, moduleHashes: loadedModuleHashes,
    startedAt: new Date().toISOString(), scenarios: [], messages: [], deliveries: [], keeperActions: [],
    polls: [], restarts: 0, acceptancePassed: false, completedAt: null };
  const deployment = parseDeployment(JSON.parse(fs.readFileSync(path.join(output, 'indexer-deployment.json'), 'utf8')));
  const { config } = keeperConfig({ CHAIN_ID: '31337', RPC_URL: rpc, INDEXER_URL: base, EARN_ENABLED: 'true',
    EARN_REWARD_MIN_RAW: '1', EARN_RETRY_BASE_SECONDS: '1', EARN_ALERT_ATTEMPTS: '2', EARN_MAX_AGE_SECONDS: '120' });
  const actor = runtime.actors.keeper;
  // Match production's ESM viem error classes so makeSender can identify contract reverts.
  const publicClient = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 5000 }), pollingInterval: 100 });
  const log = keeperLogger({ service: 'notifier-rehearsal-keeper' }, { level: 'info',
    write: line => fs.appendFileSync(path.join(output, 'notifier-keeper.log'), line + '\n') });
  const journal = new TransactionJournal(path.join(output, 'notifier-keeper-pending.json'));
  const sender = makeSender({ publicClient, walletClient: actor.wallet, account: actor.account,
    dryRun: false, minGasWei: config.minGasWei, log, journal, maxTransactionCostWei: E });
  const ctx = { config: { ...config, dryRun: false, hasKey: true }, publicClient, signerAddress: actor.account.address,
    deployment: () => deployment, log, state: emptyState(), views: {}, now: () => Date.now(), usdgDecimals: () => Promise.resolve(6),
    sender: { ...sender, execute: async call => {
      const outcome = await sender.execute(call);
      proof.keeperActions.push({ action: call.functionName, status: outcome.status,
        ...(outcome.status === 'sent' ? { hash: outcome.hash } : {}), ...(outcome.status === 'reverted' ? { error: outcome.revert.name } : {}) });
      return outcome;
    } },
  };
  const healthServer = createServer((request, response) => {
    if (request.url !== '/health/earn') { response.writeHead(404).end(); return; }
    const health = earnHealth(ctx);
    response.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(health));
  });
  await new Promise(resolve => healthServer.listen(port + 1, '127.0.0.1', resolve));

  let clock = Number((await pub.getBlock()).timestamp), failApproval = false, failedApprovalKey;
  const notifyLog = createLogger({}, { write: line => fs.appendFileSync(path.join(output, 'notifier.log'), line + '\n') });
  const notifyConfig = loadConfig({ CHAIN_ID: '31337', INDEXER_URL: base, DB_PATH: path.join(output, 'notifier.db'),
    EARN_MAX_SNAPSHOT_AGE_SEC: '300', APP_URL: 'http://127.0.0.1:3000', NOTIFY_TIMEZONE: 'UTC' }).config;
  const notifyIndexer = makeIndexer({ baseUrl: base });
  // These adapters never invoke provider APIs. No environment credentials are read by loadConfig above.
  const channels = Object.fromEntries(['email', 'telegram', 'push'].map(name => [name, {
    name, dry: true, validateAddress: () => undefined,
    send: (destination, message) => {
      if (failApproval && message.subject.includes('Approval #')) {
        failApproval = false;
        return Promise.reject(Error('injected local transport outage'));
      }
      assert.deepEqual(violations(message.subject + ' ' + message.text), []);
      proof.messages.push({ channel: name, destination, ...message });
      return Promise.resolve({});
    },
  }]));
  let rawDb, db, poller;
  function open() {
    rawDb = openDb(notifyConfig.dbPath);
    db = { ...rawDb, record: row => {
      if (row.status === 'dry' || row.status === 'sent') proof.deliveries.push({ id: row.key, kind: row.kind, wallet: row.wallet, channel: row.channel });
      if (row.status === 'failed' && row.kind === 'earn_approval_expiring') failedApprovalKey = row.key;
      rawDb.record(row);
    } };
    poller = new Poller({ db, indexer: notifyIndexer, channels, config: notifyConfig, log: notifyLog, now: () => clock });
  }
  function restart() { rawDb.close(); open(); proof.restarts++; }
  open();
  for (const who of ['curator', 'alice', 'bob']) db.upsertSubscription({ wallet: address(who), channel: 'email',
    address: `${who}@example.invalid`, prefs: { ...DEFAULT_PREFS }, createdAt: clock });
  db.upsertSubscription({ wallet: a.HybridVault, channel: 'email', address: 'strategy@example.invalid', prefs: { ...DEFAULT_PREFS }, createdAt: clock });

  async function indexed() {
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    for (let i = 0; i < 180; i++) {
      try {
        const input = await fetchEarnInput(base, a.HybridVault.toLowerCase(), 31337);
        if (BigInt(input.strategy.blockNumber) >= head) { clock = Number((await pub.getBlock()).timestamp); return input; }
      } catch { /* Wait for Ponder's next atomic snapshot. */ }
      assert(indexer.exitCode === null, 'Ponder stopped');
      await pub.request({ method: 'evm_mine' }); await sleep(1000);
    }
    throw Error('B4 indexer did not catch up');
  }
  async function poll(label) {
    await indexed();
    for (let i = 0; i < 10; i++) {
      const result = await poller.pollOnce();
      proof.polls.push({ label, ...result });
      if (result.indexerOk) return result;
      await sleep(200);
    }
    throw Error(`B4 notifier poll failed at ${label}: ${poller.status.lastError}`);
  }
  async function once(label) {
    await poll(label);
    assert.equal((await poll(label + ':second')).dry, 0, 'A second poll must not repeat a delivered notice');
    restart();
    assert.equal((await poll(label + ':restart')).dry, 0, 'Restart must retain delivered notice identities');
    proof.scenarios.push(label);
    console.log(`B4 verified: ${label}`);
  }
  async function tick() {
    const input = await indexed();
    const deps = { chainNow: () => clock, snapshot: () => Promise.resolve(input),
      read: (address, functionName, args = []) => pub.readContract({ address, abi: earnReadAbi, functionName, args, blockNumber: BigInt(input.strategy.blockNumber) }),
      readLatest: (address, functionName, args = []) => pub.readContract({ address, abi: earnReadAbi, functionName, args }),
    };
    await runEarn(ctx, deps);
    assert.equal(journal.read(), null, 'Keeper transaction journal must be resolved');
  }
  async function twiceForFailure(code) {
    for (let i = 0; i < 6 && !ctx.state.earn?.alerts.some(alert => alert.code === code); i++) {
      await tick(); await sleep(1200);
    }
    assert(ctx.state.earn.alerts.some(alert => alert.code === code), `The real keeper did not emit ${code}`);
    await once(code);
  }
  async function listing(who, token, ttl = 3500) {
    const now = (await pub.getBlock()).timestamp;
    const id = await core.list(who, { kind: 0, token, amountOrTokenId: 10n * E }, 600n * U, 630n * U, 604800, now + 604800n);
    const validUntil = Number((await pub.getBlock()).timestamp) + ttl;
    await write('curator', a.HybridVault, 'HybridVault', 'approveLoan', [id, validUntil, 4]);
    return { id, who, token, validUntil };
  }

  let success = false;
  try {
    await once('indexed repayment, collateral, overdue, served request and admitted listings');
    const priorDefault = state.candidates.find(candidate => candidate.eligible && candidate.lane === 'MEME');
    assert(proof.messages.some(message => message.text.includes(`Loan #${priorDefault.id} reached claimable time`)),
      'The first notifier poll must report claimable time even after keeper settlement');
    assert(proof.messages.filter(message => message.subject.includes('Collateral received')).every(message => message.text.includes('recovered into a side pocket for the holders of record')),
      'Backfilled side pocket notices must remain true after holders claim their part');
    for (const [who, amount] of [['alice', 3000n * U], ['bob', 2000n * U]]) {
      await write(who, a.USDG, 'MockERC20', 'approve', [a.HybridVault, viem.maxUint256]);
      await write(who, a.HybridVault, 'HybridVault', 'deposit', [amount, 1n]);
    }
    const repay = await listing('borrowerA', a.CollateralToken, 580);
    failApproval = true;
    assert.equal((await poll('approval transport failure')).failed, 1);
    assert(failedApprovalKey && db.getKv(`message:${failedApprovalKey}`), 'Approval retry must be in SQLite');
    await warp(BigInt(repay.validUntil) + 1n); restart();
    const retried = await poll('expired approval retry after restart');
    assert.equal(retried.retried, 1); assert.equal(db.getSent(failedApprovalKey).status, 'dry');
    assert.equal(db.getKv(`message:${failedApprovalKey}`), undefined);
    await once('approval notice retained through expiry and restart');
    await write('curator', a.HybridVault, 'HybridVault', 'approveLoan', [repay.id, Number((await pub.getBlock()).timestamp) + 3500, 4]);
    const collateral = await listing('borrowerB', a.MemeToken);
    await tick(); await indexed();
    assert.equal(await read(a.HybridVault, 'HybridVault', 'funded', [repay.id]), true);
    assert.equal(await read(a.HybridVault, 'HybridVault', 'funded', [collateral.id]), true);
    await core.repay(repay.who, repay.id);
    await write('curator', a.USDG, 'MockERC20', 'setPaused', [true]);
    await twiceForFailure('harvest_failed');
    assert(await core.cashCredit() > 0n, 'Paused USDG must retain core cash');
    await write('curator', a.USDG, 'MockERC20', 'setPaused', [false]);
    await tick(); await tick();
    assert.equal(await read(a.HybridVault, 'HybridVault', 'terminal', [repay.id]), true, 'Repayment must settle after USDG recovery');
    await once('new repayment delivered once');
    await warp(await core.claimableAt(collateral.id) + 1n);
    await once('claimable loan alerts its curator once');
    await tick(); await tick();
    assert.equal(await read(a.HybridVault, 'HybridVault', 'terminal', [collateral.id]), true, 'Claimable collateral must settle');
    await once('new collateral delivered once');
    await write('curator', a.HybridReserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, 0n, 0n]);
    await write('bob', a.HybridVault, 'HybridVault', 'requestRedeem', [await read(a.HybridVault, 'HybridVault', 'balanceOf', [address('bob')])]);
    await twiceForFailure('reserve_redemption_failed');
    assert(proof.keeperActions.some(action => action.action === 'serveRequests' && action.status === 'reverted'), 'Illiquid reserve must cause an actual redemption revert');
    await write('curator', a.HybridReserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, viem.maxUint256, viem.maxUint256]);
    await sleep(2200); await tick(); await once('served request delivered once after reserve recovery');
    assert.equal(await read(a.HybridVault, 'HybridVault', 'balanceOf', [address('bob')]), 0n, 'The request must be served after reserve recovery');
    const external = await listing('borrowerA', a.CollateralToken);
    await write('curator', a.USDG, 'MockERC20', 'approve', [a.EarnCore, viem.maxUint256]);
    await core.fund('curator', external.id, 4);
    await twiceForFailure('keeper_revert');
    assert(proof.keeperActions.some(action => action.action === 'fund' && action.status === 'reverted' && action.error === 'IneligibleDeal'), 'Externally funded loan must cause IneligibleDeal');
    await write('curator', a.HybridVault, 'HybridVault', 'revokeLoan', [external.id]);
    await tick();
    assert.equal(earnHealth(ctx).ok, true, 'Revoking obsolete work must restore healthy keeper status');
    await once('final repeated poll and restart');
    const counts = Object.fromEntries(requiredKinds.map(kind => [kind, proof.deliveries.filter(item => item.kind === kind).length]));
    for (const kind of requiredKinds) assert(counts[kind] > 0, `Missing real-chain alert kind ${kind}`);
    assert.equal(new Set(proof.deliveries.map(item => item.id)).size, proof.deliveries.length, 'Every real-chain notice must be delivered at most once');
    assert(proof.deliveries.every(item => item.wallet.toLowerCase() !== a.HybridVault.toLowerCase()), 'No alert may address the strategy contract');
    assert(proof.messages.every(item => !item.text.includes('yours to claim')));
    assert.deepEqual(moduleHashes(), loadedModuleHashes, 'Rehearsal modules changed during execution');
    proof.counts = counts; proof.finalKeeperHealth = earnHealth(ctx); proof.keeperAlerts = earnHealth(ctx).alerts; proof.keeperStats = sender.stats;
    proof.acceptancePassed = true; proof.completedAt = new Date().toISOString();
    save(state, output); proof.transactions = state.transactions;
    writeReport(path.join(output, 'notifier-evidence.json'), proof);
    success = true;
    console.log(`B4 all nine real-chain alert kinds passed. Evidence: ${path.join(output, 'notifier-evidence.json')}`);
    return { proof, output };
  } finally {
    rawDb.close(); healthServer.close(); indexer.kill('SIGTERM'); chain.kill('SIGTERM');
    if (!success) writeReport(path.join(output, 'notifier-failed-evidence.json'), proof);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, rpc: { type: 'string' }, port: { type: 'string' } } });
  rehearseEarnNotifier({ output: values.output, rpc: values.rpc, port: values.port ? Number(values.port) : undefined })
    .catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
