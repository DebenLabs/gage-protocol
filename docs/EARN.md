# Earn accounting and operation

Earn is a pooled USDG strategy. Depositors hold nontransferable shares in one portfolio containing cash, reserve shares and funded Gage V2 loan principal. Review the implementation in `contracts/src/HybridVault.sol` for exact rounding, virtual balances, timing and guards.

## Assets and share prices

`fullAssets` combines cash, reserve shares converted to assets, and effective performing loan principal. Outstanding premium and estimated collateral resale value are not added as accrued profit. Matured unpaid or otherwise written-down principal is excluded according to the contract's loan-state rules.

`totalAssets` subtracts the currently locked part of realized profit from `fullAssets`. Deposits use the full asset basis; redemptions use the unlocked basis. Virtual assets/shares and integer rounding apply. Before changing share ownership, checkpoints record due loan outcomes and entitlements, so a source review must follow the checkpoint calls as well as the public entry points.

## Withdrawal flow

`redeem` and `withdraw` use immediately available cash and reserve liquidity. Amounts beyond available liquidity require a queued `requestRedeem`. Queued shares continue to belong to the holder and remain exposed to portfolio outcomes until served. Requests are serviced in order within bounded work limits; credited USDG is withdrawn with `claim`. A holder may cancel an outstanding request.

Funding must respect outstanding withdrawal requests. Reserve liquidity, loan maturity, settlement, external token restrictions and maintenance delays affect when funds become available. A queue position is not a guarantee of a particular payment time or cash amount.

## Loan and recovery accounting

The curator configures the permitted strategy mandate and approves purchases. The vault funds lender units through the native Gage V2 engine and records the principal acquired. Follow both contracts when reviewing partial funding, refunds, settlement, default and collateral delivery.

Repaid profit can be locked and gradually released into the redemption price. Written-down loans can later produce recoveries. Recovery pockets preserve entitlements for the share owners associated with the loss rather than treating recovered collateral as fresh USDG backing for later entrants. Depositors may receive collateral instead of USDG.

## Fees and rewards

The vault snapshots the applicable fee rate when funding a loan. Realized loan profit is subject to the strategy's high-water-mark accounting; fee accrual is not a fee on deposited principal. `HybridFees` separates the curator and protocol recipients' claims on the fees sent by its strategy.

sGAGE reward entitlement is tracked separately from USDG asset value and performance fees. Checkpoints and reward accounting must preserve ownership as balances change and as reward delivery succeeds or fails.

## Factory and operational roles

`HybridFactory` creates the strategy and fee companion and records registered instances. Review the factory's creation-code storage and constructor bindings alongside each created instance's immutable configuration.

The curator's admission, allocation, fee and pause controls are explicit protocol authority. Their exact limits are defined in the contracts. Maintenance calls and keeper scheduling must not be confused with the authority to select a depositor's payout recipient.

The keeper consumes indexed state, reads on-chain information and maintains a transaction journal. The indexer reconstructs the strategy, request, position, recovery and reward views. Both are supporting infrastructure; on-chain accounting and authorization remain separate review surfaces.
