#!/usr/bin/env node
// Real B3 acceptance uses the existing isolated public fixture accounts, never a supplied signing credential.
import assert from 'node:assert/strict';
import { earnRehearsalCore } from '../../../scripts/lib/earn-rehearsal-core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runEarnIndexerRehearsal } from '../../indexer/scripts/earn-rehearsal.mjs';
import { viem, U, E, writeReport, stringify } from '../../../scripts/hybrid/runtime.mjs';
import { runEarn, earnHealth } from '../dist/jobs/earn.js';
import { fetchEarnInput } from '../dist/earn-indexer.js';
import { earnReadAbi } from '../dist/earn-abi.js';
import { loadConfig } from '../dist/config.js';
import { parseDeployment } from '../dist/deployment.js';
import { createLogger } from '../dist/log.js';
import { makeSender } from '../dist/sender.js';
import { TransactionJournal } from '../dist/transaction-journal.js';
import { emptyState, saveState } from '../dist/state.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const keeperRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function sourceHash() {
  const hash = createHash('sha256');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else hash.update(path.relative(keeperRoot, file)).update('\0').update(fs.readFileSync(file));
    }
  }
  walk(path.join(keeperRoot, 'src'));
  return hash.digest('hex');
}


export async function rehearseEarnKeeper({ output, durationSeconds = 3600, rpc = 'http://127.0.0.1:18573', port = 42089, onTick } = {}) {
  assert(Number.isSafeInteger(durationSeconds) && durationSeconds >= 1);
  const fixture = await runEarnIndexerRehearsal({ output, rpc, port, keep: true });
  const { runtime, state: fixtureState, base, chain, indexer } = fixture;
  output = fixture.output;
  const { pub, read, write, address, warp, save } = runtime, a = fixtureState.addresses;
  const core = earnRehearsalCore(runtime, a);
  const deployment = parseDeployment(JSON.parse(fs.readFileSync(path.join(output, 'indexer-deployment.json'), 'utf8')));
  const { config } = loadConfig({ CHAIN_ID: '31337', RPC_URL: rpc, INDEXER_URL: base, EARN_ENABLED: 'true', EARN_REWARD_MIN_RAW: '1', EARN_RETRY_BASE_SECONDS: '1', EARN_ALERT_ATTEMPTS: '2', EARN_MAX_AGE_SECONDS: '120' });
  // This account is the public fixture signer already constructed in memory by runtime.mjs.
  const actor = runtime.actors.keeper;
  const journal = new TransactionJournal(path.join(output, 'keeper-pending.json'));
  const log = createLogger({ service: 'earn-rehearsal' }, { level: 'info', write: line => fs.appendFileSync(path.join(output, 'keeper.log'), line + '\n') });
  const executeSender = makeSender({ publicClient: pub, walletClient: actor.wallet, account: actor.account, dryRun: false, minGasWei: config.minGasWei, log, journal, maxTransactionCostWei: 10n ** 18n });
  const drySender = makeSender({ publicClient: pub, walletClient: undefined, account: undefined, dryRun: true, minGasWei: config.minGasWei, log });
  let now = Number((await pub.getBlock()).timestamp);
  const ctx = { config: { ...config, dryRun: false, hasKey: true }, publicClient: pub, signerAddress: actor.account.address,
    deployment: () => deployment, log, sender: executeSender, state: emptyState(), views: {}, now: () => Date.now(), usdgDecimals: () => Promise.resolve(6) };
  const proof = { task: 'B3', localOnly: true, chainId: 31337, strategy: a.HybridVault, startedAt: new Date().toISOString(), requestedSeconds: durationSeconds,
    runtimeCodeHashes: fixtureState.runtimeCodeHashes, serviceSourceSha256: sourceHash(), rehearsalSourceSha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'), elapsedSeconds: 0, ticks: 0, actionComparisons: 0, actions: [], scenarios: [], completedAt: null, acceptancePassed: false };
  const healthServer = createServer((req, res) => {
    if (req.url !== '/health/earn') { res.writeHead(404).end(); return; }
    const health = earnHealth(ctx); res.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(health));
  });
  await new Promise(resolve => healthServer.listen(port + 1, '127.0.0.1', resolve));
  const loans = [];
  let success = false;
  async function indexed() {
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    for (let i = 0; i < 180; i++) {
      try { const input = await fetchEarnInput(base, a.HybridVault.toLowerCase(), 31337); if (BigInt(input.strategy.blockNumber) >= head) return input; }
      catch { /* Ponder is publishing the next complete block. */ }
      await pub.request({ method: 'evm_mine' }); await sleep(1000);
    }
    throw Error('Earn indexer failed to catch the local chain');
  }
  const publicCall = call => JSON.parse(stringify({ label: call.label, address: call.address.toLowerCase(), functionName: call.functionName, args: call.args ?? [] }));
  async function tick() {
    const input = await indexed(); now = Number((await pub.getBlock()).timestamp);
    const deps = { chainNow: () => now, snapshot: () => Promise.resolve(input),
      read: (address, functionName, args = []) => pub.readContract({ address, abi: earnReadAbi, functionName, args, blockNumber: BigInt(input.strategy.blockNumber) }),
      readLatest: (address, functionName, args = []) => pub.readContract({ address, abi: earnReadAbi, functionName, args }) };
    const dryCalls = [], liveCalls = [];
    const nonceBefore = await pub.getTransactionCount({ address: actor.account.address });
    const dryCtx = { ...ctx, config: { ...config, dryRun: true, hasKey: false }, state: structuredClone(ctx.state), sender: { ...drySender, execute: async call => {
      dryCalls.push(publicCall(call)); const outcome = await drySender.execute(call);
      assert(['dry', 'skipped'].includes(outcome.status), `Dry-run must successfully simulate ${call.label}: ${outcome.status}`);
      return outcome;
    } } };
    await runEarn(dryCtx, deps);
    assert.equal(await pub.getTransactionCount({ address: actor.account.address }), nonceBefore, 'Dry-run must not sign or broadcast');
    ctx.sender = { ...executeSender, execute: async call => {
      liveCalls.push(publicCall(call)); const outcome = await executeSender.execute(call);
      proof.actions.push({ tick: proof.ticks, ...publicCall(call), status: outcome.status, ...(outcome.status === 'sent' ? { hash: outcome.hash, gasUsed: String(outcome.gasUsed) } : {}) });
      assert(!['failed', 'refused', 'reverted'].includes(outcome.status), `Unexpected execute outcome: ${outcome.status} for ${call.label}`);
      return outcome;
    } };
    await runEarn(ctx, deps);
    assert.deepEqual(liveCalls, dryCalls, 'Execute and dry-run must report the same ordered actions at one fixed block');
    assert.equal(journal.read(), null, 'No unresolved transaction may be followed by another');
    proof.actionComparisons += liveCalls.length;
    proof.ticks++;
    saveState(path.join(output, 'keeper-state.json'), ctx.state);
    if (onTick) await onTick({ fixture, ctx, input, proof });
    return input;
  }
  try {
    for (const [who, amount] of [['alice', 3000n * U], ['bob', 2000n * U]]) {
      await write(who, a.USDG, 'MockERC20', 'approve', [a.HybridVault, viem.maxUint256]);
      await write(who, a.HybridVault, 'HybridVault', 'deposit', [amount, 1n]);
    }
    for (const [who, token] of [['borrowerA', a.CollateralToken], ['borrowerB', a.MemeToken]]) {
      const timestamp = (await pub.getBlock()).timestamp;
      const id = await core.list(who, { kind: 0, token, amountOrTokenId: 10n * E }, 600n * U, 630n * U, 604800, timestamp + 604800n);
      await write('curator', a.HybridVault, 'HybridVault', 'approveLoan', [id, Number((await pub.getBlock()).timestamp + 580n), 4]);
      loans.push({ id, who, token });
    }
    const wallStart = Date.now();
    let phase = 0;
    while (Date.now() - wallStart < durationSeconds * 1000 || phase < 5) {
      assert(Date.now() - wallStart < (durationSeconds + 300) * 1000, "Keeper lifecycle did not complete within its rehearsal deadline");
      await tick();
      const current = await indexed();
      if (phase === 0 && loans.every(l => current.loans.some(x => x.dealId === String(l.id)))) {
        proof.scenarios.push('all valid approvals funded unattended');
        await core.repay(loans[0].who, loans[0].id);
        const claimableAt = await core.claimableAt(loans[1].id);
        await warp(BigInt(claimableAt) + 1n); phase = 1;
      } else if (phase === 1 && loans.every(l => current.loans.filter(x => x.dealId === String(l.id)).every(x => x.settled))) {
        proof.scenarios.push('repayment and in-kind default settled unattended'); phase = 2;
      } else if (phase === 2 && current.strategy.totals.cash === '0' && BigInt(current.strategy.totals.accRewardPerShare) > 0n) {
        proof.scenarios.push('repaid cash invested into the reserve and released rewards spread over every share');
        await write('alice', a.HybridVault, 'HybridVault', 'requestRedeem', [await read(a.HybridVault, 'HybridVault', 'balanceOf', [address('alice')])]); phase = 3;
      } else if (phase === 3 && current.strategy.totals.openRequests === 0 && current.strategy.totals.pendingShares === '0' && await read(a.HybridVault, 'HybridVault', 'claimable', [address('alice')]) > 0n) {
        proof.scenarios.push('redemption request served unattended within the reserve withdrawal bound');
        await write('alice', a.HybridVault, 'HybridVault', 'claim');
        if (await read(a.HybridVault, 'HybridVault', 'feeAccrued') > 0n) await write('curator', a.HybridVault, 'HybridVault', 'claimFees');
        phase = 4;
      } else if (phase === 4) { proof.scenarios.push('claim and fee claim confirmed'); phase = 5; }
      proof.elapsedSeconds = Math.floor((Date.now() - wallStart) / 1000);
      if (proof.ticks % 12 === 0) { writeReport(path.join(output, 'keeper-progress.json'), proof); console.log(`Earn keeper rehearsal: ${proof.elapsedSeconds}s, ${proof.ticks} ticks, ${proof.actionComparisons} matching actions, phase ${phase}.`); }
      if (Date.now() - wallStart >= durationSeconds * 1000 && phase >= 5) break;
      // Fresh idle blocks exercise ongoing indexer/reserve snapshots throughout the full wall-clock hour.
      await pub.request({ method: 'anvil_mine', params: ['0xa'] });
      await sleep(5000);
    }
    assert(earnHealth(ctx).ok, 'Keeper must finish healthy');
    assert.equal(sourceHash(), proof.serviceSourceSha256, 'Keeper source must remain unchanged throughout the acceptance hour');
    assert.equal(drySender.stats.sent, 0);
    assert.equal(drySender.stats.reverted + drySender.stats.failed + drySender.stats.refused, 0);
    assert.equal(drySender.stats.simulated, executeSender.stats.simulated);
    assert(executeSender.stats.sent > 0);
    proof.elapsedSeconds = Math.floor((Date.now() - wallStart) / 1000);
    proof.completedAt = new Date().toISOString();
    proof.acceptancePassed = proof.elapsedSeconds >= 3600 && phase === 5;
    proof.finalHealth = earnHealth(ctx);
    proof.senderStats = executeSender.stats;
    proof.dryRunStats = drySender.stats;
    save(fixtureState, output); writeReport(path.join(output, 'keeper-evidence.json'), proof);
    success = true;
    console.log(`Earn keeper rehearsal complete; one-hour acceptance=${proof.acceptancePassed}. Evidence: ${path.join(output, 'keeper-evidence.json')}`);
    return { proof, output };
  } finally {
    healthServer.close(); indexer.kill('SIGTERM'); chain.kill('SIGTERM');
    if (!success) writeReport(path.join(output, 'keeper-failed-evidence.json'), proof);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'duration-seconds': { type: 'string' }, rpc: { type: 'string' }, port: { type: 'string' } } });
  rehearseEarnKeeper({ output: values.output, durationSeconds: values['duration-seconds'] ? Number(values['duration-seconds']) : 3600, rpc: values.rpc, port: values.port ? Number(values.port) : undefined })
    .catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
