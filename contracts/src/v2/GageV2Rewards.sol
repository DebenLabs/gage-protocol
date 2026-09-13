// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Separately funded V2 rewards; immutable vault callbacks only perform accounting, never token transfers.
contract GageV2Rewards is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public immutable VAULT;
    IERC20 public immutable SGAGE;

    struct Allocation {
        address borrower;
        uint40 start;
        uint40 end;
        uint32 term;
        uint128 borrowerTotal;
        uint128 lenderTotal;
        uint128 borrowerAccounted;
        address[4] lenders;
    }

    mapping(uint256 => Allocation) private _allocations;
    mapping(uint256 => mapping(address => uint256)) private _earnedBorrower;
    mapping(uint256 => mapping(address => uint256)) private _earnedLender;
    mapping(uint256 => uint128[4]) private _lenderAccounted;
    mapping(uint256 => mapping(address => uint256)) private _claimed;
    uint256 internal _free;
    uint256 internal _reserved;

    error NotVault();
    error InvalidState();
    error InsufficientBudget();
    error NothingToClaim();
    error InvalidTransfer();

    event Funded(address indexed funder, uint256 amount);
    event Reserved(uint256 indexed id, uint256 amount);
    event Recycled(uint256 indexed id, uint256 amount);
    event Claimed(uint256 indexed id, address indexed account, address indexed recipient, uint256 amount);

    constructor(IERC20 sgage) {
        VAULT = msg.sender;
        SGAGE = sgage;
    }

    modifier onlyVault() {
        if (msg.sender != VAULT) revert NotVault();
        _;
    }

    /// @notice Irrevocably add separately sourced sGAGE to the free reward budget.
    function fund(uint256 amount) external virtual nonReentrant {
        if (amount == 0) revert InvalidTransfer();
        uint256 beforeBalance = SGAGE.balanceOf(address(this));
        SGAGE.safeTransferFrom(msg.sender, address(this), amount);
        if (SGAGE.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTransfer();
        _free += amount;
        emit Funded(msg.sender, amount);
    }

    /// @notice Reserve a fully backed allocation exactly when the fourth lender unit activates a loan.
    function activate(
        uint256 id,
        address borrower,
        address[4] calldata lenders,
        uint32 term,
        uint128 borrowerReward,
        uint128 lenderReward
    ) external onlyVault {
        if (_allocations[id].start != 0 || borrower == address(0) || term == 0) {
            revert InvalidState();
        }
        uint256 total = uint256(borrowerReward) + lenderReward;
        _reserve(id, borrowerReward, lenderReward);
        Allocation storage a = _allocations[id];
        a.borrower = borrower;
        a.start = uint40(block.timestamp);
        a.term = term;
        a.borrowerTotal = borrowerReward;
        a.lenderTotal = lenderReward;
        a.lenders = lenders;
        emit Reserved(id, total);
    }

    /// @notice Preserve the seller's earned allocation and assign only future accrual to the buyer.
    function transferRight(uint256 id, address buyer) external onlyVault {
        Allocation storage a = _allocations[id];
        if (a.start == 0 || a.end != 0 || buyer == address(0)) revert InvalidState();
        _checkpoint(id, a);
        a.borrower = buyer;
    }

    /// @notice Checkpoint the exact quarters sold; only their future accrual changes owner.
    function transferLender(uint256 id, address seller, address buyer, uint8 slots) external onlyVault {
        Allocation storage a = _allocations[id];
        if (a.start == 0 || a.end != 0 || buyer == address(0) || slots == 0 || slots > 15) {
            revert InvalidTransfer();
        }
        uint256 earned = _curve(a.lenderTotal, a);
        for (uint8 i; i < 4; ++i) {
            if (slots & (1 << i) == 0) continue;
            if (a.lenders[i] != seller) revert InvalidTransfer();
            uint256 slice = _slice(earned, i);
            _earnedLender[id][seller] += slice - _lenderAccounted[id][i];
            _lenderAccounted[id][i] = uint128(slice);
            a.lenders[i] = buyer;
        }
    }

    /// @notice Maximum future rewards of these quarters, before any early-close cutoff.
    function remainingLenderReward(uint256 id, uint8 slots) external view returns (uint256 remaining) {
        if (slots == 0 || slots > 15) revert InvalidTransfer();
        Allocation storage a = _allocations[id];
        if (a.start == 0 || a.end != 0) return 0;
        uint256 earned = _curve(a.lenderTotal, a);
        for (uint8 i; i < 4; ++i) {
            if (slots & (1 << i) != 0) remaining += _slice(a.lenderTotal, i) - _slice(earned, i);
        }
    }

    /// @notice Freeze the original quadratic clock and recycle its unearned portion, without any token call.
    function close(uint256 id) external onlyVault {
        Allocation storage a = _allocations[id];
        if (a.start == 0 || a.end != 0) revert InvalidState();
        a.end = uint40(block.timestamp);
        _checkpoint(id, a);
        uint256 recycled =
            uint256(a.borrowerTotal) + a.lenderTotal - _curve(a.borrowerTotal, a) - _curve(a.lenderTotal, a);
        _release(id, recycled);
        emit Recycled(id, recycled);
    }

    /// @notice Withdraw earned rewards to a chosen recipient; permissionless claims for another account cannot redirect funds.
    function claim(uint256 id, address recipient) external nonReentrant {
        _claim(id, msg.sender, recipient);
    }
    /// @notice Deliver another account's rewards directly to that account.

    function claimFor(uint256 id, address account) external nonReentrant {
        _claim(id, account, account);
    }
    /// @notice Available budget and outstanding reward liability.

    function budget() external view returns (uint256 free, uint256 reserved) {
        return (_free, _reserved);
    }
    /// @notice Complete reward snapshot for indexers and claim previews.

    function allocation(uint256 id) external view returns (Allocation memory) {
        return _allocations[id];
    }
    /// @notice Earned borrower plus lender rewards, less this account's previous withdrawals.

    function claimable(uint256 id, address account) public view returns (uint256) {
        Allocation storage a = _allocations[id];
        if (a.start == 0 || account == address(0)) return 0;
        uint256 earned = _earnedBorrower[id][account] + _earnedLender[id][account];
        if (a.end == 0 && a.borrower == account) earned += _curve(a.borrowerTotal, a) - a.borrowerAccounted;
        uint256 lender = _curve(a.lenderTotal, a);
        for (uint8 i; i < 4; ++i) {
            if (a.lenders[i] == account) earned += _slice(lender, i) - _lenderAccounted[id][i];
        }
        return earned - _claimed[id][account];
    }

    function _claim(uint256 id, address account, address recipient) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidTransfer();
        uint256 amount = claimable(id, account);
        if (amount == 0) revert NothingToClaim();
        amount = _prepareClaim(id, amount);
        if (amount == 0) revert NothingToClaim();
        _claimed[id][account] += amount;
        _reserved -= amount;
        SGAGE.safeTransfer(recipient, amount);
        emit Claimed(id, account, recipient, amount);
    }

    function _reserve(uint256, uint128 borrower, uint128 lender) internal virtual {
        uint256 total = uint256(borrower) + lender;
        if (total > _free) revert InsufficientBudget();
        _free -= total;
        _reserved += total;
    }

    function _release(uint256, uint256 amount) internal virtual {
        _reserved -= amount;
        _free += amount;
    }

    function _prepareClaim(uint256, uint256 amount) internal virtual returns (uint256) {
        return amount;
    }

    function _checkpoint(uint256 id, Allocation storage a) private {
        uint256 earned = _curve(a.borrowerTotal, a);
        _earnedBorrower[id][a.borrower] += earned - a.borrowerAccounted;
        a.borrowerAccounted = uint128(earned);
    }

    function _curve(uint256 amount, Allocation storage a) private view returns (uint256) {
        uint256 elapsed = Math.min((a.end == 0 ? block.timestamp : a.end) - a.start, a.term);
        return Math.mulDiv(amount, elapsed * elapsed, uint256(a.term) * a.term);
    }

    function _slice(uint256 total, uint8 i) private pure returns (uint256) {
        return total / 4 + (i < total % 4 ? 1 : 0);
    }
}
