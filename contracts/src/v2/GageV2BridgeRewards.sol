// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GageV2Rewards} from "./GageV2Rewards.sol";
import {GageLegacyAdapter} from "./GageLegacyAdapter.sol";

/// @notice The tested V2 ownership/quarter ledger, backed by a specific legacy grant and reserved recycled cash.
/// @dev Closing only updates accounting. Neither SGAGE transfers nor harvesting can block collateral repayment.
contract GageV2BridgeRewards is GageV2Rewards {
    GageLegacyAdapter public immutable BRIDGE;
    mapping(uint256 => uint256) public sourceId;

    constructor(IERC20 sgage, GageLegacyAdapter bridge) GageV2Rewards(sgage) {
        BRIDGE = bridge;
    }

    /// @notice Donations must use the stable source's recycling path; this ledger cannot invent a new allocation.
    function fund(uint256) external pure override {
        revert InvalidTransfer();
    }

    function _reserve(uint256 id, uint128 borrower, uint128 lender) internal override {
        uint256 bridgeId = BRIDGE.adapterId(VAULT, id);
        GageLegacyAdapter.Loan memory l = BRIDGE.loan(bridgeId);
        if (
            bridgeId == 0 || l.ledger != address(this) || l.engine != VAULT || l.start != block.timestamp
                || l.borrowerReward != borrower || l.lenderReward != lender
        ) revert InvalidState();
        sourceId[id] = bridgeId;
        _reserved += uint256(borrower) + lender;
    }

    function _release(uint256 id, uint256 amount) internal override {
        if (BRIDGE.loan(sourceId[id]).closedAt != block.timestamp) revert InvalidState();
        // Unearned future drips are not liquid today. The source exposes only harvested surplus as reusable.
        _reserved -= amount;
    }

    function _prepareClaim(uint256 id, uint256 amount) internal override returns (uint256) {
        return BRIDGE.pay(sourceId[id], amount);
    }
}
