// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Collateral kinds compiled into DealVault. Adding one means a new vault version, never an upgrade.
enum Kind {
    ERC20,
    UNIV4_POSITION,
    UNIV3_POSITION
}

/// @notice Deal states. NONE is the zero value of an unused id.
enum DealState {
    NONE,
    LISTED,
    FUNDED,
    RECLAIMED,
    CLAIMED,
    CANCELLED
}

/// @notice Bid states. Exactly one bid per deal ever becomes ACCEPTED.
enum BidState {
    NONE,
    OPEN,
    WITHDRAWN,
    ACCEPTED
}

/// @param kind Adapter that validates and custodies the collateral.
/// @param token ERC-20 address for Kind.ERC20; the PositionManager for Kind.UNIV4_POSITION.
/// @param amountOrTokenId Raw ERC-20 amount, or the position NFT id.
struct Collateral {
    Kind kind;
    address token;
    uint256 amountOrTokenId;
}

struct Deal {
    address borrower;
    Kind kind;
    DealState state;
    uint32 term;
    uint40 listingExpiry;
    address token;
    uint40 fundedAt;
    uint40 expiry;
    uint256 amountOrTokenId;
    uint128 cap;
    uint128 minPrice;
    address lender;
    uint128 price;
    /// @dev Protocol fee deducted at accept. Recorded so DealRewards pays on the fee actually paid.
    uint128 fee;
}

struct Bid {
    uint256 dealId;
    address lender;
    uint128 price;
    uint40 expiry;
    BidState state;
}

/// @notice Collateral lanes. Informational for the indexer and the screening service: the vault treats every
///         ERC-20 the same way. Memes pass spec 7.4 off-chain before they are allowlisted.
enum Lane {
    STOCK,
    ETH,
    MEME
}

/// @notice Assets a meme's Uniswap v4 pool may be paired with to qualify for the lane (spec open decision 23).
enum PairAsset {
    STOCK,
    USDG,
    ETH
}
