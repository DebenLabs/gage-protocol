// Reviewed launch limits. Amounts stay decimal strings so JSON never rounds uint128 values.
import {createHash} from 'node:crypto';
export const EARN_RESERVE = '0xBeEff033F34C046626B8D0A041844C5d1A5409dd';
export const EARN_MANDATE_VERSION = 2;
export const EARN_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const UINT128_MAX = (1n << 128n) - 1n;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Earn strategy categories have their own indices; the collateral registry still uses STOCK/ETH/MEME.
export const LANES = ['STOCK', 'MEME', 'LP'];
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return typeof value === 'bigint' ? String(value) : value;
}
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const requireValue = (ok, message) => {if (!ok) throw Error(message);};
function address(value, name, allowZero = false) {
  requireValue(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && (allowZero || value.toLowerCase() !== ZERO_ADDRESS), `Invalid Earn ${name} address`);
  return value.toLowerCase();
}
function integer(value, name, min, max) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid Earn ${name} bound`);
  return value;
}
function amount(value, name) {
  requireValue((typeof value === 'string' && /^[0-9]+$/.test(value)) || (Number.isSafeInteger(value) && value >= 0), `Invalid Earn ${name} amount`);
  const parsed = BigInt(value);
  requireValue(parsed > 0n && parsed <= UINT128_MAX, `Invalid Earn ${name} amount`);
  return String(parsed);
}

/** Constructor amounts; a curator may later close deposits by setting the mutable cap to zero. */
export function normalizeEarnDepositLimits(input) {
  const result = Object.fromEntries(['minDeposit', 'maxTotalDeposits'].map(name => [name, amount(input?.[name], name)]));
  requireValue(BigInt(result.minDeposit) <= BigInt(result.maxTotalDeposits), 'Earn minimum deposit exceeds the total deposit cap');
  return result;
}

/** Require named categories so an old ETH index cannot silently become MEME or LP at deployment. */
export function normalizeEarnLaneWeights(input) {
  requireValue(input && !Array.isArray(input) && typeof input === 'object'
    && Object.keys(input).sort().join(',') === [...LANES].sort().join(','),
  'Earn requires exactly STOCK, MEME and LP lane weights; legacy ETH or positional lane weights are unsupported');
  const result = Object.fromEntries(LANES.map(lane => [lane, integer(input[lane], `${lane} weight`, 0, 10000)]));
  requireValue(Object.values(result).reduce((sum, value) => sum + value, 0) <= 10000,
    'Earn combined STOCK, MEME and LP lane weights exceed 100%');
  return result;
}

/** Validate the complete mandate before prompting or signing. The local fixture also needs explicit review. */
export function normalizeEarnMandate(input, {localFork = false} = {}) {
  requireValue(input?.schemaVersion === 1 && input.chainId === 4663, 'Invalid Earn mandate version or chain');
  requireValue(input.reviewed === true, 'Earn mandate has not been reviewed');
  requireValue(typeof input.mainnetExecutionApproved === 'boolean', 'Earn execution approval must be explicit');
  requireValue(localFork || input.mainnetExecutionApproved === true, 'Earn mainnet execution remains disabled');
  const result = {schemaVersion: 1, chainId: 4663, reviewed: true, mainnetExecutionApproved: input.mainnetExecutionApproved};
  result.reserve = address(input.reserve, 'reserve');
  requireValue(result.reserve === EARN_RESERVE.toLowerCase(), 'Earn requires the reviewed Steakhouse USDG reserve');
  // The Gage V2 engine the strategy lends through; the stage checks it against the base deployment's published engines.
  result.core = address(input.core, 'core');
  requireValue(result.core !== result.reserve && result.core !== EARN_USDG.toLowerCase(), 'Earn core cannot be USDG or the reserve');
  Object.assign(result, normalizeEarnDepositLimits(input));
  result.maxLoanTerm = integer(input.maxLoanTerm, 'maxLoanTerm', 1, 7776000);
  requireValue([604800, 1814400].includes(result.maxLoanTerm), 'Earn launch term must admit the 7-day or 21-day product terms');
  result.minReturnBps = integer(input.minReturnBps, 'minReturnBps', 0, 10000);
  result.maxGageExposureBps = integer(input.maxGageExposureBps, 'maxGageExposureBps', 1, 10000);
  result.laneWeights = normalizeEarnLaneWeights(input.laneWeights);
  requireValue(Array.isArray(input.admittedTokens), 'Earn admitted tokens must be a list');
  const tokens = new Set();
  result.admittedTokens = input.admittedTokens.map(item => {
    const token = address(item?.token, 'token');
    requireValue(token !== result.reserve && token !== EARN_USDG.toLowerCase() && token !== result.core, 'Earn token cannot be USDG, the reserve or the core');
    requireValue(!tokens.has(token), 'Duplicate Earn token');
    tokens.add(token);
    return {token, ceiling: amount(item.ceiling, 'token ceiling')};
  }).sort((a, b) => a.token.localeCompare(b.token));
  result.feeBps = integer(input.feeBps, 'feeBps', 0, 5000);
  result.protocolShareBps = integer(input.protocolShareBps, 'protocolShareBps', 0, 10000);
  // The fee companion always needs a curator recipient, even while the rate is zero.
  result.feeRecipient = address(input.feeRecipient, 'fee recipient');
  return result;
}

export const EARN_FLAGSHIP = {id: 'gage-mix', title: 'Gage USDG Mix'};
export const EARN_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Catalog identity of a mandate: the flagship needs none; every other strategy names its route slug and title. */
export function earnStrategyIdentity(input, requested) {
  const id = input?.id ?? EARN_FLAGSHIP.id;
  requireValue(typeof id === 'string' && EARN_ID_PATTERN.test(id), 'Earn strategy id must be a short lowercase slug');
  requireValue(!requested || requested === id, 'Earn mandate names a different strategy than the one requested');
  const title = input?.title ?? (id === EARN_FLAGSHIP.id ? EARN_FLAGSHIP.title : undefined);
  requireValue(typeof title === 'string' && title.trim().length >= 3 && title.trim().length <= 48, 'Earn strategy title must be 3 to 48 characters');
  return {id, title: title.trim()};
}

/** Execution approval is operational; every substantive field and review flag stays bound. */
export function earnMandateHash(input) {
  const {mainnetExecutionApproved: _approval, _comments, ...substantive} = input;
  return sha256(substantive);
}
