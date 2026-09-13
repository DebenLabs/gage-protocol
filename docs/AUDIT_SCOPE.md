# Earn audit scope

The initial audit snapshot is exported from source commit `1481f074158781c5a95ff97b2867ecf669131750`. Use the `audit-2026-09-13` tag and record its resolved Git commit in any audit report. Changes after that commit are outside that frozen snapshot unless the engagement explicitly includes them.

## Primary scope

| Component | Audit responsibility |
| --- | --- |
| `contracts/src/HybridVault.sol` | Pooled USDG share accounting, deposits and redemptions, withdrawal queue, reserve movements, loan approvals and funding, settlement, collateral/recovery pockets, rewards and high-water-mark fee accrual |
| `contracts/src/HybridFactory.sol` | Vault creation-code identity, atomic instance creation and fee-companion wiring, creation authorization and instance registry |
| `contracts/src/HybridFees.sol` | Strategy-only fee distribution and curator/protocol withdrawal entitlements |
| `contracts/src/v2/` | Native lending engine, fractional lender units, collateral custody and validation, rewards, registry, legacy connections and entry/cashout/zap routers |
| `contracts/src/libraries`, `interfaces`, `types`, `token` | Transitive dependencies and connected assets, claims, adapters and fee/reward routes |

The entire `contracts/src` tree is included so reviewers can follow dependencies beyond the three Earn entry points. Testnet contracts and legacy implementations are supporting context; inclusion does not mean that each one is currently deployed or in the engagement's economic scope.

## Supporting implementation

- `services/keeper/src/jobs/earn.ts`, `earn-indexer.ts`, `transaction-journal.ts`, `sender.ts` and their imports: scheduling, queue servicing, loan maintenance and recovery after interrupted transactions.
- `services/indexer/src/earn.ts`, `src/api/earn.ts`, `src/lib/earn-api.ts`, the schema, event handlers and ABIs: discoverability and reconstruction of on-chain accounting.
- `shared/earn.*`: common Earn API types and contracts.
- `services/valuation`: collateral observations and underwriting information. These reads must be distinguished from the vault's accounting and authorization rules.
- `services/notifier`: Earn and other user notifications. Notification delivery does not confer authority to move depositor assets.
- `scripts/hybrid`: local construction and operation of the same factory, vault and fee companion using test assets.

The supporting services are included for review; the contract audit's final scope and effort remain an agreement between Gage and its auditors.

## External assumptions and source matching

USDG, the ERC-4626 reserve, approved collateral and external pool infrastructure have their own code, authority, liquidity and token-behavior assumptions. Public address snapshots are in `launch/live` and `contracts/addresses.json`. Bind an assessment to the actual selected instance, chain, block and deployed bytecode rather than relying on a label in the address book.

The compiler settings, imported dependency commits and source hashes are pinned here. This packaging verification did not establish a source-to-bytecode match against all deployed contracts. The release is not evidence that Earn's live configuration or liquidity has passed an audit.

## Review topics

Review share pricing across deposits, withdrawals, locked profit and realized losses; queue priority and bounded progress; reserve failure and liquidity behavior; native V2 lender-unit ownership; repayment/default/collateral recovery; high-water marks and fee snapshots; reward entitlement across share changes; factory wiring; and the separation of curator authority from depositor withdrawal rights.

The local tests include unit, fuzz, regression and invariant coverage. Passing them is supporting evidence, not an exhaustive security conclusion. Prior findings and engagement-specific confidential material should be supplied to the auditors through the agreed private channel.

## Outside this source release

The frontend, community/social service, support and faucet services, hosting administration, production signing orchestration, CI credentials, user data, raw operational journals, internal research reports and unrelated media are not included. The original monorepo history, issues, PRs, Actions logs, release assets and other repository metadata are not imported. Historic market-specific fork investigations are not part of this audit package.
