# Verification of the initial source release

Source baseline: `1481f074158781c5a95ff97b2867ecf669131750`. The frozen public-source snapshot is identified by the `audit-2026-09-13` tag. These checks validate the extracted repository and its existing tests; they do not constitute an independent contract audit.

## Recorded local checks

| Check | Result |
| --- | --- |
| Recursive submodule initialization from public upstreams | Passed with the recorded commit pins |
| Standalone frozen pnpm installation | Passed |
| Solidity formatting | Passed |
| Pinned external-artifact and Gage build | Passed with Solidity 0.8.28 and the pinned Foundry release |
| Local contract unit, regression, fuzz and invariant tests | 687 passed; zero failed or skipped |
| Indexer tests | 259 passed |
| Keeper tests | 240 passed initially; 13 ABI comparisons skipped until compiler artifacts existed |
| Keeper ABI comparisons after the contract build | All 13 passed |
| Valuation tests | 153 passed |
| Notifier tests | 64 passed |
| Selected local-runtime, mandate and receipt script tests | 28 passed |
| Service builds, type checks and lint | Passed for all four services |
| Same-revision re-export | All 489 selected source files reproduced byte-for-byte |

The combined local result is **1,444 passing tests**, including the 13 ABI comparisons run after compilation. The test counts include fuzz/invariant test functions; individual generated cases are not counted as separate tests here.

The [GitHub workflow](../.github/workflows/ci.yml) runs publication validation and Gitleaks, builds/tests the contracts, checks keeper ABIs against the compiled artifacts, and builds/type-checks/lints/tests the supporting services from fresh checkouts. Consult the [Actions run](https://github.com/DebenLabs/gage-protocol/actions) for the status of a particular commit. The local JavaScript checks ran on Node 23.3.0; CI uses Node 22, the documented baseline.

## Secret and publication review

The selected source files were scanned with Gitleaks 8.30.1 and TruffleHog 3.95.6. The initial generic Gitleaks matches were public 20-byte token addresses. The sole scanner exception is limited to that value shape on that detector; the configured export scan returned no findings. Offline TruffleHog identified two deliberate user/password URL strings in local validation/redaction tests; both were reviewed as synthetic fixtures. No credentials were exercised or verified against providers.

The reachable internal Git history was scanned separately and kept private. Public addresses, public hashes, local test keys and infrastructure identifiers accounted for the reviewed historical matches. No production credential was confirmed by this review. The history scan does not cover unreachable/deleted remote objects, historical GitHub logs or every untracked workstation file; none of those are imported into this repository.

The publication validator checks source hashes, dependency pins, non-template environment files, private/generated paths, personal filesystem paths, unexpected binaries, license headers and documentation links. Source reports, scanner reports and production credentials are not included in the repository.

## Limits

- Optional reserve integration tests in `contracts/test/fork` were included as source but not executed for this packaging task. No current live-fork acceptance or reserve-liquidity result is claimed.
- No production deployment, signing, service reconfiguration or source-to-deployed-bytecode comparison was performed.
- Public address manifests are snapshots. Audit reports must identify the selected deployed instances and independently bind them to the code and configuration being assessed.
- Contract logic is preserved from the source revision except for SPDX license-header changes. Any audit findings or fixes require their own review and verification.
- Third-party dependencies retain their own licenses. This release does not change the licensing of Uniswap's BUSL-1.1 components.
