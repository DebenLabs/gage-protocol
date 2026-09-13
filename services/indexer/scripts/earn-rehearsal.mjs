#!/usr/bin/env node
// B2 acceptance: real local contracts -> Ponder -> every documented Earn HTTP endpoint (D82 pooled shares).
// Test credentials are supplied only by the existing isolated public-fixture runtime.
import assert from 'node:assert/strict';
import { earnRehearsalCore } from '../../../scripts/lib/earn-rehearsal-core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLocal } from '../../../scripts/hybrid/local-chain.mjs';
import { viem, writeReport, U } from '../../../scripts/hybrid/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runEarnIndexerRehearsal({ output, rpc = 'http://127.0.0.1:18571', port = 42079, keep = false } = {}) {
  output = path.resolve(output ?? path.join(root, '.rehearsal', `earn-services-${Date.now()}`));
  const { child: chain, runtime, state } = await startLocal({ rpc, output });
  const { pub, read, write, address, warp, save } = runtime;
  const a = state.addresses;
  const core = earnRehearsalCore(runtime, a);
  const base = `http://127.0.0.1:${port}`;
  const prefix = `/earn/${a.HybridVault.toLowerCase()}`;
  const deploymentPath = path.join(output, 'indexer-deployment.json');
  const deployment = JSON.parse(fs.readFileSync(path.join(output, 'services-deployment.json'), 'utf8'));
  // MockLPRewards deliberately has no production immutable interface; it is unrelated to Earn indexing.
  delete deployment.LPRewards;
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  const logPath = path.join(output, 'indexer.log');
  const logFd = fs.openSync(logPath, 'a');
  const indexer = spawn(process.execPath, [path.join(root, 'services/indexer/node_modules/ponder/dist/esm/bin/ponder.js'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'services/indexer'), stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port), CHAIN_ID: '31337', RPC_URL: rpc, RPC_WS_URL: '', DEPLOYMENT_FILE: deploymentPath,
      START_BLOCK: '1', TOKEN_START_BLOCK: '1', PGLITE_DIRECTORY: path.join(output, 'pglite'), DATABASE_URL: '',
      EARN_SNAPSHOT_INTERVAL: '10', EARN_KEEPER_URL: `http://127.0.0.1:${port + 1}` },
  });
  fs.closeSync(logFd);
  const proof = { task: 'B2', chainId: 31337, localOnly: true, startedAt: new Date().toISOString(), strategy: a.HybridVault,
    runtimeCodeHashes: state.runtimeCodeHashes, indexerPort: port, scenarios: [], endpointResponses: {}, transactions: [], completedAt: null };
  let success = false;

  async function get(route) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok) throw Object.assign(Error(`${route}: HTTP ${response.status}: ${JSON.stringify(body)}`), { status: response.status });
    return body;
  }
  async function eventually(label, check, attempts = 600) {
    let last;
    for (let i = 0; i < attempts; i++) {
      if (indexer.exitCode !== null) throw Error(`Ponder exited with ${indexer.exitCode}; inspect ${logPath}`);
      try { const value = await check(); if (value) return value; } catch (error) { last = error; }
      if (i > 0 && i % 30 === 0) console.log(`B2 waiting for ${label}: ${i}s of backfill.`);
      // Mine a quiet head so block snapshots and Ponder finality both advance on an otherwise idle fixture.
      await pub.request({ method: 'evm_mine' });
      await pause(1000);
    }
    throw Error(`${label} did not become true: ${last?.message ?? 'condition false'}; inspect ${logPath}`);
  }
  async function all(route, limit = 1) {
    for (let attempt = 0; attempt < 20; attempt++) {
      let cursor = null, blockNumber, items = [], seen = new Set();
      try {
        do {
          const url = new URL(base + route);
          url.searchParams.set('limit', String(limit));
          if (cursor) url.searchParams.set('cursor', cursor);
          if (blockNumber) url.searchParams.set('blockNumber', blockNumber);
          const page = await get(url.pathname + url.search);
          assert.equal(page.chainId, 31337);
          assert.equal(page.strategy.toLowerCase(), a.HybridVault.toLowerCase());
          assert(Array.isArray(page.items));
          if (blockNumber) assert.equal(page.blockNumber, blockNumber);
          blockNumber = page.blockNumber;
          items.push(...page.items);
          cursor = page.nextCursor;
          assert(cursor === null || typeof cursor === 'string');
          if (cursor) { assert(!seen.has(cursor), 'Pagination must advance'); seen.add(cursor); }
        } while (cursor);
        return items;
      } catch (error) { if (error.status !== 409) throw error; await pause(100); }
    }
    throw Error(`Unable to finish a stable snapshot for ${route}`);
  }
  async function synced() {
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    return eventually('Earn indexed head', async () => {
      const current = await get(prefix);
      return BigInt(current.blockNumber) >= head && current;
    });
  }
  async function record(label, check) {
    await synced();
    await check();
    proof.scenarios.push(label);
    console.log(`B2 verified: ${label}`);
  }
  try {
    await eventually('Earn strategy registration', async () => (await get('/earn/strategies')).items.length === 1);
    await record('deployment, lanes, token ceilings, fee and two deposits', async () => {
      const s = await get(prefix);
      assert.equal(s.feeBps, 1000);
      assert.equal(s.lanes.find(l => l.lane === 'STOCK').weightBps, 6000);
      assert.equal(s.lanes.find(l => l.lane === 'MEME').weightBps, 4000);
      assert.equal(s.tokens.filter(t => BigInt(t.ceiling) > 0n).length, 2);
      const accounts = await all(prefix + '/accounts');
      assert.equal(accounts.length, 2);
      assert.equal(accounts.reduce((sum, item) => sum + BigInt(item.value), 0n), BigInt(s.totals.totalAssets));
      assert.equal(BigInt(s.totals.fullAssets), 3000n * U);
      assert.equal((await all(prefix + '/requests')).length, 0);
      assert.equal((await all(prefix + '/approvals')).filter(x => !x.revoked && !x.funded).length, 2);
    });
    const eligible = state.candidates.filter(c => c.eligible);
    const first = eligible[0], second = eligible[1];
    assert(first && second);
    await write('curator', a.HybridVault, 'HybridVault', 'revokeLoan', [BigInt(first.id)]);
    await record('revoked approval', async () => assert((await all(prefix + '/approvals')).find(x => x.dealId === first.id).revoked));
    await write('curator', a.HybridVault, 'HybridVault', 'setPaused', [true]);
    await record('paused strategy', async () => assert.equal((await get(prefix)).paused, true));
    await write('curator', a.HybridVault, 'HybridVault', 'setPaused', [false]);
    for (const loan of eligible) {
      await write('curator', a.HybridVault, 'HybridVault', 'approveLoan', [BigInt(loan.id), Number((await pub.getBlock()).timestamp + 3500n), 4]);
      const preview = await read(a.HybridReserve, 'HybridReserveMock', 'previewWithdraw', [BigInt(loan.principal)]);
      await write('keeper', a.HybridVault, 'HybridVault', 'fund', [BigInt(loan.id), preview * 101n / 100n + 32n]);
    }
    await record('two lanes funded, one row per loan carried at principal', async () => {
      const loans = await all(prefix + '/loans');
      assert.equal(loans.length, 2);
      assert(loans.every(x => x.state === 'Active' && x.carried === x.positionPrincipal && !x.overdue));
      assert.equal((await get(prefix)).totals.performingPrincipal, String(1200n * U));
      assert.equal((await get(prefix)).tokens.reduce((n, t) => n + BigInt(t.principal), 0n), 1200n * U);
    });
    await core.repay(first.actor, first.id);
    await record('repaid core loan is settling', async () => assert((await all(prefix + '/loans')).filter(x => x.dealId === first.id).every(x => x.state === 'Settling')));
    await write('keeper', a.HybridVault, 'HybridVault', 'settle', [[BigInt(first.id)]]);
    await record('settled repayment, exact performance fee and booked profit unlocking into the price', async () => {
      const s = await get(prefix), row = (await all(prefix + '/loans')).find(x => x.dealId === first.id);
      assert.equal(s.feeAccrued, String(3n * U));
      assert.equal(row.state, 'Repaid');
      assert.equal(BigInt(row.fee), 3n * U);
      assert.equal(BigInt(row.profit), 30n * U);
      assert.equal(BigInt(row.payout), BigInt(row.positionPrincipal) + 30n * U);
      assert(BigInt(s.totals.lockedProfit) > 0n && BigInt(s.shares.fullPrice) > BigInt(s.shares.price));
    });
    await warp(await core.expiry(second.id));
    await write('keeper', a.HybridVault, 'HybridVault', 'markOverdue', [[BigInt(second.id)]]);
    await record('overdue state written down from the share price', async () => {
      const row = (await all(prefix + '/loans')).find(x => x.dealId === second.id);
      assert.equal(row.state, 'Overdue'); assert.equal(row.overdue, true); assert.equal(row.carried, '0');
      assert.equal((await get(prefix)).totals.overduePrincipal, row.positionPrincipal);
      assert((await all(prefix + '/events')).some(x => x.kind === 'overdue' && x.dealId === second.id));
    });
    await warp(await core.claimableAt(second.id) + 1n);
    await record('claimable state', async () => assert((await all(prefix + '/loans')).filter(x => x.dealId === second.id).every(x => x.state === 'Claimable')));
    await write('keeper', a.HybridVault, 'HybridVault', 'settle', [[BigInt(second.id)]]);
    await write('keeper', a.HybridVault, 'HybridVault', 'harvestCash');
    await write('keeper', a.HybridVault, 'HybridVault', 'harvestRewards', [eligible.map(l => BigInt(l.id))]);
    await record('side pocket for the holders of record and rewards spread over every share', async () => {
      const row = (await all(prefix + '/loans')).find(x => x.dealId === second.id);
      assert(row.state === 'Collateral' && row.fee === '0' && row.pocketId !== null);
      const pockets = await all(prefix + '/pockets');
      assert.equal(pockets.length, 1);
      assert.equal(pockets[0].id, row.pocketId);
      assert.equal(pockets[0].token.toLowerCase(), second.token.toLowerCase());
      assert.equal(BigInt(pockets[0].amount), BigInt(second.collateralAmount));
      const accounts = await all(prefix + '/accounts');
      assert.equal(accounts.flatMap(x => x.pockets).reduce((sum, x) => sum + BigInt(x.claimable), 0n) <= BigInt(pockets[0].amount), true);
      assert(accounts.every(x => x.pockets.some(p => p.pocketId === row.pocketId)));
      assert(accounts.some(x => BigInt(x.rewards) > 0n));
      assert(BigInt((await get(prefix)).totals.accRewardPerShare) > 0n);
    });
    const idle = BigInt((await get(prefix)).totals.cash);
    if (idle > 0n) await write('keeper', a.HybridVault, 'HybridVault', 'investReserve', [idle, 1n]);
    await record('idle cash invested into the reserve', async () => {
      const s = await get(prefix);
      assert.equal(s.totals.cash, '0');
      assert.equal(BigInt(s.totals.freeLiquidity), BigInt(s.totals.reserveAssets));
    });
    const aliceShares = await read(a.HybridVault, 'HybridVault', 'balanceOf', [address('alice')]);
    await write('alice', a.HybridVault, 'HybridVault', 'requestRedeem', [aliceShares]);
    await record('redemption request queued with its place and locked shares', async () => {
      const owner = await get(prefix + '/accounts/' + address('alice'));
      assert.equal(owner.lockedShares, String(aliceShares)); assert.equal(owner.freeShares, '0');
      const requests = await all(prefix + '/requests?account=' + address('alice'));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].status, 'pending'); assert.equal(requests[0].position, 1);
      assert.equal((await get(prefix)).totals.openRequests, 1);
    });
    await write('keeper', a.HybridVault, 'HybridVault', 'serveRequests', [1n, viem.maxUint256]);
    await record('request served at the share price into claimable USDG', async () => {
      const owner = await get(prefix + '/accounts/' + address('alice'));
      assert.equal(owner.shares, '0'); assert(BigInt(owner.claimable) > 0n);
      const requests = await all(prefix + '/requests');
      assert(requests.every(x => x.status === 'served' && x.position === 0 && BigInt(x.servedAssets) > 0n));
      const notices = await all(prefix + '/events');
      for (const kind of ['repayment', 'collateral', 'overdue', 'served']) assert(notices.some(x => x.kind === kind), `Missing ${kind} notice`);
      assert(notices.filter(x => x.kind !== 'served').every(x => x.account.toLowerCase() === a.HybridVault.toLowerCase()));
      assert(notices.some(x => x.kind === 'served' && x.account.toLowerCase() === address('alice').toLowerCase()));
    });
    await write('alice', a.HybridVault, 'HybridVault', 'claim');
    await write('curator', a.HybridVault, 'HybridVault', 'claimFees');
    const pocketId = BigInt((await all(prefix + '/pockets'))[0].id);
    for (const who of ['alice', 'bob']) {
      const amount = await read(a.HybridVault, 'HybridVault', 'pocketClaimable', [pocketId, address(who)]);
      if (amount > 0n) await write(who, a.HybridVault, 'HybridVault', 'claimPocket', [pocketId]);
      const reward = await read(a.HybridVault, 'HybridVault', 'rewardClaimable', [address(who)]);
      if (reward > 0n) await write(who, a.HybridVault, 'HybridVault', 'claimRewards');
    }
    await record('claim, pocket and reward withdrawals and the fee claim', async () => {
      assert.equal((await get(prefix)).feeAccrued, '0');
      const owner = await get(prefix + '/accounts/' + address('alice'));
      assert.equal(owner.claimable, '0');
      assert(BigInt(owner.performance.withdrawalsUSDG) > 0n);
      const rows = await all(prefix + '/accounts');
      assert(rows.every(x => x.pockets.every(p => p.claimable === '0') && x.rewards === '0'));
      assert(rows.some(x => x.collateralReceived.some(c => BigInt(c.amount) > 0n)));
      const pockets = await all(prefix + '/pockets');
      assert.equal(BigInt(pockets[0].claimed), rows.flatMap(x => x.collateralReceived).reduce((sum, c) => sum + BigInt(c.amount), 0n));
    });
    for (const route of ['/earn/strategies', prefix, prefix + '/accounts', prefix + '/accounts/' + address('alice'), prefix + '/requests', prefix + '/loans', prefix + '/pockets', prefix + '/approvals', prefix + '/events', prefix + '/keeper', '/health/indexer']) {
      proof.endpointResponses[route] = await get(route);
    }
    const health = proof.endpointResponses['/health/indexer'];
    assert(health.earn, 'Health must report Earn');
    assert.equal(health.earn.contracts.HybridVault.toLowerCase(), a.HybridVault.toLowerCase());
    assert.equal(health.earn.contracts.HybridReserve.toLowerCase(), a.HybridReserve.toLowerCase());
    proof.completedAt = new Date().toISOString();
    save(state, output);
    proof.transactions = state.transactions;
    writeReport(path.join(output, 'indexer-evidence.json'), proof);
    success = true;
    console.log(`B2 lifecycle passed. Evidence: ${path.join(output, 'indexer-evidence.json')}`);
    return { output, rpc, base, chain, indexer, runtime, state, proof };
  } finally {
    if (!success || !keep) { indexer.kill('SIGTERM'); chain.kill('SIGTERM'); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, rpc: { type: 'string' }, port: { type: 'string' }, keep: { type: 'boolean', default: false } } });
  runEarnIndexerRehearsal({ output: values.output, rpc: values.rpc, port: values.port ? Number(values.port) : undefined, keep: values.keep })
    .catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
