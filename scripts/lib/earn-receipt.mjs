import {extensionTransactions} from './extension-transactions.mjs';
import {canonical, EARN_FLAGSHIP} from './earn-mandate.mjs';
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** A receipt cannot be adopted by another signer, release, mandate or base deployment. */
export function bindEarnReceipt(existing, binding) {
  if (existing) {
    if (existing.schemaVersion !== 1 || !equal(existing.binding, binding)) throw Error('Earn receipt binding changed; inspect the saved deployment');
    if (!existing.steps || !existing.addresses || !existing.runtimeHashes) throw Error('Earn receipt is incomplete');
    if (Object.keys(existing.addresses).some(name => !['HybridFactory', 'HybridVault', 'HybridFees'].includes(name))) throw Error('Earn receipt contains an unexpected address');
    return existing;
  }
  return {schemaVersion: 1, binding, phase: 'preparing', steps: {}, addresses: {}, runtimeHashes: {}};
}

/** Add cross-step exclusivity, failed receipt retention and reorg detection to the shared transaction journal. */
export function earnTransactions({pub, account, chainId, journal, save, viem}) {
  const record = receipt => {
    const step = Object.values(journal.steps).find(value => value.hash === receipt.transactionHash);
    if (!step) throw Error('Earn receipt does not match a saved transaction');
    if (step.blockHash && step.blockHash !== receipt.blockHash) throw Error('Earn transaction block hash changed');
    Object.assign(step, {blockHash: receipt.blockHash, blockNumber: String(receipt.blockNumber),
      gasUsed: String(receipt.gasUsed), effectiveGasPrice: String(receipt.effectiveGasPrice)});
    if (receipt.status !== 'success') {step.status = 'failed'; journal.phase = 'failed';}
    save();
    return receipt;
  };
  const checkedPub = Object.assign(Object.create(pub), {
    getTransactionReceipt: async request => record(await pub.getTransactionReceipt(request)),
    waitForTransactionReceipt: async request => record(await pub.waitForTransactionReceipt(request)),
  });
  const send = extensionTransactions({pub: checkedPub, account, chainId, journal, save, viem});
  return async (label, tx) => {
    if (Object.values(journal.steps).some(step => step.status === 'failed')) throw Error('Earn has a failed transaction; inspect its saved receipt');
    if (!journal.steps[label] && Object.values(journal.steps).some(step => step.status !== 'confirmed')) throw Error('Earn has an unresolved transaction; recover it before advancing');
    return send(label, tx);
  };
}

/** Reconstruct a deployment after interruption between receipt confirmation and address persistence. */
export function recoverEarnAddress(journal, name, derived) {
  const step = journal.steps[`deploy:${name}`];
  const same = value => String(value).toLowerCase() === derived.toLowerCase();
  if (!step || step.status !== 'confirmed' || !same(step.contractAddress)
    || (journal.addresses[name] && !same(journal.addresses[name]))) throw Error('Earn deployment address does not match its saved nonce and receipt');
  journal.addresses[name] = derived;
  return derived;
}

/** Recover the atomic factory-created pair from the confirmed transaction, including interrupted saves. */
export function recoverEarnInstance(journal, receipt, {factory, curator, abi, viem}) {
  const step = journal.steps['create:HybridVault'];
  const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
  if (!step || step.status !== 'confirmed' || !same(step.hash, receipt.transactionHash) || receipt.status !== 'success'
    || !same(journal.addresses.HybridFactory, factory) || !same(step.tx?.to, factory)
    || !same(receipt.to, factory) || !same(receipt.from, curator)
    || !same(step.blockHash, receipt.blockHash) || String(step.blockNumber) !== String(receipt.blockNumber)) {
    throw Error('Earn instance has no matching confirmed creation receipt');
  }
  const events = receipt.logs.filter(log => String(log.address).toLowerCase() === factory.toLowerCase())
    .flatMap(log => {
      try {
        const event = viem.decodeEventLog({abi, topics: log.topics, data: log.data, strict: true});
        return event.eventName === 'VaultCreated' ? [event.args] : [];
      } catch {return [];}
    });
  const event = events[0];
  if (events.length !== 1 || !event || ![event.curator, event.creator].every(value => same(value, curator))) {
    throw Error('Earn creation event does not name the reviewed curator and creator');
  }
  const pair = {HybridVault: event.vault, HybridFees: event.fees};
  for (const [name, value] of Object.entries(pair)) {
    if (!viem.isAddress(value) || value === viem.zeroAddress || value.toLowerCase() === factory.toLowerCase()
      || (journal.addresses[name] && journal.addresses[name].toLowerCase() !== value.toLowerCase())) {
      throw Error('Earn instance address differs from its creation receipt');
    }
  }
  if (pair.HybridVault.toLowerCase() === pair.HybridFees.toLowerCase()) throw Error('Earn creation returned duplicate addresses');
  Object.assign(journal.addresses, pair);
  return pair;
}

