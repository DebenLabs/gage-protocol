# Source publication notes

This repository was created independently with a clean first commit from internal source revision `1481f074158781c5a95ff97b2867ecf669131750`. It is intended to be handed over privately; the owner controls any later change to public visibility.

## Selection

The source selection includes the complete Gage contract source tree, local tests and fixtures, optional Earn reserve integration tests, Solidity deployment scripts, four supporting services and their tests, public address snapshots and selected local rehearsal/accounting scripts. The default test suite never invokes a live-chain fork.

Excluded material includes the old Git history and repository metadata, untracked workspace files, environment secrets, hosting administration, production signing orchestration, internal reports, customer/support data, raw execution journals, generated broadcasts, private deployment receipts, unrelated media and historic market-specific investigations. Submodules refer only to public upstream repositories.

## Packaging changes

- Gage Solidity SPDX headers changed from `UNLICENSED` to `MIT`; the owner selected MIT for original Gage code.
- A standalone workspace, pinned dependency lockfile and CI workflow replace the private monorepo's deployment workflow.
- One valuation test's inert public deployment fixture was relocated from an internal report directory into `services/valuation/test/fixtures`; its test import was updated.
- The receipt unit test resolves its existing `viem` dependency from the included keeper package instead of the omitted frontend package.
- Arithmetic ports retain explicit Uniswap attribution and license notices.
- Audit documentation, build helpers, publication validation and source provenance were added for this repository.

Contract executable source is preserved apart from license-header changes. SOURCE_MANIFEST.json records the source blob and SHA-256 plus the exported hash for each selected file and identifies packaging transformations. It does not import historical commits.

## Secret review

The preparation process scans the proposed source export and its new Git history. Gitleaks runs in CI with default detectors plus an EVM signing-key assignment rule. The only configured exception is an exact 20-byte public EVM address reported by the generic API-key detector; there are no path-wide or private-key exceptions. Reports and historical findings are kept outside this repository. The export scan covers the files committed to this repository; the public upstream submodule histories are separate dependencies.

The reachable internal history was also scanned privately with Gitleaks and with TruffleHog in offline mode, without credential verification. Findings were triaged without exercising credentials. A clean source export does not revoke any credential and is not a guarantee that historical copies or unreachable objects contain no secrets.

## Subsequent releases

1. Select a specific internal commit. Review source changes and the publication boundary before copying anything.
2. Run `scripts/export-source.py /path/to/internal/repository COMMIT /path/to/empty/directory` to reproduce the selected source set. It accepts only paths already recorded in SOURCE_MANIFEST.json, applies the documented transformations and copies the public packaging files from this repository. Adding a component requires explicit selection and dependency review.
3. Review the proposed changes, prune/update the workspace lockfile as necessary, and regenerate SOURCE_MANIFEST.json. Do not copy `.git`, old branches or unrelated files.
4. Run the build, tests, publication validator and secret scans before committing or pushing. Record a new immutable audit/release tag for each approved snapshot.
5. Keep existing audit tags fixed. Document which later changes require additional auditor review.

Public-source CI has read-only repository permissions, uses pinned actions, and has no deployment or signing credentials.
