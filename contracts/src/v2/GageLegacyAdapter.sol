// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IDealVault} from "../interfaces/IDealVault.sol";
import {DealRewards} from "../token/DealRewards.sol";
import {Deal, Kind} from "../types/Types.sol";
import {GageLegacyParty} from "./GageLegacyParty.sol";
import {GageV2CollateralAccount} from "./GageV2CollateralAccount.sol";

interface IGageAdapterEngine {
    function USDG() external view returns (address);
    function SGAGE() external view returns (address);
    function BRIDGE() external view returns (address);
    function GRACE() external view returns (uint32);
    function REWARDS() external view returns (address);
}

interface IGageLegacyCashIdentity {
    function USDG() external view returns (address);
}

/// @notice Stable, restricted legacy receipt and reward source for explicitly selected immutable engines.
/// @dev Engine selection affects new loans only. Each loan permanently binds its engine, account and reward ledger.
contract GageLegacyAdapter is ERC20, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public immutable ADMIN;
    IDealVault public immutable VAULT;
    DealRewards public immutable REWARDS;
    IERC20 public immutable USDG;
    IERC20 public immutable SGAGE;
    address public immutable PARTY_IMPLEMENTATION;
    address public activeEngine;
    uint256 public loanCount;
    uint256 public recycledFree;

    struct Loan {
        address engine;
        address ledger;
        address account;
        address borrower;
        address lender;
        uint256 engineId;
        uint256 legacyId;
        uint128 cap;
        uint128 borrowerReward;
        uint128 lenderReward;
        uint40 start;
        uint40 closedAt;
        uint32 term;
        uint256 liquid;
        uint256 paid;
    }

    mapping(uint256 => Loan) private _loans;
    mapping(address => mapping(uint256 => uint256)) public adapterId;
    mapping(address => uint256) public partyLoan;
    mapping(address => bool) public pledgedAccount;

    error NotAdmin();
    error NotActiveEngine();
    error WrongEngine();
    error NotLedger();
    error InvalidConfiguration();
    error InvalidLoan();
    error InvalidBacking();
    error RestrictedReceipt();
    error CashMismatch();
    error ExcessClaim();

    event EngineSelected(address indexed previousEngine, address indexed engine);
    event LoanOpened(
        uint256 indexed id,
        address indexed engine,
        uint256 indexed engineId,
        uint256 legacyId,
        address account,
        address borrower,
        address lender,
        uint128 borrowerReward,
        uint128 lenderReward
    );
    event LoanClosed(uint256 indexed id, bool repaid, uint40 closedAt);
    event RewardsHarvested(uint256 indexed id, uint256 amount);
    event RewardsPaid(uint256 indexed id, address indexed ledger, uint256 amount);
    event RewardsRecycled(uint256 indexed id, uint256 amount);

    constructor(address admin, IDealVault vault, DealRewards rewards, IERC20 usdg)
        ERC20("Gage internal collateral receipt", "GAGE-RECEIPT")
    {
        if (
            admin == address(0) || address(vault).code.length == 0 || address(rewards).code.length == 0
                || address(usdg).code.length == 0 || address(rewards.VAULT()) != address(vault)
                || IGageLegacyCashIdentity(address(vault)).USDG() != address(usdg)
        ) revert InvalidConfiguration();
        ADMIN = admin;
        VAULT = vault;
        REWARDS = rewards;
        USDG = usdg;
        SGAGE = rewards.SGAGE();
        PARTY_IMPLEMENTATION = address(new GageLegacyParty(vault, rewards, usdg));
    }

    /// @notice Select the only engine allowed to create new loans, or zero to stop originations.
    function setEngine(address engine) external {
        if (msg.sender != ADMIN) revert NotAdmin();
        if (engine != address(0)) {
            IGageAdapterEngine e = IGageAdapterEngine(engine);
            if (
                engine.code.length == 0 || e.BRIDGE() != address(this) || e.USDG() != address(USDG)
                    || e.SGAGE() != address(SGAGE) || e.GRACE() != VAULT.GRACE() || e.REWARDS().code.length == 0
            ) revert InvalidConfiguration();
        }
        emit EngineSelected(activeEngine, engine);
        activeEngine = engine;
    }

    /// @notice Quote the current available allocation, including already unlocked recycled rewards.
    /// @dev Availability is checked again during the atomic fourth-quarter activation.
    function quote(uint32 term, uint128 fee) public view returns (uint128 borrower, uint128 lender) {
        (uint128 legacy, uint256 epoch,,) = REWARDS.quote(term, fee);
        if (term != 7 days && term != 21 days) return (0, 0);
        DealRewards.EpochRates memory rates = REWARDS.effectiveRates(epoch);
        uint256 maximum;
        if (rates.set && rates.priceUSDGPerSGAGE != 0 && epoch < REWARDS.EMISSIONS().WEEKS()) {
            maximum = Math.min(
                Math.mulDiv(fee, term == 7 days ? rates.rate7 : rates.rate21, REWARDS.USDG_UNIT()),
                Math.mulDiv(uint256(fee) * 1e18, 8000, uint256(rates.priceUSDGPerSGAGE) * 10_000)
            );
        }
        uint256 total = uint256(legacy) + Math.min(recycledFree, maximum > legacy ? maximum - legacy : 0);
        // The existing reserve is finite; also bound any exceptionally large administrator-posted rate.
        total = Math.min(total, type(uint128).max);
        lender = uint128(Math.mulDiv(total, rates.lenderShareBps, 10_000));
        borrower = uint128(total - lender);
    }

    /// @notice Atomically back a receipt, list/fund V1, register its grant and return net principal to its engine.
    function open(uint256 engineId, address account, uint128 principal, uint128 cap, uint32 term, uint128 expectedFee)
        external
        nonReentrant
        returns (uint128 borrowerReward, uint128 lenderReward)
    {
        if (msg.sender != activeEngine) revert NotActiveEngine();
        if (
            engineId == 0 || adapterId[msg.sender][engineId] != 0 || principal < 4 || cap < principal
                || (term != 7 days && term != 21 days)
        ) revert InvalidLoan();
        _checkBacking(account);
        uint256 id = ++loanCount;
        adapterId[msg.sender][engineId] = id;
        pledgedAccount[account] = true;
        Loan storage l = _loans[id];
        l.engine = msg.sender;
        l.ledger = IGageAdapterEngine(msg.sender).REWARDS();
        l.engineId = engineId;
        l.account = account;
        l.cap = cap;
        l.term = term;
        l.start = uint40(block.timestamp);
        l.borrower = Clones.clone(PARTY_IMPLEMENTATION);
        l.lender = Clones.clone(PARTY_IMPLEMENTATION);
        partyLoan[l.borrower] = id;
        partyLoan[l.lender] = id;
        _mint(l.borrower, 1);
        _pullExact(USDG, msg.sender, l.lender, principal);
        l.legacyId = GageLegacyParty(l.borrower).list(principal, cap, term);
        GageLegacyParty(l.lender).fund(l.legacyId, principal);
        Deal memory d = VAULT.getDeal(l.legacyId);
        if (d.fee != expectedFee || d.price != principal || d.cap != cap || d.fundedAt != l.start) {
            revert CashMismatch();
        }
        // Quote before register consumes this loan's remaining legacy budget.
        (borrowerReward, lenderReward) = quote(term, d.fee);
        REWARDS.register(l.legacyId);
        (uint128 total, uint128 legacyLender, uint128 legacyBorrower) = REWARDS.rewardOf(l.legacyId);
        uint256 selected = uint256(borrowerReward) + lenderReward;
        // Registration is synchronous and must match the quoted legacy source, including zero allocations.
        if (selected < total || borrowerReward < legacyBorrower || lenderReward < legacyLender) revert InvalidLoan();
        l.liquid = selected - total;
        recycledFree -= l.liquid;
        l.borrowerReward = borrowerReward;
        l.lenderReward = lenderReward;
        uint256 proceeds = GageLegacyParty(l.borrower).withdrawCash();
        if (proceeds != uint256(principal) - d.fee) revert CashMismatch();
        USDG.safeTransfer(l.engine, proceeds);
        _emitOpened(id, l);
    }

    function _emitOpened(uint256 id, Loan storage l) private {
        emit LoanOpened(
            id, l.engine, l.engineId, l.legacyId, l.account, l.borrower, l.lender, l.borrowerReward, l.lenderReward
        );
    }

    /// @notice Settle V1 at its full cap and return repayment to the original engine's lender-credit ledger.
    function repay(uint256 engineId) external nonReentrant {
        (uint256 id, Loan storage l) = _engineLoan(engineId);
        l.closedAt = uint40(block.timestamp);
        _pullExact(USDG, msg.sender, l.borrower, l.cap);
        GageLegacyParty(l.borrower).repay(l.legacyId, l.cap);
        _burn(l.borrower, 1);
        uint256 repayment = GageLegacyParty(l.lender).withdrawCash();
        if (repayment != l.cap) revert CashMismatch();
        USDG.safeTransfer(l.engine, repayment);
        emit LoanClosed(id, true, l.closedAt);
    }

    /// @notice Settle the underlying default without selling or transferring the engine's collateral.
    function finalizeDefault(uint256 engineId) external nonReentrant {
        (uint256 id, Loan storage l) = _engineLoan(engineId);
        l.closedAt = uint40(block.timestamp);
        GageLegacyParty(l.lender).finalizeDefault(l.legacyId);
        _burn(l.lender, 1);
        emit LoanClosed(id, false, l.closedAt);
    }

    /// @notice Deliver only this loan's earned rewards to its permanently recorded reward ledger.
    /// @dev A few raw units can await the next source unlock because independent curves round separately.
    function pay(uint256 id, uint256 requested) external nonReentrant returns (uint256 amount) {
        Loan storage l = _loans[id];
        if (msg.sender != l.ledger || l.engine == address(0)) revert NotLedger();
        if (requested > _earned(l) - l.paid) revert ExcessClaim();
        _harvest(id, l);
        amount = Math.min(requested, l.liquid);
        l.paid += amount;
        l.liquid -= amount;
        if (amount != 0) SGAGE.safeTransfer(l.ledger, amount);
        emit RewardsPaid(id, l.ledger, amount);
    }

    /// @notice Harvest a closed loan and make only its unlocked surplus available to future eligible loans.
    function recycle(uint256 id) external nonReentrant returns (uint256 amount) {
        Loan storage l = _loans[id];
        if (l.closedAt == 0) revert InvalidLoan();
        _harvest(id, l);
        uint256 owed = _earned(l) - l.paid;
        if (l.liquid > owed) {
            amount = l.liquid - owed;
            l.liquid = owed;
            recycledFree += amount;
        }
        emit RewardsRecycled(id, amount);
    }

    /// @notice Complete source, authority and reward accounting for an adapter loan.
    function loan(uint256 id) external view returns (Loan memory) {
        return _loans[id];
    }

    function _engineLoan(uint256 engineId) private view returns (uint256 id, Loan storage l) {
        id = adapterId[msg.sender][engineId];
        l = _loans[id];
        if (id == 0 || l.engine != msg.sender) revert WrongEngine();
        if (l.closedAt != 0) revert InvalidLoan();
    }

    function _checkBacking(address account) private view {
        if (account.code.length == 0 || pledgedAccount[account]) revert InvalidBacking();
        GageV2CollateralAccount a = GageV2CollateralAccount(payable(account));
        if (a.vault() != msg.sender || a.released() || a.recovered()) revert InvalidBacking();
        (Kind kind, address token, uint256 amount) = a.collateral();
        if (amount == 0 || token == address(this) || token == address(SGAGE)) revert InvalidBacking();
        if (kind == Kind.ERC20) {
            if (IERC20(token).balanceOf(account) < amount) revert InvalidBacking();
        } else if (IERC721(token).ownerOf(amount) != account) {
            revert InvalidBacking();
        }
    }

    function _harvest(uint256 id, Loan storage l) private {
        uint256 amount = GageLegacyParty(l.borrower).harvest(l.legacyId) + GageLegacyParty(l.lender).harvest(l.legacyId);
        l.liquid += amount;
        emit RewardsHarvested(id, amount);
    }

    function _earned(Loan storage l) private view returns (uint256) {
        uint256 elapsed = Math.min((l.closedAt == 0 ? block.timestamp : l.closedAt) - l.start, l.term);
        uint256 square = elapsed * elapsed;
        uint256 denominator = uint256(l.term) * l.term;
        return Math.mulDiv(l.borrowerReward, square, denominator) + Math.mulDiv(l.lenderReward, square, denominator);
    }

    function _pullExact(IERC20 token, address from, address to, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        if (token.balanceOf(to) - beforeBalance != amount) revert CashMismatch();
    }

    function _update(address from, address to, uint256 value) internal override {
        bool minting = from == address(0) && partyLoan[to] != 0;
        bool burning = to == address(0) && partyLoan[from] != 0;
        bool depositing = to == address(VAULT) && msg.sender == address(VAULT) && partyLoan[from] != 0;
        bool withdrawing = from == address(VAULT) && msg.sender == address(VAULT) && partyLoan[to] != 0;
        if (value != 1 || (!minting && !burning && !depositing && !withdrawing)) revert RestrictedReceipt();
        super._update(from, to, value);
    }
}
