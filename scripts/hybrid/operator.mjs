#!/usr/bin/env node
// Bounded one-shot local operator. It never approves loans or accepts a private signing key.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {DEFAULT_OUTPUT, loadManifest, createRuntime, artifact, viem, writeReport} from './runtime.mjs';

/** The keeper's permissionless calls on the pooled share vault (D82), in the order one maintenance pass runs them. */
const ALLOWED_ACTIONS = new Set(['cancelFunding', 'settle', 'markOverdue', 'harvestCash', 'harvestRewards', 'serveRequests', 'investReserve', 'fund']);
export function actionAllowed(name) { return ALLOWED_ACTIONS.has(name); }
const errorLabel = error => error?.cause?.data?.errorName ?? error?.data?.errorName ?? error?.name ?? 'ActionUnavailable';
/** One live reward stream is harvested once at least this much sGAGE is claimable; a closed loan is harvested whole. */
const REWARD_THRESHOLD = 10n ** 18n;
const MAX_BATCH = 32;
/** How many queued redemption requests one pass serves; a partially served request stays at the head. */
const MAX_REQUESTS = 32n;
const chunks = items => Array.from({length: Math.ceil(items.length / MAX_BATCH)}, (_, i) => items.slice(i * MAX_BATCH, (i + 1) * MAX_BATCH));

