#!/usr/bin/env node
// Isolated test assets and public fixture accounts. Never forks or signs on a public chain.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {DEFAULT_RPC, DEFAULT_OUTPUT, localRpc, loadManifest, createRuntime, artifact, U, viem, stringify} from './runtime.mjs';
import {deployFixture} from './fixture.mjs';

export async function startLocal({rpc = DEFAULT_RPC, output = DEFAULT_OUTPUT, timestamp = 1_800_000_000} = {}) {
  localRpc(rpc);
  assert(Number.isSafeInteger(timestamp) && timestamp > 0, 'Use a positive Unix timestamp for the local fixture.');
  assert(!fs.existsSync(path.join(output, 'manifest.json')), 'Preserve existing fixture evidence; choose another --output directory.');
  const url = new URL(rpc), host = url.hostname === '[::1]' ? '::1' : url.hostname, port = Number(url.port || 80);
  const busy = await new Promise(resolve => {
    const socket = net.connect({host, port});
    socket.once('connect', () => {socket.destroy(); resolve(true);});
    socket.once('error', () => resolve(false));
  });
  assert(!busy, 'This port is already in use; an existing chain will never be replaced.');
  for (const name of ['HybridVault', 'HybridFees', 'HybridReserveMock', 'HybridReserveRehearsalMock', 'HybridStockRehearsalMock', 'MockERC20', 'MockMulticall3', 'MockUniversalRouter',
    'EntryRouter', 'CollateralRegistry', 'FeeSink', 'DealVault', 'GageV2Vault', 'GageV2Registry', 'GageV2CollateralValidator', 'GageV2Rewards', 'HybridFactory']) artifact(name);
  const child = spawn('anvil', ['--host', host, '--port', String(port), '--chain-id', '31337', '--timestamp', String(timestamp), '--silent'], {stdio: 'ignore'});
  let spawnError;
  child.once('error', error => {spawnError = error;});
  const runtime = createRuntime(rpc);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError) throw spawnError;
      try {await runtime.assertLocal(); ready = true;} catch { /* local process is starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'Anvil did not start.');
    const state = await deployFixture(runtime, {rpc, output, processId: process.pid, anvilProcessId: child.pid});
    return {child, runtime, state};
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const {values, positionals} = parseArgs({args: argv, allowPositionals: true, options: {
    output: {type: 'string'}, loan: {type: 'string'}, amount: {type: 'string'}, 'current-time': {type: 'boolean'}, help: {type: 'boolean'},
  }});
  if (values.help) {
    console.log('Usage: node scripts/hybrid/local-chain.mjs [start|status|gain|loss|illiquid|liquid|zero-max|normal-max|repay|overdue|mature|refresh-approvals] [--output DIR] [--loan ID] [--amount USDG] [--current-time]\nLoopback Anvil only; default RPC18559, output .rehearsal/hybrid-local. Use --current-time when starting a browser fixture so freshness checks use wall time. The gain/loss/limit controls model reserve behavior, not real Morpho.');
    return;
  }
  const command = positionals[0] ?? 'start';
  const output = path.resolve(values.output ?? DEFAULT_OUTPUT);
  if (command === 'start') {
    const rpc = localRpc(process.env.HYBRID_LOCAL_RPC_URL ?? DEFAULT_RPC);
    const {child, runtime, state} = await startLocal({rpc, output,
      ...(values['current-time'] ? {timestamp: Math.floor(Date.now() / 1000)} : {})});
    const stop = () => child.kill('SIGTERM');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
    if (values['current-time']) {
      try {await runtime.pub.request({method: 'evm_setIntervalMining', params: [2]});}
      catch (error) {stop(); throw error;}
    }
    console.log(`Hybrid local chain ready at ${rpc}.\nManifest: ${path.join(output, 'manifest.json')}\nInvestor: ${state.accounts.alice.address}. 2,000 test USDG deposited for shares at the initial price; 98,000 in the wallet.\nThe strategy holds 3,000 idle USDG until the operator parks it in the reserve. Gage has approved every quarter of two local V2 loans. All assets, the core and the reserve are local test contracts.\nLeave this process running; Ctrl-C stops only this Anvil.`);
    await new Promise((resolve, reject) => {child.once('exit', resolve); child.once('error', reject);});
    return;
  }
  const state = loadManifest(output);
  const runtime = createRuntime(localRpc(process.env.HYBRID_LOCAL_RPC_URL ?? state.rpc));
  const {pub, read, write, address, warp, save} = runtime;
  await runtime.verify(state);
  const a = state.addresses;
  const candidate = state.candidates.find(item => item.id === (values.loan ?? state.candidates[0].id));
  const amount = viem.parseUnits(values.amount ?? '30', 6);
  assert(amount > 0n, 'Amount must be positive.');
  if (command === 'status') {
    const accounts = {};
    for (const who of ['alice', 'bob']) accounts[who] = await runtime.accountState(a.HybridVault, address(who));
    console.log(stringify({timestamp: (await pub.getBlock()).timestamp, strategy: await runtime.vaultState(a.HybridVault), accounts, candidates: state.candidates,
      reserveAssets: await read(a.Reserve, 'HybridReserveMock', 'totalAssets'),
      reserveShares: await read(a.Reserve, 'HybridReserveMock', 'totalSupply'),
      maxWithdraw: await read(a.Reserve, 'HybridReserveMock', 'maxWithdraw', [a.HybridVault]),
      conservativeMaxViews: await read(a.Reserve, 'HybridReserveMock', 'reportZeroMax')}));
    return;
  }
  if (command === 'gain') {
    await write('curator', a.USDG, 'MockERC20', 'approve', [a.Reserve, amount]);
    await write('curator', a.Reserve, 'HybridReserveMock', 'donate', [amount]);
  } else if (command === 'loss') await write('curator', a.Reserve, 'HybridReserveMock', 'simulateLoss', [amount, address('curator')]);
  else if (command === 'illiquid') await write('curator', a.Reserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, 0n, 0n]);
  else if (command === 'liquid') await write('curator', a.Reserve, 'HybridReserveMock', 'setLimits', [viem.maxUint256, viem.maxUint256, viem.maxUint256]);
  else if (command === 'zero-max' || command === 'normal-max') await write('curator', a.Reserve, 'HybridReserveMock', 'setReportZeroMax', [command === 'zero-max']);
  else if (command === 'repay') {
    assert(candidate, 'Unknown fixture loan.');
    await write(candidate.actor, a.EarnCore, 'GageV2Vault', 'reclaim', [BigInt(candidate.id), address(candidate.actor)]);
  } else if (command === 'overdue' || command === 'mature') {
    assert(candidate, 'Unknown fixture loan.');
    const loan = await read(a.EarnCore, 'GageV2Vault', 'getLoan', [BigInt(candidate.id)]);
    assert(Number(loan.state) === 2, `Only an active loan can ${command === 'overdue' ? 'fall overdue' : 'mature'}.`);
    // `overdue` ends the term so the operator's write-down can be observed during grace; `mature` passes grace too.
    await warp(BigInt(loan.fundedAt) + BigInt(loan.term) + (command === 'mature' ? BigInt(state.grace) : 0n) + 1n);
  } else if (command === 'refresh-approvals') {
    for (const loan of state.candidates.filter(item => item.eligible)) {
      const core = await read(a.EarnCore, 'GageV2Vault', 'getLoan', [BigInt(loan.id)]);
      if (Number(core.state) !== 1) continue;
      const until = (await pub.getBlock()).timestamp + 3500n;
      await write('curator', a.HybridVault, 'HybridVault', 'approveLoan', [BigInt(loan.id), Number(until), loan.units]);
      loan.validUntil = String(until);
    }
  } else throw new Error('Unknown local command; use --help.');
  save(state, output);
  console.log(`Hybrid local fixture: ${command}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {console.error(error.shortMessage ?? error.message); process.exitCode = 1;});
}
