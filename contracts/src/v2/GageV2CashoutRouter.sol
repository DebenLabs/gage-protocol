// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IUniV3Factory, IUniV3Pool, IUniV3PositionManager} from "../interfaces/IUniV3.sol";
import {Kind} from "../types/Types.sol";
import {GageV2Vault} from "./GageV2Vault.sol";
import {V2Loan, V2State} from "./V2Types.sol";

interface IV2FlashPool is IUniV3Pool {
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IV2WETH is IERC20 {
    function withdraw(uint256 amount) external;
}

/// @notice Owner-authorized atomic whole-position cash-out with a 0.5% fee on cash after cap and financing costs.
/// @dev A separate V3 flash pool leaves V4's manager unlocked while the vault releases collateral. Only
///      allowlisted exact-input routes are accepted; preexisting router balances are never spent or paid out.
contract GageV2CashoutRouter is Ownable2Step, ReentrancyGuardTransient, IUnlockCallback {
    using SafeERC20 for IERC20;

    GageV2Vault public immutable VAULT;
    IERC20 public immutable USDG;
    address public immutable WETH;
    address public immutable V3_FACTORY;
    IV2FlashPool public immutable FLASH_POOL;
    IPoolManager public immutable POOL_MANAGER;
    address public immutable FEE_RECIPIENT;
    uint16 public constant CASHOUT_FEE_BPS = 50;
    uint8 public constant MAX_ROUTES = 8;
    uint32 public constant MAX_EXECUTION_WINDOW = 15 minutes;

    enum RouteKind {
        V4,
        V3,
        UNWRAP_WETH
    }

    struct Route {
        RouteKind kind;
        address tokenIn;
        address tokenOut;
        uint24 v3Fee;
        PoolKey key;
        uint256 minOut;
    }

    struct Exit {
        uint256 loanId;
        address recipient;
        uint256 minimumNet;
        uint256 maxFinanceFee;
        uint256 minUnderlying0;
        uint256 minUnderlying1;
        uint256 deadline;
        Route[] routes;
    }

    struct FlashContext {
        Exit exit;
        address owner;
        uint256 cap;
        address[] tokens;
        uint256[] balances;
    }

    mapping(bytes32 => bool) private _v4Allowed;
    mapping(address => bool) private _v3Allowed;
    bytes32 private _flashHash;
    bytes32 private _swapHash;
    address private _activeV3;
    uint256 private _resultNet;
    uint256 private _resultGross;
    uint256 private _resultFinanceFee;
    uint256 private _resultPlatformFee;

    error InvalidConfiguration();
    error NotOwnerOfRight();
    error InvalidExit();
    error BadCallback();
    error RouteNotAllowed();
    error InsufficientOutput();
    error UnspentAsset();

    event V4RouteSet(bytes32 indexed poolId, bool allowed);
    event V3RouteSet(address indexed pool, bool allowed);
    event CashedOut(
        uint256 indexed loanId,
        address indexed owner,
        address indexed recipient,
        uint256 gross,
        uint256 cap,
        uint256 financeFee,
        uint256 platformFee,
        uint256 net
    );

    constructor(GageV2Vault vault, IV2FlashPool source, IPoolManager manager, address weth, address admin)
        Ownable(admin)
    {
        VAULT = vault;
        USDG = vault.USDG();
        FEE_RECIPIENT = vault.FEE_RECIPIENT();
        V3_FACTORY = vault.REGISTRY().V3_FACTORY();
        FLASH_POOL = source;
        POOL_MANAGER = manager;
        WETH = weth;
        address t0 = source.token0();
        address t1 = source.token1();
        if (
            weth == address(0) || address(manager).code.length == 0 || source.factory() != V3_FACTORY
                || IUniV3Factory(V3_FACTORY).getPool(t0, t1, source.fee()) != address(source)
                || !((t0 == address(USDG) && t1 == weth) || (t1 == address(USDG) && t0 == weth))
        ) revert InvalidConfiguration();
        address v4 = vault.VALIDATOR().V4_MANAGER();
        if (v4 != address(0) && address(IPositionManager(v4).poolManager()) != address(manager)) {
            revert InvalidConfiguration();
        }
        address canonicalWeth = vault.VALIDATOR().WETH();
        if (canonicalWeth != address(0) && canonicalWeth != weth) revert InvalidConfiguration();
    }

    /// @notice Admit a reviewed V4 swap path. Revocation never affects ordinary vault repayment or recovery.
    function setV4Route(PoolKey calldata key, bool allowed) external onlyOwner {
        if (Currency.unwrap(key.currency0) >= Currency.unwrap(key.currency1) || key.tickSpacing <= 0) {
            revert InvalidConfiguration();
        }
        bytes32 id = keccak256(abi.encode(key));
        _v4Allowed[id] = allowed;
        emit V4RouteSet(id, allowed);
    }
    /// @notice Admit a canonical V3 pool, excluding the flash source to prevent a locked-pool route.

    function setV3Route(address pool, bool allowed) external onlyOwner {
        if (allowed) {
            IUniV3Pool p = IUniV3Pool(pool);
            if (
                pool == address(FLASH_POOL) || p.factory() != V3_FACTORY
                    || IUniV3Factory(V3_FACTORY).getPool(p.token0(), p.token1(), p.fee()) != pool
            ) revert InvalidConfiguration();
        }
        _v3Allowed[pool] = allowed;
        emit V3RouteSet(pool, allowed);
    }
    /// @notice Whether a V4 route is currently enabled.

    function v4Allowed(PoolKey calldata key) external view returns (bool) {
        return _v4Allowed[keccak256(abi.encode(key))];
    }
    /// @notice Whether a V3 pool is currently enabled.

    function v3Allowed(address pool) external view returns (bool) {
        return _v3Allowed[pool];
    }

    /// @notice Exercise your approved reclaim right, unwind collateral, repay financing and receive minimum net USDG or revert everything.
    function cashOut(Exit calldata exit) external nonReentrant returns (uint256 net) {
        _cashOut(exit);
        return _resultNet;
    }

    /// @notice Same protected execution with the complete fee breakdown, also usable in an eth_call simulation.
    function cashOutDetailed(Exit calldata exit)
        external
        nonReentrant
        returns (uint256 gross, uint256 financeFee, uint256 platformFee, uint256 net)
    {
        _cashOut(exit);
        return (_resultGross, _resultFinanceFee, _resultPlatformFee, _resultNet);
    }

    function _cashOut(Exit calldata exit) private {
        if (VAULT.ownerOf(exit.loanId) != msg.sender) revert NotOwnerOfRight();
        if (
            exit.recipient == address(0) || exit.recipient == address(this) || exit.minimumNet == 0
                || exit.deadline < block.timestamp || exit.deadline > block.timestamp + MAX_EXECUTION_WINDOW
                || exit.routes.length > MAX_ROUTES
        ) revert InvalidExit();
        V2Loan memory loan = VAULT.getLoan(exit.loanId);
        if (loan.state != V2State.ACTIVE) revert InvalidExit();
        (address[] memory tokens, uint256[] memory balances) = _snapshot(loan, exit.routes);
        bytes memory data = abi.encode(FlashContext(exit, msg.sender, loan.cap, tokens, balances));
        _flashHash = keccak256(data);
        bool cash0 = FLASH_POOL.token0() == address(USDG);
        FLASH_POOL.flash(address(this), cash0 ? loan.cap : 0, cash0 ? 0 : loan.cap, data);
        if (_flashHash != bytes32(0)) revert BadCallback();
    }

    /// @notice Authenticated callback from the single pinned V3 flash source.
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        if (msg.sender != address(FLASH_POOL) || _flashHash == bytes32(0) || keccak256(data) != _flashHash) {
            revert BadCallback();
        }
        _flashHash = bytes32(0); // A callback can be consumed once only.
        FlashContext memory context = abi.decode(data, (FlashContext));
        Exit memory x = context.exit;
        uint256 financeFee = fee0 + fee1;
        if (financeFee > x.maxFinanceFee) revert InsufficientOutput();
        USDG.forceApprove(address(VAULT), context.cap);
        VAULT.reclaim(x.loanId, address(this));
        USDG.forceApprove(address(VAULT), 0);
        VAULT.withdrawRepaidUnderlying(x.loanId, address(this), x.minUnderlying0, x.minUnderlying1, x.deadline);
        for (uint256 i; i < x.routes.length; ++i) {
            _route(x.routes[i], context.tokens, context.balances);
        }
        uint256 gross = USDG.balanceOf(address(this)) - context.balances[0];
        if (gross < context.cap + financeFee) revert InsufficientOutput();
        uint256 remainder = gross - context.cap - financeFee;
        uint256 fee = remainder * CASHOUT_FEE_BPS / 10_000;
        uint256 net = remainder - fee;
        if (net < x.minimumNet) revert InsufficientOutput();
        // Every non-cash asset must have been consumed; never strand a user's unquoted remainder.
        for (uint256 i = 1; i < context.tokens.length; ++i) {
            if (_balance(context.tokens[i]) != context.balances[i]) revert UnspentAsset();
        }
        _resultNet = net;
        _resultGross = gross;
        _resultFinanceFee = financeFee;
        _resultPlatformFee = fee;
        USDG.safeTransfer(address(FLASH_POOL), context.cap + financeFee);
        if (fee != 0) USDG.safeTransfer(FEE_RECIPIENT, fee);
        USDG.safeTransfer(x.recipient, net);
        emit CashedOut(x.loanId, context.owner, x.recipient, gross, context.cap, financeFee, fee, net);
    }

