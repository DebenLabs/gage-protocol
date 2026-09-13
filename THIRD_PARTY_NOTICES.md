# Third-party notices

The root MIT license applies to Gage's original contributions. It does not replace the licenses of dependencies or third-party portions.

Solidity dependencies are Git submodules at immutable commits. Their license files, per-file SPDX notices and nested dependency notices remain in their original directories. Initialize submodules before building or redistributing a dependency tree.

| Dependency | Pinned commit | License location |
| --- | --- | --- |
| forge-std | `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` | `contracts/lib/forge-std/LICENSE-MIT`, `LICENSE-APACHE` |
| OpenZeppelin Contracts | `cab19933c33c2ad1d4c7a84864a3601dddfd16f3` | `contracts/lib/openzeppelin-contracts/LICENSE` and vendor notices |
| Uniswap v4-periphery | `dce236d4e2057422d0791d9a973a58765eb46f65` | `contracts/lib/v4-periphery/LICENSE` and per-file notices |
| Uniswap v4-core, nested | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` | `contracts/lib/v4-periphery/lib/v4-core/licenses/` and each source file's SPDX header |

The pinned v4-core dependency contains both MIT and BUSL-1.1 files, as its [upstream license section](https://github.com/Uniswap/v4-core/blob/59d3ecf53afa9264a16bba0e38f4c5d2231f80bc/README.md#license) explains. Gage is not relicensing the BUSL portions as MIT. Follow the applicable upstream terms when reusing third-party implementations; connecting to a deployed pool and redistributing or deploying its implementation are different activities.

The TypeScript arithmetic ports in `services/valuation/src/math/tickMath.ts`, `fullMath.ts`, `swap.ts` and `liquidityAmounts.ts` identify their Uniswap origins. The corresponding upstream TickMath, FullMath, FixedPoint96, SqrtPriceMath and LiquidityAmounts source files carry MIT notices at the pinned revisions. Copies of the relevant Uniswap MIT notices are included under `licenses/` for these ports.

Permit2, Solmate and other nested Solidity dependencies retain their own notices in the submodule tree. Node dependencies are pinned by `pnpm-lock.yaml`; their package license files remain authoritative. No `node_modules` directory or prebuilt third-party binary is committed here.
