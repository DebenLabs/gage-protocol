// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Kind} from "../types/Types.sol";

enum V2State {
    NONE,
    FUNDING,
    ACTIVE,
    REPAID,
    DEFAULTED,
    CANCELLED
}

struct V2Loan {
    address originator;
    address account;
    address token;
    address collateralBeneficiary;
    Kind kind;
    V2State state;
    uint8 filled;
    uint32 term;
    uint40 fundingDeadline;
    uint40 fundedAt;
    uint40 closedAt;
    uint128 principal;
    uint128 cap;
    uint128 originationFee;
    uint128 borrowerReward;
    uint128 lenderReward;
    uint256 collateral;
    bytes32 exposureKey;
    uint256 exposureAmount;
}

struct V2Ask {
    uint128 price;
    uint40 deadline;
    uint16 feeBps;
    uint256 nonce;
}

/// @dev The low four bits identify exact lending quarters; the price buys the complete selected bundle.
struct V2LenderAsk {
    address seller;
    uint8 slots;
    uint128 price;
    uint40 deadline;
    uint16 feeBps;
    uint256 nonce;
}

struct V2LenderPurchase {
    address seller;
    address recipient;
    uint8 slots;
    uint128 price;
    uint16 maxFeeBps;
    uint256 nonce;
    uint256 minRemainingReward;
}