    /// @notice Authenticated V3 swap payment, limited to the exact input amount and expected pool.
    function uniswapV3SwapCallback(int256 delta0, int256 delta1, bytes calldata data) external {
        if (msg.sender != _activeV3 || _activeV3 == address(0) || _swapHash != keccak256(data)) revert BadCallback();
        (address input, uint256 amount) = abi.decode(data, (address, uint256));
        bool input0 = IUniV3Pool(msg.sender).token0() == input;
        if ((input0 ? delta0 : delta1) != int256(amount) || (input0 ? delta1 : delta0) >= 0) revert BadCallback();
        _activeV3 = address(0);
        _swapHash = bytes32(0);
        IERC20(input).safeTransfer(msg.sender, amount);
    }

    /// @notice Authenticated V4 exact-input execution, with full input consumption and caller-specified output minimum.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || _swapHash == bytes32(0) || _swapHash != keccak256(data)) {
            revert BadCallback();
        }
        _swapHash = bytes32(0);
        (Route memory r, uint256 amount) = abi.decode(data, (Route, uint256));
        bool zeroForOne = Currency.unwrap(r.key.currency0) == r.tokenIn;
        BalanceDelta d = POOL_MANAGER.swap(
            r.key,
            SwapParams(
                zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        int128 inDelta = zeroForOne ? d.amount0() : d.amount1();
        int128 outDelta = zeroForOne ? d.amount1() : d.amount0();
        if (
            inDelta >= 0 || outDelta <= 0 || uint256(-int256(inDelta)) != amount
                || uint256(uint128(outDelta)) < r.minOut
        ) revert InsufficientOutput();
        if (r.tokenIn == address(0)) {
            POOL_MANAGER.settle{value: amount}();
        } else {
            POOL_MANAGER.sync(Currency.wrap(r.tokenIn));
            IERC20(r.tokenIn).safeTransfer(address(POOL_MANAGER), amount);
            POOL_MANAGER.settle();
        }
        POOL_MANAGER.take(Currency.wrap(r.tokenOut), address(this), uint128(outDelta));
        return "";
    }

    function _route(Route memory r, address[] memory tokens, uint256[] memory balances) private {
        if (r.tokenIn == address(USDG) || r.tokenIn == r.tokenOut || r.minOut == 0) revert InvalidExit();
        uint256 amount = _balance(r.tokenIn) - _baseline(r.tokenIn, tokens, balances);
        if (amount == 0) return;
        if (amount > uint256(type(int256).max)) revert InvalidExit();
        uint256 beforeOut = _balance(r.tokenOut);
        if (r.kind == RouteKind.UNWRAP_WETH) {
            if (r.tokenIn != WETH || r.tokenOut != address(0)) revert InvalidExit();
            IV2WETH(WETH).withdraw(amount);
        } else if (r.kind == RouteKind.V3) {
            address pool = IUniV3Factory(V3_FACTORY).getPool(r.tokenIn, r.tokenOut, r.v3Fee);
            if (!_v3Allowed[pool]) revert RouteNotAllowed();
            bool zeroForOne = IUniV3Pool(pool).token0() == r.tokenIn;
            bytes memory data = abi.encode(r.tokenIn, amount);
            _activeV3 = pool;
            _swapHash = keccak256(data);
            IV2FlashPool(pool)
                .swap(
                    address(this),
                    zeroForOne,
                    int256(amount),
                    zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
                    data
                );
            if (_activeV3 != address(0) || _swapHash != bytes32(0)) revert BadCallback();
        } else {
            if (!_v4Allowed[keccak256(abi.encode(r.key))]) revert RouteNotAllowed();
            address c0 = Currency.unwrap(r.key.currency0);
            address c1 = Currency.unwrap(r.key.currency1);
            if (!((r.tokenIn == c0 && r.tokenOut == c1) || (r.tokenIn == c1 && r.tokenOut == c0))) {
                revert InvalidExit();
            }
            bytes memory data = abi.encode(r, amount);
            _swapHash = keccak256(data);
            POOL_MANAGER.unlock(data);
            if (_swapHash != bytes32(0)) revert BadCallback();
        }
        if (
            _balance(r.tokenIn) != _baseline(r.tokenIn, tokens, balances) || _balance(r.tokenOut) - beforeOut < r.minOut
        ) {
            revert InsufficientOutput();
        }
    }

    function _snapshot(V2Loan memory loan, Route[] calldata routes)
        private
        view
        returns (address[] memory tokens, uint256[] memory balances)
    {
        tokens = new address[](3 + routes.length * 2);
        uint256 n = 1;
        tokens[0] = address(USDG);
        if (loan.kind == Kind.ERC20) {
            n = _add(tokens, n, loan.token);
        } else if (loan.kind == Kind.UNIV3_POSITION) {
            IUniV3PositionManager.Position memory p = IUniV3PositionManager(loan.token).positions(loan.collateral);
            n = _add(tokens, n, p.token0);
            n = _add(tokens, n, p.token1);
        } else {
            (PoolKey memory key,) = IPositionManager(loan.token).getPoolAndPositionInfo(loan.collateral);
            n = _add(tokens, n, Currency.unwrap(key.currency0));
            n = _add(tokens, n, Currency.unwrap(key.currency1));
        }
        for (uint256 i; i < routes.length; ++i) {
            n = _add(tokens, n, routes[i].tokenIn);
            n = _add(tokens, n, routes[i].tokenOut);
        }
        assembly ("memory-safe") {
            mstore(tokens, n)
        }
        balances = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            balances[i] = _balance(tokens[i]);
        }
    }

    function _add(address[] memory tokens, uint256 n, address token) private pure returns (uint256) {
        for (uint256 i; i < n; ++i) {
            if (tokens[i] == token) return n;
        }
        tokens[n] = token;
        return n + 1;
    }

    function _baseline(address token, address[] memory tokens, uint256[] memory balances)
        private
        pure
        returns (uint256)
    {
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == token) return balances[i];
        }
        revert InvalidExit();
    }

    function _balance(address token) private view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    receive() external payable {}
}
