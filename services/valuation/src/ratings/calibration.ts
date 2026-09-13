import { GRADES, MODEL, type Grade } from "./model.js";

/** Produced by an independently verified chain/outcome export, never accepted from browser interactions. */
export type Outcome = {
  chainId: number; engine: string; loanId: string; fundingTx: string; settlementTx: string;
  borrower: string; lender: string; cohort: string; model: string; grade: Grade;
  snapshotAt: number; fundedAt: number; settledAt: number;
  principal: string; recovery: string; costs: string;
  kind: "repaid" | "collateral-sold" | "collateral-held" | "quote";
  independentlyVerified: boolean;
};
const address = /^0x[a-fA-F0-9]{40}$/;
const tx = /^0x[a-fA-F0-9]{64}$/;
const raw = /^\d{1,78}$/;
/** Wilson interval describes the observed sample only; correlated loans can make it overconfident. */
export function wilson(losses: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96, p = losses / n, denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function evaluateOutcomes(rows: readonly Outcome[], cutoff: number) {
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) throw new Error("A chronological cutoff is required");
  const excluded: Record<string, number> = {};
  const groups = new Map<string, { partition: string; grade: Grade; cohort: string; n: number; losses: number; principal: bigint; loss: bigint; borrowers: Set<string> }>();
  const seen = new Set<string>();
  for (const r of rows) {
    let reason: string | undefined;
    if (!r || !Number.isSafeInteger(r.chainId) || r.chainId <= 0 || !address.test(r.engine) || !/^\d+$/.test(r.loanId) || !tx.test(r.fundingTx) || !tx.test(r.settlementTx)
      || !address.test(r.borrower) || !address.test(r.lender) || !raw.test(r.principal) || !raw.test(r.recovery) || !raw.test(r.costs)
      || !Number.isSafeInteger(r.snapshotAt) || !Number.isSafeInteger(r.fundedAt) || !Number.isSafeInteger(r.settledAt)
      || !r.cohort || r.cohort.length > 100 || r.model !== MODEL || r.grade === "NR" || !(GRADES as readonly string[]).includes(r.grade)) reason = "invalid or incompatible record";
    else if (!r.independentlyVerified) reason = "unverified evidence";
    else if (r.borrower.toLowerCase() === r.lender.toLowerCase()) reason = "self-funded";
    else if (r.kind !== "repaid" && r.kind !== "collateral-sold") reason = "recovery is not realized";
    else if (r.snapshotAt > r.fundedAt || r.fundedAt - r.snapshotAt > 120 || r.settledAt < r.fundedAt) reason = "missing fresh funding-time snapshot";
    else if (BigInt(r.principal) <= 0n) reason = "zero principal";
    // Training may use only outcomes already known at cutoff. Later-settled training loans are censored.
    else if (r.fundedAt < cutoff && r.settledAt >= cutoff) reason = "unresolved at training cutoff";
    if (reason) { excluded[reason] = (excluded[reason] ?? 0) + 1; continue; }
    const identity = `${r.chainId}:${r.engine.toLowerCase()}:${r.loanId}`;
    if (seen.has(identity)) { excluded["duplicate loan"] = (excluded["duplicate loan"] ?? 0) + 1; continue; }
    seen.add(identity);
    const partition = r.fundedAt < cutoff ? "training" : "holdout";
    const cohort = `${r.chainId}:${r.cohort}`;
    const key = `${partition}:${r.grade}:${cohort}`;
    const group = groups.get(key) ?? { partition, grade: r.grade, cohort, n: 0, losses: 0, principal: 0n, loss: 0n, borrowers: new Set<string>() };
    const principal = BigInt(r.principal), recovered = BigInt(r.recovery) - BigInt(r.costs);
    const net = recovered > 0n ? recovered : 0n;
    const loss = principal > net ? principal - net : 0n;
    group.n++; group.losses += loss > 0n ? 1 : 0; group.principal += principal; group.loss += loss; group.borrowers.add(r.borrower.toLowerCase());
    groups.set(key, group);
  }
  return { model: MODEL, cutoff, excluded, promotion: "manual-review-required", groups: [...groups.values()].map(g => ({
    partition: g.partition, grade: g.grade, cohort: g.cohort, loans: g.n, distinctBorrowerAddresses: g.borrowers.size,
    lossEvents: g.losses, principal: g.principal.toString(), realizedLoss: g.loss.toString(),
    realizedLossBps: (g.loss * 10_000n / g.principal).toString(), observedLossInterval95: wilson(g.losses, g.n),
  })), limitations: ["No automatic promotion or rating changes.", "Wallet addresses do not prove independent people.", "A completed-loan sample can understate losses while slow recoveries remain unresolved.", "Validate by asset, vintage and term on held-out time periods before changing the model."] };
}