/** Extend the base file without losing its original start block, pools or later protocol extensions. */
/** Every published strategy: the `earnStrategies` list, or the flat flagship keys read as its only entry. */
export function earnStrategyEntries(base) {
  if (Array.isArray(base.earnStrategies)) return base.earnStrategies;
  if (!base.HybridVault) return [];
  const entry = {id: EARN_FLAGSHIP.id, title: EARN_FLAGSHIP.title, HybridVault: base.HybridVault, HybridFees: base.HybridFees, HybridReserve: base.HybridReserve,
    EarnCore: base.EarnCore, earnStartBlock: base.earnStartBlock, earnMandate: base.earnMandate};
  for (const key of ['earnReceipt', 'earnReleaseHash']) if (base[key] !== undefined) entry[key] = base[key];
  return [entry];
}

/** The flagship keeps the flat manifest keys; every later instance joins the `earnStrategies` list behind it. */
export function earnDeployment(base, journal, mandate, receipt, strategy = EARN_FLAGSHIP) {
  const flagship = strategy.id === EARN_FLAGSHIP.id;
  const factory = journal.steps['deploy:HybridFactory'], creation = journal.steps['create:HybridVault'];
  if (!creation || creation.status !== 'confirmed' || (flagship && (!factory || factory.status !== 'confirmed'))
    || !['HybridFactory', 'HybridVault', 'HybridFees'].every(name => journal.addresses[name])) throw Error('Earn deployment has no confirmed factory instance');
  const first = BigInt(creation.blockNumber), factoryBlock = flagship ? BigInt(factory.blockNumber) : BigInt(base.hybridFactoryStartBlock ?? 0);
  if (first > BigInt(Number.MAX_SAFE_INTEGER) || factoryBlock > first) throw Error('Earn deployment block exceeds the JSON bound');
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const entry = {id: strategy.id, title: strategy.title, HybridVault: journal.addresses.HybridVault, HybridFees: journal.addresses.HybridFees,
    HybridReserve: mandate.reserve, EarnCore: mandate.core, earnStartBlock: Number(first),
    earnMandate: {...mandate, curator: journal.binding.owner}, earnReceipt: receipt, earnReleaseHash: journal.binding.releaseHash};
  if (flagship) {
    return {...base, HybridFactory: journal.addresses.HybridFactory, HybridVault: journal.addresses.HybridVault, HybridFees: journal.addresses.HybridFees,
      HybridReserve: mandate.reserve, EarnCore: mandate.core, earnStartBlock: Number(first), hybridFactoryStartBlock: Number(factoryBlock),
      earnMandate: {...mandate, curator: journal.binding.owner}, earnReceipt: receipt,
      earnReleaseHash: journal.binding.releaseHash, ...(journal.binding.localFork ? {localFork: true} : {})};
  }
  const published = earnStrategyEntries(base);
  if (!published.length || published[0].id !== EARN_FLAGSHIP.id || !same(base.HybridFactory, journal.addresses.HybridFactory)) throw Error('Earn instance requires the published flagship and its factory');
  if (!same(published[0].HybridReserve, mandate.reserve) || !same(published[0].EarnCore, mandate.core)) throw Error('Earn instance must share the factory reserve and core');
  const others = published.filter(item => item.id !== entry.id);
  if (others.some(item => same(item.HybridVault, entry.HybridVault) || same(item.HybridFees, entry.HybridFees))) throw Error('Earn instance addresses are already published under another id');
  return {...base, earnStrategies: [...others, entry]};
}
