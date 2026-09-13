/** Read-only receipt verification. No account, private key, signing or transaction submission. */
import { readFileSync } from "node:fs";
import { createPublicClient, encodeAbiParameters, http, isAddress, keccak256, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { loadNativeZapDeployments } from "../native-v2.js";
import { RatingStore } from "./store.js";
import { MODEL, GRADES, type Grade } from "./model.js";
import type { Outcome } from "./calibration.js";

const abi = parseAbi([
  "event Activated(uint256 indexed id, uint40 fundedAt, uint128 fee, uint128 borrowerReward, uint128 lenderReward)",
  "event Closed(uint256 indexed id, uint8 state, address beneficiary, uint40 closedAt)",
  "function lenders(uint256 id) view returns (address[4])",
  "function getLoan(uint256 id) view returns ((address originator, address account, address token, address collateralBeneficiary, uint8 kind, uint8 state, uint8 filled, uint32 term, uint40 fundingDeadline, uint40 fundedAt, uint40 closedAt, uint128 principal, uint128 cap, uint128 originationFee, uint128 borrowerReward, uint128 lenderReward, uint256 collateral, bytes32 exposureKey, uint256 exposureAmount))",
]);
const [ledger, jobsFile] = process.argv.slice(2);
if (!ledger || !jobsFile) throw new Error("Usage: ratings:capture ratings.sqlite receipt-jobs.json");
const jobs: unknown = JSON.parse(readFileSync(jobsFile, "utf8"));
if (!Array.isArray(jobs) || jobs.length > 1000) throw new Error("Expected at most 1000 receipt jobs");
const config = loadConfig(), deployments = loadNativeZapDeployments(config.deploymentFile);
const client = createPublicClient({ transport: http(config.rpcUrl) });
const chainId = await client.getChainId(), head = await client.getBlockNumber();
if (!deployments.length || deployments.some(d => d.chainId !== chainId)) throw new Error("Chain does not match the published native engines");
const store = new RatingStore(ledger), outcomes: Outcome[] = [], excluded: { index: number; reason: string }[] = [];
try {
  for (const [index, unknownJob] of jobs.entries()) {
    try {
      const job = unknownJob as Record<string, unknown>;
      if (!job || typeof job.engine !== "string" || !isAddress(job.engine) || typeof job.loanId !== "string" || !/^\d{1,78}$/.test(job.loanId)
        || typeof job.fundingTx !== "string" || !/^0x[0-9a-f]{64}$/i.test(job.fundingTx) || typeof job.settlementTx !== "string" || !/^0x[0-9a-f]{64}$/i.test(job.settlementTx)) throw new Error("Invalid receipt job");
      const engine = job.engine.toLowerCase() as Address, id = BigInt(job.loanId);
      if (!deployments.some(d => d.dealVault === engine)) throw new Error("Engine not published");
      const [funding, settlement] = await Promise.all([client.getTransactionReceipt({ hash: job.fundingTx as Hex }), client.getTransactionReceipt({ hash: job.settlementTx as Hex })]);
      if (funding.status !== "success" || settlement.status !== "success" || settlement.blockNumber < funding.blockNumber || head < settlement.blockNumber + 20n) throw new Error("Receipts are unsuccessful, unordered or insufficiently confirmed");
      const activated = parseEventLogs({ abi, eventName: "Activated", logs: funding.logs.filter(l => l.address.toLowerCase() === engine) }).find(l => l.args.id === id);
      const closed = parseEventLogs({ abi, eventName: "Closed", logs: settlement.logs.filter(l => l.address.toLowerCase() === engine) }).find(l => l.args.id === id);
      if (!activated || !closed || ![3, 4].includes(closed.args.state)) throw new Error("Matching activation and repayment/collateral settlement events required");
      const [fundingBlock, settlementBlock, loan, lenders] = await Promise.all([
        client.getBlock({ blockNumber: funding.blockNumber }), client.getBlock({ blockNumber: settlement.blockNumber }),
        client.readContract({ address: engine, abi, functionName: "getLoan", args: [id], blockNumber: funding.blockNumber }),
        client.readContract({ address: engine, abi, functionName: "lenders", args: [id], blockNumber: funding.blockNumber }),
      ]);
      if (fundingBlock.hash !== funding.blockHash || settlementBlock.hash !== settlement.blockHash || loan.state !== 2 || loan.filled !== 4
        || loan.fundedAt !== activated.args.fundedAt || BigInt(loan.fundedAt) !== fundingBlock.timestamp || BigInt(closed.args.closedAt) !== settlementBlock.timestamp) throw new Error("Receipt state does not reconcile");
      if (lenders.some(l => BigInt(l) === 0n || l.toLowerCase() === loan.originator.toLowerCase())) throw new Error("Empty or self-funded lender slots");
      const fundedAt = Number(fundingBlock.timestamp);
      const matching = store.observations(fundedAt - 120, fundedAt).find(value => {
        const observation = value as { model?: string; chainId?: number; engine?: string; grade?: string; at?: number; evidence?: { block?: string }; input?: Record<string, string> };
        const input = observation.input;
        if (!input || observation.model !== MODEL || observation.chainId !== chainId || observation.engine !== engine || observation.grade === "NR" || input.mode !== "loan"
          || observation.at === undefined || observation.at >= fundedAt || !observation.evidence?.block || BigInt(observation.evidence.block) >= funding.blockNumber
          || input.loanId !== id.toString() || input.principal !== loan.principal.toString() || input.repayment !== loan.cap.toString()
          || input.collateral !== loan.collateral.toString() || Number(input.term) !== loan.term) return false;
        if (loan.kind === 0) return input.token?.toLowerCase() === loan.token.toLowerCase();
        if (!input.poolId || !/^0x[0-9a-f]{64}$/i.test(input.poolId)) return false;
        return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [loan.kind, input.poolId as Hex])) === loan.exposureKey;
      }) as { grade: Grade; at: number } | undefined;
      if (!matching || !(GRADES as readonly string[]).includes(matching.grade)) throw new Error("No matching fresh pre-funding assessment; history is never backfilled");
      outcomes.push({ chainId, engine, loanId: id.toString(), fundingTx: job.fundingTx, settlementTx: job.settlementTx,
        borrower: loan.originator, lender: lenders[0]!, cohort: `${loan.kind}:${loan.kind === 0 ? loan.token.toLowerCase() : loan.exposureKey}:${loan.term}`, model: MODEL, grade: matching.grade,
        snapshotAt: matching.at, fundedAt, settledAt: Number(settlementBlock.timestamp), principal: (((loan.principal + 3n) / 4n) * 4n).toString(),
        recovery: closed.args.state === 3 ? loan.cap.toString() : "0", costs: "0", kind: closed.args.state === 3 ? "repaid" : "collateral-held", independentlyVerified: true });
    } catch (error) { excluded.push({ index, reason: error instanceof Error ? error.message : "Evidence unavailable" }); }
  }
} finally { store.close(); }
// stdout can feed evaluate; exclusions go to stderr and cannot be mistaken for training rows.
console.log(JSON.stringify(outcomes, null, 2));
console.error(JSON.stringify({ excluded, note: "Whole-loan USDG credits before gas. Collateral-held observations remain unresolved; realized sales need separate receipt-backed attribution." }, null, 2));