export async function runOperator({output = DEFAULT_OUTPUT, execute = false, reportFile = path.join(output, 'operator.json'), loanId, fund = true, invest = true} = {}) {
  const manifestFile = path.resolve(output, 'manifest.json');
  assert(path.resolve(reportFile) !== manifestFile, 'The report must not overwrite its manifest.');
  const state = loadManifest(output), runtime = createRuntime(state.rpc);
  await runtime.verify(state);
  const {pub, read} = runtime, a = state.addresses;
  const abi = artifact('HybridVault').abi;
  const actor = runtime.actors.keeper;
  if (fs.existsSync(reportFile)) {
    const previous = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    for (const action of previous.actions ?? []) if (['submitted', 'pending'].includes(action.status)) {
      const receipt = action.hash ? await pub.getTransactionReceipt({hash: action.hash}).catch(() => null) : null;
      assert(receipt, `An earlier transaction remains unresolved; preserve ${reportFile}.`);
    }
  }
  const report = {schemaVersion: 2, localOnly: true, chainId: 31337, mode: execute ? 'execute' : 'dry-run',
    vault: a.HybridVault, core: a.EarnCore, operator: actor.account.address, startedAt: new Date().toISOString(), actions: []};
  const save = () => writeReport(reportFile, report);
  const vault = (functionName, args = []) => read(a.HybridVault, 'HybridVault', functionName, args);
  const targets = {cancelFunding: ['GageV2Vault', a.EarnCore]};
  async function attempt(name, args) {
    assert(actionAllowed(name), 'Unsupported operator action.');
    await runtime.verify(state);
    const action = {name, args, status: 'inspecting'};
    report.actions.push(action);
    const [artifactName, target] = targets[name] ?? ['HybridVault', a.HybridVault];
    const targetAbi = artifact(artifactName).abi;
    const request = {address: target, abi: targetAbi, functionName: name, args, account: actor.account};
    try {await pub.simulateContract(request);} catch (error) {
      action.status = 'waiting'; action.error = errorLabel(error); save(); return false;
    }
    if (!execute) {action.status = 'ready'; save(); return false;}
    const [latest, pending] = await Promise.all([
      pub.getTransactionCount({address: actor.account.address, blockTag: 'latest'}),
      pub.getTransactionCount({address: actor.account.address, blockTag: 'pending'}),
    ]);
    assert.equal(latest, pending, 'Resolve the operator’s pending transaction before continuing.');
    const chain = viem.defineChain({id: 31337, name: 'Hybrid local', nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18}, rpcUrls: {default: {http: [state.rpc]}}});
    const data = viem.encodeFunctionData({abi: targetAbi, functionName: name, args});
    const gas = await pub.estimateGas({account: actor.account.address, to: target, data});
    // Settlement intentionally isolates a failed collateral recovery. A gas estimator can otherwise
    // select that cheaper caught-failure path; this bounded local allowance covers the complete work.
    const estimatedGas = gas * 120n / 100n + 10_000n;
    const floor = name === 'settle' ? 2_000_000n : 0n;
    const transaction = await actor.wallet.prepareTransactionRequest({chain, account: actor.account,
      to: target, data, nonce: pending, value: 0n, gas: estimatedGas > floor ? estimatedGas : floor});
    const serialized = await actor.wallet.signTransaction(transaction);
    action.hash = viem.keccak256(serialized);
    action.status = 'submitted'; save();
    try {
      assert.equal(await pub.sendRawTransaction({serializedTransaction: serialized}), action.hash);
      const receipt = await pub.waitForTransactionReceipt({hash: action.hash, timeout: 15_000});
      action.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
      action.blockNumber = String(receipt.blockNumber);
      if (action.status === 'confirmed' && name === 'settle') {
        for (const id of args[0]) if (!await vault('terminal', [id])) {
          action.status = 'partial'; action.warning = 'Loan settlement remains pending';
        }
      }
    } catch {
      action.status = 'pending'; save();
      throw new Error('Transaction status is uncertain; no further transactions will be signed.');
    }
    save();
    return action.status === 'confirmed';
  }
  try {
    const latestBlock = await pub.getBlockNumber({cacheTime: 0});
    assert(latestBlock <= 100_000n, 'This bounded local fixture operator supports at most 100,000 blocks.');
    const logsOf = eventName => pub.getLogs({address: a.HybridVault, event: abi.find(item => item.type === 'event' && item.name === eventName),
      fromBlock: BigInt(state.earnStartBlock), toBlock: latestBlock});
    // Funded loans are the strategy's own LoanFunded history; the core's getLoan is the only state source.
    const fundedIds = [...new Set((await logsOf('LoanFunded')).map(log => String(log.args.dealId)))].map(BigInt);
    assert(fundedIds.length <= 256, 'This local operator supports at most 256 funded loans.');
    // 1. Independent settlements first; one blocked collateral recovery must not stop another loan's cash.
    const overdueCandidates = [], rewardCandidates = [];
    for (const id of fundedIds) {
      let loan = await read(a.EarnCore, 'GageV2Vault', 'getLoan', [id]);
      const now = (await pub.getBlock()).timestamp;
      let [terminal, withdrawn] = await Promise.all([vault('terminal', [id]), vault('withdrawn', [id])]);
      if (!terminal && !withdrawn && Number(loan.state) === 1 && now >= BigInt(loan.fundingDeadline)) {
        await attempt('cancelFunding', [id]);
        loan = await read(a.EarnCore, 'GageV2Vault', 'getLoan', [id]);
      }
      const coreState = Number(loan.state);
      const termEnd = BigInt(loan.fundedAt) + BigInt(loan.term);
      const defaultAt = termEnd + BigInt(state.grace);
      if (!terminal && (withdrawn || coreState >= 3 || (coreState === 2 && now >= defaultAt))) {
        if (await attempt('settle', [[id]])) terminal = await vault('terminal', [id]);
      }
      // 2. A loan past its term that has not repaid leaves the share price at once; the engine's clock decides.
      if (!terminal && coreState === 2 && now >= termEnd && !await vault('overdue', [id])) overdueCandidates.push(id);
      if (withdrawn || coreState === 1 || coreState === 5) continue;
      // 3. Rewards accrue per share at harvest; avoid a transaction for every tiny increment of a live stream.
      const due = await read(a.EarnCoreRewards, 'GageV2Rewards', 'claimable', [id, a.HybridVault]).catch(() => 0n);
      if (due >= REWARD_THRESHOLD || (due > 0n && coreState >= 3)) rewardCandidates.push(id);
    }
    for (const batch of chunks(overdueCandidates)) await attempt('markOverdue', [batch]);
    if (await read(a.EarnCore, 'GageV2Vault', 'cashCredit', [a.HybridVault]) > 0n) await attempt('harvestCash', []);
    for (const batch of chunks(rewardCandidates)) await attempt('harvestRewards', [batch]);
    // 4. Queued redemptions are served oldest first from cash and the reserve, before any cash is parked or lent.
    const pendingShares = await vault('pendingShares');
    if (pendingShares > 0n && await vault('cash') + await read(a.Reserve, 'HybridReserveMock', 'previewRedeem', [await vault('reserveShares')]) > 0n) {
      // max* views are intentionally not consulted: conservative zero views do not prove execution is unavailable.
      await attempt('serveRequests', [MAX_REQUESTS, viem.maxUint256]);
    }
    // 5. Idle cash earns in the reserve; while requests wait for liquidity it stays where they can be paid from.
    if (invest && !await vault('paused') && await vault('pendingShares') === 0n) {
      const cash = await vault('cash');
      if (cash > 0n) {
        const preview = await read(a.Reserve, 'HybridReserveMock', 'previewDeposit', [cash]);
        await attempt('investReserve', [cash, preview * 9990n / 10000n]);
      }
    }
    // 6. Fresh on-chain curator approvals are the only funding discovery source. The operator never underwrites.
    if (fund) {
      const approvedIds = [...new Set((await logsOf('LoanApproved')).map(log => String(log.args.dealId)))];
      assert(approvedIds.length <= 512, 'This local operator supports at most 512 approved loan identities.');
      for (const rawId of approvedIds.filter(id => !loanId || id === String(loanId))) {
        const id = BigInt(rawId), loan = await read(a.EarnCore, 'GageV2Vault', 'getLoan', [id]);
        if (Number(loan.state) !== 1 || await vault('funded', [id])) continue;
        const approval = await vault('approvals', [id]);
        const principal = approval.principal ?? approval[1];
        const validUntil = approval.validUntil ?? approval[0];
        const epoch = approval.epoch ?? approval[2];
        if (principal === 0n || BigInt(validUntil) < (await pub.getBlock()).timestamp || epoch !== await vault('approvalEpoch')) continue;
        // Cash pays first; only the shortfall redeems reserve shares, bounded by a current preview plus tolerance.
        const cash = await vault('cash');
        const shortfall = principal > cash ? principal - cash : 0n;
        const shares = shortfall === 0n ? 0n : await read(a.Reserve, 'HybridReserveMock', 'previewWithdraw', [shortfall]);
        await attempt('fund', [id, shares + (shares + 999n) / 1000n]);
      }
    }
    report.completedAt = new Date().toISOString();
    report.blockNumber = String(await pub.getBlockNumber({cacheTime: 0}));
    save();
    return report;
  } catch (error) {
    report.error = errorLabel(error); report.completedAt = new Date().toISOString(); save(); throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const {values} = parseArgs({args: argv, options: {output: {type: 'string'}, report: {type: 'string'}, execute: {type: 'boolean'},
    loan: {type: 'string'}, 'no-fund': {type: 'boolean'}, 'no-invest': {type: 'boolean'}, watch: {type: 'boolean'}, interval: {type: 'string'}, help: {type: 'boolean'}}});
  if (values.help) {
    console.log('Usage: node scripts/hybrid/operator.mjs [--output DIR] [--report FILE] [--execute] [--loan ID] [--no-fund] [--no-invest] [--watch] [--interval 15]\nRead-only by default. --execute uses the public local keeper account on the pinned Anvil31337 fixture only. In order it can release closed funding windows, settle, write down overdue loans, collect cash and rewards, serve queued redemptions, park idle cash in the reserve and fund explicitly curator-approved loan quarters. It never approves loans or sends a holder’s assets to a wallet.');
    return;
  }
  const output = path.resolve(values.output ?? DEFAULT_OUTPUT);
  const interval = Number(values.interval ?? '15');
  assert(Number.isSafeInteger(interval) && interval >= 5 && interval <= 300, 'Watch interval must be 5–300 seconds.');
  let stop = false, wake;
  const shutdown = () => {stop = true; wake?.();};
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  let previousSummary;
  do {
    const report = await runOperator({output, execute: values.execute === true,
      reportFile: path.resolve(values.report ?? path.join(output, 'operator.json')), loanId: values.loan, fund: !values['no-fund'], invest: !values['no-invest']});
    const ready = report.actions.filter(action => ['ready', 'confirmed'].includes(action.status)).length;
    const waiting = report.actions.filter(action => ['waiting', 'partial', 'reverted'].includes(action.status)).length;
    const summary = `${report.mode}: ${ready} ${values.execute ? 'confirmed' : 'ready'}, ${waiting} waiting.`;
    if (values.watch) writeReport(path.join(output, 'operator-history', `${Date.now()}.json`), report);
    if (ready || summary !== previousSummary) console.log(`${summary} Report: ${values.report ?? path.join(output, 'operator.json')}`);
    previousSummary = summary;
    if (!values.watch || stop) break;
    await new Promise(resolve => {const timer = setTimeout(resolve, interval * 1000); wake = () => {clearTimeout(timer); resolve();};});
    wake = undefined;
  } while (!stop);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {console.error(error.shortMessage ?? error.message); process.exitCode = 1;});
}
