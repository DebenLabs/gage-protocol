# Gage protocol

Gage is a lending protocol on Robinhood Chain. This repository contains its smart contracts and the supporting services needed to review **Earn**, a pooled USDG strategy that allocates assets between an ERC-4626 reserve and Gage V2 loans.

Start with [the audit scope](docs/AUDIT_SCOPE.md), [Earn accounting](docs/EARN.md), and [verification results](docs/VERIFICATION.md). This is a source release prepared for review; it is not an audit report or a deployment authorization.

## Contents

| Directory | Contents |
| --- | --- |
| `contracts/src` | Earn vault, factory and fees; native V2 lending; connected adapters, routers and token contracts |
| `contracts/test` | Local unit, regression, fuzz and invariant tests, plus optional Earn reserve integration tests |
| `contracts/script` | Solidity deployment and local rehearsal scripts |
| `services/keeper` | Maintenance, transaction recovery and Earn queue servicing |
| `services/indexer` | Event accounting, strategy discovery and read API |
| `services/valuation` | Collateral facts, quotes and loan ratings |
| `services/notifier` | Notification implementation and tests; no subscriber database or credentials |
| `scripts/hybrid` | Isolated local Earn fixture and lifecycle tools |
| `launch/live` | Public deployment-address snapshots |

## Build and test

Use Node.js 22, pnpm 9.14.4, Python 3.12 or newer, and Foundry `nightly-5e88010a83d1b87b8f4d13058e42a2949d3e9dc0`. Solidity is pinned to 0.8.28 in `contracts/foundry.toml`.

```sh
git clone --recurse-submodules https://github.com/DebenLabs/gage-protocol.git
cd gage-protocol
corepack enable
corepack prepare pnpm@9.14.4 --activate
pnpm install --frozen-lockfile --ignore-scripts
pnpm contracts:build
pnpm contracts:test
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:scripts
pnpm check:publication
```

If submodules were omitted when cloning, run `git submodule update --init --recursive`. Install the pinned Foundry release with `foundryup --install nightly-5e88010a83d1b87b8f4d13058e42a2949d3e9dc0`.

The default tests require no signing key, funded wallet, database server, or private RPC. `pnpm contracts:build` also builds the external Uniswap and Permit2 artifacts used by the local fixtures. Reserve integration tests in `contracts/test/fork` are excluded from the default test command and from CI; their source is included for the audit. See [verification](docs/VERIFICATION.md) for the limits of the recorded checks.

Service configuration templates are `.env.example` files. The keeper defaults to dry-run operation with an empty signing key. The public-address snapshots are reference data, not a claim that every source file matches every currently deployed instance.

## Source identity and maintenance

The initial release was exported from one pinned internal source commit with no inherited Git history. [SOURCE_MANIFEST.json](SOURCE_MANIFEST.json) records source and exported hashes for each selected file. Packaging changes are described in [the publication notes](docs/PUBLICATION.md). The immutable `audit-2026-09-13` tag identifies this audit handoff.

Future updates must use the reviewed export procedure or land as reviewable changes in this repository. Do not merge the internal monorepo or copy its Git directory into this repository.

## License and security

Gage's original code is [MIT licensed](LICENSE). Third-party code retains its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), including the mixed MIT/BUSL-1.1 licensing in the pinned Uniswap v4-core dependency.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md). Do not put vulnerability details or credentials in public issues.
