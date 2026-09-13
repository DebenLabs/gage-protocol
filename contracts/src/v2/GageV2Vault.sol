// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721, IERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Utils} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Utils.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Collateral, Kind} from "../types/Types.sol";
import {V2State, V2Loan, V2Ask, V2LenderAsk, V2LenderPurchase} from "./V2Types.sol";
import {GageV2Rewards} from "./GageV2Rewards.sol";
import {GageV2Registry} from "./GageV2Registry.sol";
import {GageV2CollateralValidator} from "./GageV2CollateralValidator.sol";
import {GageV2CollateralAccount} from "./GageV2CollateralAccount.sol";
import {GageLegacyAdapter} from "./GageLegacyAdapter.sol";
import {GageV2BridgeRewards} from "./GageV2BridgeRewards.sol";

/// @notice Four-unit loans with a single tradable reclaim right and independently withdrawable cash and rewards.
/// @dev Immutable custody: registry changes only gate new listings/funding, never repayment or recovery.
contract GageV2Vault is ERC721, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDG;
    IERC20 public immutable SGAGE;
    GageV2Registry public immutable REGISTRY;
    GageV2CollateralValidator public immutable VALIDATOR;
    GageV2Rewards public immutable REWARDS;
    GageLegacyAdapter public immutable BRIDGE;
    address public immutable ACCOUNT_IMPLEMENTATION;
    address public immutable FEE_RECIPIENT;
    uint32 public immutable GRACE;
    uint32 public constant MAX_FUNDING_WINDOW = 7 days;
    uint32 public constant MAX_EXECUTION_WINDOW = 15 minutes;
    uint32 public constant MAX_GRACE = 7 days;
    uint8 public constant UNITS = 4;

    uint256 private _nextId = 1;
    mapping(uint256 => V2Loan) private _loans;
    mapping(uint256 => address[4]) private _lenders;
    mapping(uint256 => V2Ask) private _asks;
    mapping(uint256 => uint256) private _nonces;
    mapping(uint256 => mapping(address => V2LenderAsk)) private _lenderAsks;
    mapping(uint256 => mapping(address => uint256)) private _lenderNonces;
    mapping(address => uint256) private _cashCredit;
    mapping(bytes32 => uint256) private _openExposure;
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) private _recoveryClaimed;
    uint256 private _accountedCash;
    bool private _marketTransfer;

    error InvalidConfiguration();
    error InvalidTerms();
    error WrongState();
    error Paused();
    error NotAuthorized();
    error Deadline();
    error InvalidUnits();
    error ExactTransferRequired();
    error ExposureCap();
    error UseMarketplace();
    error StaleAsk();
    error InvalidRecipient();
    error NothingToClaim();

    event Listed(
        uint256 indexed id,
        address indexed borrower,
        address account,
        Collateral collateral,
        uint128 principal,
        uint128 cap,
        uint32 term,
        uint40 fundingDeadline
    );
    event UnitsFunded(uint256 indexed id, address indexed lender, uint8 units, uint256 amount, uint8 filled);
    event CommitmentWithdrawn(uint256 indexed id, address indexed lender, uint8 units, uint256 amount);
    event Activated(uint256 indexed id, uint40 fundedAt, uint128 fee, uint128 borrowerReward, uint128 lenderReward);
    event Closed(uint256 indexed id, V2State state, address beneficiary, uint40 closedAt);
    event AskPosted(
        uint256 indexed id, address indexed seller, uint128 price, uint40 deadline, uint16 feeBps, uint256 nonce
    );
    event AskCancelled(uint256 indexed id, uint256 nonce);
    event RightSold(
        uint256 indexed id,
        address indexed seller,
        address indexed buyer,
        address recipient,
        uint128 price,
        uint256 fee,
        uint256 nonce
    );
    event CashWithdrawn(address indexed account, address indexed recipient, uint256 amount);
    event CollateralWithdrawn(uint256 indexed id, address indexed recipient);
    event DefaultRecovered(uint256 indexed id, address[2] tokens, uint256[2] amounts);
    event RecoveryWithdrawn(uint256 indexed id, address indexed lender, uint8 asset, address recipient, uint256 amount);
    event LenderAskPosted(
        uint256 indexed id,
        address indexed seller,
        uint8 slots,
        uint128 price,
        uint40 deadline,
        uint16 feeBps,
        uint256 nonce
    );
    event LenderAskCancelled(uint256 indexed id, address indexed seller, uint256 nonce);
    event LenderSold(
        uint256 indexed id,
        address indexed seller,
        address indexed buyer,
        address recipient,
        uint8 slots,
        uint128 price,
        uint256 fee,
        uint256 nonce
    );

    constructor(GageV2CollateralValidator validator, address feeRecipient, uint32 grace, GageLegacyAdapter bridge)
        ERC721("Gage V2 Reclaim Right", "GAGE-R")
    {
        if (address(validator).code.length == 0 || feeRecipient == address(0) || grace > MAX_GRACE) {
            revert InvalidConfiguration();
        }
        VALIDATOR = validator;
        REGISTRY = validator.REGISTRY();
        USDG = IERC20(validator.USDG());
        SGAGE = IERC20(validator.SGAGE());
        if (IERC20Metadata(address(USDG)).decimals() != 6 || IERC20Metadata(address(SGAGE)).decimals() != 18) {
            revert InvalidConfiguration();
        }
        FEE_RECIPIENT = feeRecipient;
        GRACE = grace;
        BRIDGE = bridge;
        if (address(bridge) != address(0)) {
            if (
                address(bridge.USDG()) != address(USDG) || address(bridge.SGAGE()) != address(SGAGE)
                    || bridge.VAULT().GRACE() != grace
            ) revert InvalidConfiguration();
            REWARDS = new GageV2BridgeRewards(SGAGE, bridge);
        } else {
            REWARDS = new GageV2Rewards(SGAGE);
        }
        ACCOUNT_IMPLEMENTATION = address(new GageV2CollateralAccount());
    }

    /// @notice Deposit whole collateral and post fixed terms, funded in exactly four units.
    function list(
        Collateral calldata c,
        uint128 principal,
        uint128 cap,
        uint32 term,
        uint40 fundingDeadline,
        bool withRewards
    ) external nonReentrant returns (uint256 id) {
        return _list(c, principal, cap, term, fundingDeadline, withRewards, msg.sender);
    }

    /// @notice An admitted entry router deposits its own collateral and assigns the complete right to its user.
    function listFor(
        Collateral calldata c,
        uint128 principal,
        uint128 cap,
        uint32 term,
        uint40 fundingDeadline,
        bool withRewards,
        address borrower
    ) external nonReentrant returns (uint256) {
        if (!REGISTRY.isRouter(msg.sender)) revert NotAuthorized();
        _checkRecipient(borrower);
        return _list(c, principal, cap, term, fundingDeadline, withRewards, borrower);
    }

    function _list(
        Collateral calldata c,
        uint128 principal,
        uint128 cap,
        uint32 term,
        uint40 fundingDeadline,
        bool withRewards,
        address borrower
    ) private returns (uint256 id) {
        _requireOpen();
        if (principal < UNITS || cap < principal || !REGISTRY.isTermAllowed(term)) revert InvalidTerms();
        if (fundingDeadline <= block.timestamp || fundingDeadline > block.timestamp + MAX_FUNDING_WINDOW) {
            revert Deadline();
        }
        (bytes32 key, uint256 exposure, uint256 maximum) = VALIDATOR.validate(c, msg.sender);
        if (_openExposure[key] + exposure > maximum) revert ExposureCap();
        _openExposure[key] += exposure;
        id = _nextId++;
        V2Loan storage l = _loans[id];
        l.originator = borrower;
        l.token = c.token;
        l.collateral = c.amountOrTokenId;
        l.kind = c.kind;
        l.state = V2State.FUNDING;
        l.principal = principal;
        l.cap = cap;
        l.term = term;
        l.fundingDeadline = fundingDeadline;
        l.exposureKey = key;
        l.exposureAmount = exposure;
        l.originationFee = uint128(Math.mulDiv(principal, REGISTRY.feeBps(), 10_000));
        if (withRewards) {
            (l.borrowerReward, l.lenderReward) = address(BRIDGE) == address(0)
                ? REGISTRY.quoteRewards(term, l.originationFee)
                : BRIDGE.quote(term, l.originationFee);
        }
        l.account = Clones.clone(ACCOUNT_IMPLEMENTATION);
        GageV2CollateralAccount(payable(l.account)).initialize(c);
        if (c.kind == Kind.ERC20) _pullExact(IERC20(c.token), msg.sender, l.account, c.amountOrTokenId);
        else IERC721(c.token).safeTransferFrom(msg.sender, l.account, c.amountOrTokenId);
        _safeMint(borrower, id);
        emit Listed(id, borrower, l.account, c, principal, cap, term, fundingDeadline);
    }

    /// @notice Buy 1, 2, 3 or 4 unfilled lender units; activate only on the final unit.
    function fund(uint256 id, uint8 units) external nonReentrant {
        _fund(id, units, msg.sender);
    }

    /// @notice An admitted entry router supplies USDG and records its user as the lender.
    function fundFor(uint256 id, uint8 units, address lender) external nonReentrant {
        if (!REGISTRY.isRouter(msg.sender)) revert NotAuthorized();
        _checkRecipient(lender);
        _fund(id, units, lender);
    }

    function _fund(uint256 id, uint8 units, address lender) private {
        _requireOpen();
        V2Loan storage l = _loans[id];
        if (l.state != V2State.FUNDING) revert WrongState();
        if (block.timestamp >= l.fundingDeadline) revert Deadline();
        if (units == 0 || units > UNITS - l.filled) revert InvalidUnits();
        uint256 amount;
        uint8 remaining = units;
        for (uint8 i; i < UNITS && remaining != 0; ++i) {
            if (_lenders[id][i] == address(0)) {
                _lenders[id][i] = lender;
                amount += _slice(l.principal, i);
                --remaining;
            }
        }
        l.filled += units;
        _receiveCash(amount);
        emit UnitsFunded(id, lender, units, amount, l.filled);
        if (l.filled == UNITS) _activate(id, l);
    }

    /// @notice Withdraw all of your units before activation, crediting cash for independent withdrawal.
    function withdrawCommitment(uint256 id) external nonReentrant {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.FUNDING) revert WrongState();
        uint256 amount;
        uint8 count;
        for (uint8 i; i < UNITS; ++i) {
            if (_lenders[id][i] == msg.sender) {
                amount += _slice(l.principal, i);
                delete _lenders[id][i];
                ++count;
            }
        }
        if (count == 0) revert NothingToClaim();
        l.filled -= count;
        _cashCredit[msg.sender] += amount;
        emit CommitmentWithdrawn(id, msg.sender, count, amount);
    }

    /// @notice Borrower may cancel partial funding; after its deadline anyone may release all refunds.
    function cancelFunding(uint256 id) external nonReentrant {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.FUNDING) revert WrongState();
        if (msg.sender != l.originator && block.timestamp < l.fundingDeadline) revert NotAuthorized();
        for (uint8 i; i < UNITS; ++i) {
            address lender = _lenders[id][i];
            if (lender != address(0)) {
                _cashCredit[lender] += _slice(l.principal, i);
                delete _lenders[id][i];
            }
        }
        l.filled = 0;
        l.state = V2State.CANCELLED;
        l.closedAt = uint40(block.timestamp);
        l.collateralBeneficiary = l.originator;
        _openExposure[l.exposureKey] -= l.exposureAmount;
        _burn(id);
        emit Closed(id, l.state, l.originator, l.closedAt);
    }

    /// @notice Pay the entire recorded cap and assign whole collateral to recipient.
    /// @dev ERC721 approval permits exercise. Normal transfers are deliberately restricted to buy().
    function reclaim(uint256 id, address recipient) external nonReentrant {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.ACTIVE) revert WrongState();
        if (!_isAuthorized(ownerOf(id), msg.sender, id)) revert NotAuthorized();
        _checkRecipient(recipient);
        _receiveCash(l.cap);
        if (address(BRIDGE) != address(0)) {
            USDG.forceApprove(address(BRIDGE), l.cap);
            BRIDGE.repay(id);
        }
        _close(id, l, V2State.REPAID);
        l.collateralBeneficiary = recipient;
        for (uint8 i; i < UNITS; ++i) {
            _cashCredit[_lenders[id][i]] += _slice(l.cap, i);
        }
        emit Closed(id, l.state, recipient, l.closedAt);
    }

    /// @notice Finalize lender entitlement after term plus grace; repayment remains possible until this executes.
    function finalizeDefault(uint256 id) external nonReentrant {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.ACTIVE) revert WrongState();
        if (block.timestamp < uint256(l.fundedAt) + l.term + GRACE) revert Deadline();
        if (address(BRIDGE) != address(0)) BRIDGE.finalizeDefault(id);
        _close(id, l, V2State.DEFAULTED);
        emit Closed(id, l.state, address(0), l.closedAt);
    }

    /// @notice Pull the intact original collateral after cancellation or full repayment.
    function withdrawCollateral(uint256 id, address recipient) external nonReentrant {
        V2Loan storage l = _loans[id];
        if (msg.sender != l.collateralBeneficiary || (l.state != V2State.REPAID && l.state != V2State.CANCELLED)) {
            revert NotAuthorized();
        }
        _checkRecipient(recipient);
        GageV2CollateralAccount(payable(l.account)).release(recipient);
        emit CollateralWithdrawn(id, recipient);
    }

    /// @notice After whole-cap repayment, withdraw the underlying assets atomically with LP removal limits.
    /// @dev The cash-out router uses this path. Failure preserves the intact-collateral withdrawal alternative.
    function withdrawRepaidUnderlying(uint256 id, address recipient, uint256 min0, uint256 min1, uint256 deadline)
        external
        nonReentrant
    {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.REPAID || msg.sender != l.collateralBeneficiary) revert NotAuthorized();
        _checkRecipient(recipient);
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_EXECUTION_WINDOW) revert Deadline();
        GageV2CollateralAccount account = GageV2CollateralAccount(payable(l.account));
        (, uint256[2] memory amounts) = account.recover(min0, min1, deadline);
        for (uint8 i; i < 2; ++i) {
            if (amounts[i] != 0) account.payRecovery(i, recipient, amounts[i]);
        }
        emit CollateralWithdrawn(id, recipient);
    }

    /// @notice A lender unwinds a defaulted LP once with execution limits; all underlying goes to unit holders.
    function recoverDefault(uint256 id, uint256 min0, uint256 min1, uint256 deadline)
        external
        nonReentrant
        returns (address[2] memory tokens, uint256[2] memory amounts)
    {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.DEFAULTED) revert WrongState();
        if (unitsOf(id, msg.sender) == 0) revert NotAuthorized();
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_EXECUTION_WINDOW) revert Deadline();
        (tokens, amounts) = GageV2CollateralAccount(payable(l.account)).recover(min0, min1, deadline);
        emit DefaultRecovered(id, tokens, amounts);
    }

    /// @notice Withdraw your full proportional share of one recovered underlying asset, independently of other lenders.
    function withdrawRecovery(uint256 id, uint8 asset, address recipient) external nonReentrant {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.DEFAULTED || asset > 1 || _recoveryClaimed[id][asset][msg.sender]) revert WrongState();
        _checkRecipient(recipient);
        GageV2CollateralAccount account = GageV2CollateralAccount(payable(l.account));
        if (!account.recovered()) revert WrongState();
        uint256 amount = _lenderShare(id, msg.sender, account.recoveryAmounts(asset));
        if (amount == 0) revert NothingToClaim();
        _recoveryClaimed[id][asset][msg.sender] = true;
        account.payRecovery(asset, recipient, amount);
        emit RecoveryWithdrawn(id, msg.sender, asset, recipient, amount);
    }

    /// @notice Post an on-chain USDG ask with a snapshotted protocol trading fee.
    function setAsk(uint256 id, uint128 price, uint40 deadline) external nonReentrant {
        _setAsk(id, price, deadline, type(uint16).max);
    }

    /// @notice Post an ask only if its snapshotted sale fee is no higher than the seller approved.
    function setAskWithMaxFee(uint256 id, uint128 price, uint40 deadline, uint16 maxFeeBps) external nonReentrant {
        _setAsk(id, price, deadline, maxFeeBps);
    }

    function _setAsk(uint256 id, uint128 price, uint40 deadline, uint16 maxFeeBps) private {
        V2Loan storage l = _loans[id];
        _requireSaleable(l);
        if (ownerOf(id) != msg.sender) revert NotAuthorized();
        if (price == 0 || deadline <= block.timestamp || deadline > uint256(l.fundedAt) + l.term + GRACE) {
            revert Deadline();
        }
        uint256 nonce = ++_nonces[id];
        uint16 feeBps = REGISTRY.tradeFeeBps();
        if (feeBps > maxFeeBps) revert StaleAsk();
        _asks[id] = V2Ask(price, deadline, feeBps, nonce);
        emit AskPosted(id, msg.sender, price, deadline, _asks[id].feeBps, nonce);
    }

    /// @notice Invalidate an existing ask and its expected nonce.
    function cancelAsk(uint256 id) external nonReentrant {
        if (ownerOf(id) != msg.sender) revert NotAuthorized();
        delete _asks[id];
        emit AskCancelled(id, ++_nonces[id]);
    }

    /// @notice Buy a whole reclaim right. Earned rewards stay with its seller, even if not yet withdrawn.
    function buy(uint256 id, address seller, uint256 nonce, uint128 price, uint16 maxFeeBps, address recipient)
        external
        nonReentrant
    {
        V2Loan storage l = _loans[id];
        _requireSaleable(l);
        _checkRecipient(recipient);
        V2Ask memory ask = _asks[id];
        if (
            seller != ownerOf(id) || ask.nonce != nonce || ask.price != price || price == 0
                || block.timestamp >= ask.deadline || ask.feeBps > maxFeeBps
        ) revert StaleAsk();
        REWARDS.transferRight(id, recipient);
        delete _asks[id];
        ++_nonces[id];
        uint256 fee = Math.mulDiv(price, ask.feeBps, 10_000);
        _receiveCash(price);
        _cashCredit[seller] += price - fee;
        _cashCredit[FEE_RECIPIENT] += fee;
        _marketTransfer = true;
        _transfer(seller, recipient, id);
        _marketTransfer = false;
        emit RightSold(id, seller, msg.sender, recipient, price, fee, nonce);
        ERC721Utils.checkOnERC721Received(msg.sender, seller, recipient, id, "");
    }

    /// @notice Offer selected quarters as one bundle. Posting never escrows or changes their entitlements.
    function setLenderAsk(uint256 id, uint8 slots, uint128 price, uint40 deadline, uint16 maxFeeBps)
        external
        nonReentrant
    {
        if (_loans[id].state != V2State.ACTIVE) revert WrongState();
        _requireLenderSlots(id, msg.sender, slots);
        if (price == 0 || deadline <= block.timestamp) revert Deadline();
        uint16 feeBps = REGISTRY.tradeFeeBps();
        if (feeBps > maxFeeBps) revert StaleAsk();
        uint256 nonce = ++_lenderNonces[id][msg.sender];
        _lenderAsks[id][msg.sender] = V2LenderAsk(msg.sender, slots, price, deadline, feeBps, nonce);
        emit LenderAskPosted(id, msg.sender, slots, price, deadline, feeBps, nonce);
    }

    /// @notice An account may invalidate its ask even after the loan has settled.
    function cancelLenderAsk(uint256 id) external nonReentrant {
        if (_lenderAsks[id][msg.sender].price == 0) revert NothingToClaim();
        delete _lenderAsks[id][msg.sender];
        emit LenderAskCancelled(id, msg.sender, ++_lenderNonces[id][msg.sender]);
    }

    /// @notice Pay a fixed bundle price and acquire its repayment, default recovery and future reward rights atomically.
    function buyLender(uint256 id, V2LenderPurchase calldata purchase) external nonReentrant {
        if (_loans[id].state != V2State.ACTIVE) revert WrongState();
        _checkRecipient(purchase.recipient);
        if (purchase.recipient == purchase.seller) revert InvalidRecipient();
        V2LenderAsk memory ask = _lenderAsks[id][purchase.seller];
        if (
            ask.price == 0 || ask.price != purchase.price || ask.nonce != purchase.nonce || ask.slots != purchase.slots
                || ask.feeBps > purchase.maxFeeBps || block.timestamp >= ask.deadline
        ) {
            revert StaleAsk();
        }
        _requireLenderSlots(id, purchase.seller, ask.slots);
        if (REWARDS.remainingLenderReward(id, ask.slots) < purchase.minRemainingReward) revert StaleAsk();
        REWARDS.transferLender(id, purchase.seller, purchase.recipient, ask.slots);
        delete _lenderAsks[id][purchase.seller];
        ++_lenderNonces[id][purchase.seller];
        for (uint8 i; i < UNITS; ++i) {
            if (ask.slots & (1 << i) != 0) _lenders[id][i] = purchase.recipient;
        }
        uint256 fee = Math.mulDiv(ask.price, ask.feeBps, 10_000);
        _receiveCash(ask.price);
        _cashCredit[purchase.seller] += ask.price - fee;
        _cashCredit[FEE_RECIPIENT] += fee;
        emit LenderSold(id, purchase.seller, msg.sender, purchase.recipient, ask.slots, ask.price, fee, ask.nonce);
    }

    function getLenderAsk(uint256 id, address seller) external view returns (V2LenderAsk memory) {
        return _lenderAsks[id][seller];
    }

    /// @notice At most four distinct lender asks. Empty entries and expired deadlines are not executable sales.
    function getLenderAsks(uint256 id) external view returns (V2LenderAsk[4] memory asks) {
        if (_loans[id].state != V2State.ACTIVE) return asks;
        for (uint8 i; i < UNITS; ++i) {
            V2LenderAsk memory ask = _lenderAsks[id][_lenders[id][i]];
            // Return a bundle once, at the index of its first selected quarter.
            if (ask.slots & (1 << i) != 0 && ask.slots & ((1 << i) - 1) == 0) asks[i] = ask;
        }
    }

    function _requireLenderSlots(uint256 id, address seller, uint8 slots) private view {
        if (slots == 0 || slots > 15) revert InvalidUnits();
        for (uint8 i; i < UNITS; ++i) {
            if (slots & (1 << i) != 0 && _lenders[id][i] != seller) revert NotAuthorized();
        }
    }

    /// @notice Withdraw all your USDG credit to a chosen recipient.
    function withdrawUSDG(address recipient) external nonReentrant {
        _withdrawUSDG(msg.sender, recipient);
    }

    /// @notice Permissionlessly deliver an account's credit to that same account, including the existing fee router.
    function withdrawUSDGFor(address account) external nonReentrant {
        _withdrawUSDG(account, account);
    }

    /// @notice Complete loan record including immutable economics and collateral account.
    function getLoan(uint256 id) external view returns (V2Loan memory) {
        return _loans[id];
    }
    /// @notice Highest issued ID, including closed/cancelled loans, for independent chain discovery.

    function loanCount() external view returns (uint256) {
        return _nextId - 1;
    }
    /// @notice Four fixed lender slots; empty slots are zero before activation.

    function lenders(uint256 id) external view returns (address[4] memory) {
        return _lenders[id];
    }
    /// @notice Current on-chain sale quote.

    function getAsk(uint256 id) external view returns (V2Ask memory) {
        return _asks[id];
    }
    /// @notice Cash available to withdraw; committed partial funding is excluded.

    function cashCredit(address account) external view returns (uint256) {
        return _cashCredit[account];
    }
    /// @notice Total backed USDG liability, including unactivated contributions.

    function accountedCash() external view returns (uint256) {
        return _accountedCash;
    }
    /// @notice Reward reserve accounting: free for future activations and reserved for outstanding earned/unearned allocations.

    function rewardBudget() external view returns (uint256 free, uint256 reserved) {
        return REWARDS.budget();
    }
    /// @notice Raw collateral exposure against the registry admission bucket.

    function openExposure(bytes32 key) external view returns (uint256) {
        return _openExposure[key];
    }
    /// @notice Number of lender units currently held by account.

    function unitsOf(uint256 id, address account) public view returns (uint8 count) {
        if (account == address(0)) return 0;
        for (uint8 i; i < UNITS; ++i) {
            if (_lenders[id][i] == account) ++count;
        }
    }
    /// @notice Total earned, unwithdrawn borrower and lender rewards, with the original quadratic clock.

    function claimableRewards(uint256 id, address account) public view returns (uint256) {
        return REWARDS.claimable(id, account);
    }

    /// @notice One lender's remaining entitlement to a recovered asset, including deterministic quarter rounding.
    function claimableRecovery(uint256 id, uint8 asset, address holder) external view returns (uint256) {
        V2Loan storage l = _loans[id];
        if (l.state != V2State.DEFAULTED || asset > 1 || _recoveryClaimed[id][asset][holder]) return 0;
        GageV2CollateralAccount account = GageV2CollateralAccount(payable(l.account));
        if (!account.recovered()) return 0;
        return _lenderShare(id, holder, account.recoveryAmounts(asset));
    }

    function _activate(uint256 id, V2Loan storage l) private {
        if (!REGISTRY.isTermAllowed(l.term)) revert InvalidTerms();
        (bytes32 key, uint256 exposure, uint256 maximum) =
            VALIDATOR.validate(Collateral(l.kind, l.token, l.collateral), l.account);
        if (key != l.exposureKey || exposure != l.exposureAmount || _openExposure[key] > maximum) revert ExposureCap();
        if (address(BRIDGE) != address(0)) {
            USDG.forceApprove(address(BRIDGE), l.principal);
            (uint128 borrowerReward, uint128 lenderReward) =
                BRIDGE.open(id, l.account, l.principal, l.cap, l.term, l.originationFee);
            if (borrowerReward < l.borrowerReward || lenderReward < l.lenderReward) revert InvalidTerms();
            l.borrowerReward = borrowerReward;
            l.lenderReward = lenderReward;
            // V1 already credited this fee to its existing floor fee route. Do not charge it twice.
            _accountedCash -= l.originationFee;
        } else {
            _cashCredit[FEE_RECIPIENT] += l.originationFee;
        }
        REWARDS.activate(id, l.originator, _lenders[id], l.term, l.borrowerReward, l.lenderReward);
        l.state = V2State.ACTIVE;
        l.fundedAt = uint40(block.timestamp);
        _cashCredit[l.originator] += l.principal - l.originationFee;
        emit Activated(id, l.fundedAt, l.originationFee, l.borrowerReward, l.lenderReward);
    }

    function _close(uint256 id, V2Loan storage l, V2State state) private {
        l.closedAt = uint40(block.timestamp);
        REWARDS.close(id);
        l.state = state;
        delete _asks[id];
        ++_nonces[id];
        _openExposure[l.exposureKey] -= l.exposureAmount;
        _burn(id);
    }

    function _lenderShare(uint256 id, address account, uint256 total) private view returns (uint256 amount) {
        for (uint8 i; i < UNITS; ++i) {
            if (_lenders[id][i] == account) amount += _slice(total, i);
        }
    }

    function _slice(uint256 total, uint8 i) private pure returns (uint256) {
        // Stable, monotonic rounding: first units receive at most one extra raw unit.
        return total / UNITS + (i < total % UNITS ? 1 : 0);
    }

    function _requireOpen() private view {
        if (REGISTRY.newDealsPaused()) revert Paused();
    }

    function _requireSaleable(V2Loan storage l) private view {
        if (l.state != V2State.ACTIVE) revert WrongState();
        if (block.timestamp >= uint256(l.fundedAt) + l.term + GRACE) revert Deadline();
    }

    function _receiveCash(uint256 amount) private {
        _pullExact(USDG, msg.sender, address(this), amount);
        _accountedCash += amount;
    }

    function _withdrawUSDG(address account, address recipient) private {
        _checkRecipient(recipient);
        uint256 amount = _cashCredit[account];
        if (amount == 0) revert NothingToClaim();
        delete _cashCredit[account];
        _accountedCash -= amount;
        USDG.safeTransfer(recipient, amount);
        emit CashWithdrawn(account, recipient, amount);
    }

    function _pullExact(IERC20 token, address from, address to, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        if (token.balanceOf(to) - beforeBalance != amount) revert ExactTransferRequired();
    }

    function _checkRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
    }

    function _update(address to, uint256 id, address auth) internal override returns (address from) {
        from = _ownerOf(id);
        if (from != address(0) && to != address(0) && !_marketTransfer) revert UseMarketplace();
        return super._update(to, id, auth);
    }
}
