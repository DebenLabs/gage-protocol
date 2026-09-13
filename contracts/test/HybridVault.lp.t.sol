// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {EarnBaseTest} from "./EarnBase.t.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {HybridVault, EarnLane} from "../src/HybridVault.sol";
import {GageV2CollateralValidator} from "../src/v2/GageV2CollateralValidator.sol";
import {GageV2CollateralAccount, IV2V3PositionActions} from "../src/v2/GageV2CollateralAccount.sol";
import {IUniV3PositionManager} from "../src/interfaces/IUniV3.sol";
import {Collateral, Kind} from "../src/types/Types.sol";

/// @dev Deterministic LP proceeds, including fees. Core custody, lender quarters and Earn accounting are real.
contract EarnLPManagerMock is ERC721 {
    address[2] private _tokens;
    uint256[2] private _amounts;
    uint256 private _tokenId;
    bool private _paid;

    constructor() ERC721("LP", "LP") {}

    function mint(address owner, uint256 id, address[2] memory tokens, uint256[2] memory amounts) external {
        _tokens = tokens;
        _amounts = amounts;
        _tokenId = id;
        _paid = false;
        _mint(owner, id);
    }

    function positions(uint256) external view returns (IUniV3PositionManager.Position memory p) {
        p.token0 = _tokens[0];
        p.token1 = _tokens[1];
        p.fee = 3000;
        p.tickLower = -60;
        p.tickUpper = 60;
        p.liquidity = 100;
    }

    function decreaseLiquidity(IV2V3PositionActions.DecreaseParams calldata p)
        external
        view
        returns (uint256, uint256)
    {
        require(ownerOf(p.tokenId) == msg.sender);
        return (0, 0);
    }

    function collect(IV2V3PositionActions.CollectParams calldata p) external returns (uint256, uint256) {
        require(ownerOf(p.tokenId) == msg.sender);
        _pay(p.recipient);
        return (_amounts[0], _amounts[1]);
    }

    function getPoolAndPositionInfo(uint256) external view returns (PoolKey memory, uint256) {
        return (PoolKey(Currency.wrap(_tokens[0]), Currency.wrap(_tokens[1]), 3000, 60, IHooks(address(0))), 0);
    }

    function getPositionLiquidity(uint256) external pure returns (uint128) {
        return 100;
    }

    function modifyLiquidities(bytes calldata, uint256) external payable {
        require(ownerOf(_tokenId) == msg.sender);
        _pay(msg.sender);
    }

    function _pay(address recipient) private {
        require(!_paid);
        _paid = true;
        for (uint256 i; i < 2; ++i) {
            if (_amounts[i] == 0) continue;
            if (_tokens[i] == address(0)) {
                (bool ok,) = recipient.call{value: _amounts[i]}("");
                require(ok);
            } else {
                require(IERC20(_tokens[i]).transfer(recipient, _amounts[i]));
            }
        }
    }

    receive() external payable {}
}

contract HybridVaultLPTest is EarnBaseTest {
    EarnLPManagerMock internal manager;
    uint256 internal constant NFT_ID = 987_654_321;

    function setUp() public override {
        super.setUp();
        manager = new EarnLPManagerMock();
        p.laneWeights = [uint16(0), 0, 10_000];
        _deploy();
        vm.prank(lender);
        hybrid.deposit(600e6, 0);
        vm.prank(lender2);
        hybrid.deposit(400e6, 0);
    }

    function _lp(Kind kind, address token0, address token1, uint256 amount0, uint256 amount1)
        internal
        returns (uint256 id)
    {
        manager.mint(borrower, NFT_ID, [token0, token1], [amount0, amount1]);
        if (token0 == address(0)) vm.deal(address(manager), amount0);
        else MockERC20(token0).mint(address(manager), amount0);
        if (token1 == address(0)) vm.deal(address(manager), address(manager).balance + amount1);
        else MockERC20(token1).mint(address(manager), amount1);
        Collateral memory c = Collateral(kind, address(manager), NFT_ID);
        // The validator's pool/range math is covered by core LP tests. These tests exercise the full custody
        // lifecycle with a deterministic admission response, for both listing and revalidation at funding.
        vm.mockCall(
            address(validator),
            abi.encodeWithSelector(GageV2CollateralValidator.validate.selector, c),
            abi.encode(keccak256(abi.encode(kind, address(manager))), uint256(100), type(uint256).max)
        );
        vm.startPrank(borrower);
        manager.approve(address(vault), NFT_ID);
        id = vault.list(c, 400e6, 420e6, T7, uint40(block.timestamp + 1 days), true);
        vm.stopPrank();
    }

    function _fundLP(uint256 id, uint8 units) internal {
        _approve(id, units);
        hybrid.fund(id, 0);
        _fill(id);
        assertEq(uint8(hybrid.loanLane(id)), uint8(EarnLane.LP));
    }

    function _defaultLP(uint256 id) internal {
        vm.warp(_defaultAt(id));
        hybrid.settle(_ids(id));
    }

    function testV3DefaultCreatesBothPocketsForSnapshotHolders() public {
        uint256 id = _lp(Kind.UNIV3_POSITION, address(nvda), address(usdg), 1000e18, 200e6);
        _fundLP(id, 4);
        vm.warp(block.timestamp + T7);
        hybrid.markOverdue(_ids(id));
        vm.prank(other);
        hybrid.deposit(100e6, 0);
        _defaultLP(id);
        assertTrue(hybrid.terminal(id));
        assertEq(hybrid.pocketCount(), 2);
        assertEq(hybrid.totalAssets(), 700e6, "USDG LP recovery is a pocket, not pooled cash");
        assertEq(hybrid.pocketClaimable(1, lender), 600e18);
        assertEq(hybrid.pocketClaimable(2, lender), 120e6);
        assertEq(hybrid.pocketClaimable(1, other), 0);
        assertEq(hybrid.pocketClaimable(2, other), 0);
        uint256 cashBefore = usdg.balanceOf(lender);
        vm.startPrank(lender);
        hybrid.claimPocket(1);
        hybrid.claimPocket(2);
        vm.stopPrank();
        assertEq(nvda.balanceOf(lender), 600e18);
        assertEq(usdg.balanceOf(lender) - cashBefore, 120e6);
        hybrid.settle(_ids(id));
        assertEq(hybrid.pocketCount(), 2, "repeated settlement cannot duplicate recoveries");
    }

    function testV4NativeRecoveryUsesOnlyTheStrategiesQuarters() public {
        uint256 id = _lp(Kind.UNIV4_POSITION, address(0), address(meme), 2 ether, 1000e18);
        _fundLP(id, 2);
        _defaultLP(id);
        assertTrue(hybrid.terminal(id));
        assertEq(hybrid.pocketCount(), 2);
        assertEq(address(hybrid).balance, 1 ether);
        assertEq(meme.balanceOf(address(hybrid)), 500e18);
        assertEq(hybrid.pocketClaimable(1, lender), 0.6 ether);
        assertEq(hybrid.pocketClaimable(2, lender), 300e18);
        uint256 beforeNative = lender.balance;
        vm.startPrank(lender);
        hybrid.claimPocket(1);
        hybrid.claimPocket(2);
        vm.stopPrank();
        assertEq(lender.balance - beforeNative, 0.6 ether);
        assertEq(meme.balanceOf(lender), 300e18);
        assertEq(hybrid.totalAssets(), 800e6);
    }

    function testSecondAssetFailureRollsBackBothWithdrawalsAndRetries() public {
        uint256 id = _lp(Kind.UNIV3_POSITION, address(nvda), address(meme), 1000e18, 2000e18);
        _fundLP(id, 4);
        meme.setBlocked(address(hybrid), true);
        _defaultLP(id);
        assertFalse(hybrid.terminal(id));
        assertEq(hybrid.pocketCount(), 0);
        assertEq(nvda.balanceOf(address(hybrid)), 0, "first withdrawal must roll back with the second");
        assertFalse(GageV2CollateralAccount(payable(vault.getLoan(id).account)).recovered());
        meme.setBlocked(address(hybrid), false);
        hybrid.settle(_ids(id));
        assertTrue(hybrid.terminal(id));
        assertEq(hybrid.pocketCount(), 2);
        assertEq(nvda.balanceOf(address(hybrid)), 1000e18);
        assertEq(meme.balanceOf(address(hybrid)), 2000e18);
    }

    function testV4RepaymentRestoresCashWithoutRecoveryPockets() public {
        uint256 id = _lp(Kind.UNIV4_POSITION, address(nvda), address(usdg), 1000e18, 200e6);
        _fundLP(id, 4);
        _repay(id);
        hybrid.settle(_ids(id));
        assertTrue(hybrid.terminal(id));
        assertEq(hybrid.pocketCount(), 0);
        assertEq(hybrid.fullAssets(), 1020e6);
        assertEq(hybrid.lanePrincipal(EarnLane.LP), 0);
    }

    function testClosedLPCategoryRejectsApproval() public {
        uint256 id = _lp(Kind.UNIV3_POSITION, address(nvda), address(usdg), 1000e18, 200e6);
        vm.prank(curator);
        hybrid.setLaneWeight(EarnLane.LP, 0);
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(HybridVault.IneligibleDeal.selector, id));
        hybrid.approveLoan(id, uint40(block.timestamp + 1 hours), 4);
    }

    function testLPRegistryAdmissionIsRecheckedBeforeFunding() public {
        uint256 id = _lp(Kind.UNIV3_POSITION, address(nvda), address(usdg), 1000e18, 200e6);
        _approve(id);
        vm.clearMockedCalls();
        vm.expectRevert();
        hybrid.fund(id, 0);
        assertFalse(hybrid.funded(id));
        assertEq(hybrid.cash(), 1000e6);
    }

    function testLPValidatorRejectsChangedExposureAndMalformedReturnData() public {
        uint256 id = _lp(Kind.UNIV3_POSITION, address(nvda), address(usdg), 1000e18, 200e6);
        bytes memory callData = abi.encodeWithSelector(
            GageV2CollateralValidator.validate.selector, Collateral(Kind.UNIV3_POSITION, address(manager), NFT_ID)
        );
        bytes32 key = vault.getLoan(id).exposureKey;
        bytes[5] memory invalid = [
            abi.encode(bytes32(uint256(1)), uint256(100), type(uint256).max),
            abi.encode(key, uint256(101), type(uint256).max),
            abi.encode(key, uint256(100), uint256(99)),
            abi.encode(key, uint256(100)),
            abi.encode(key, uint256(100), type(uint256).max, uint256(0))
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.mockCall(address(validator), callData, invalid[i]);
            vm.prank(curator);
            vm.expectRevert(abi.encodeWithSelector(HybridVault.IneligibleDeal.selector, id));
            hybrid.approveLoan(id, uint40(block.timestamp + 1 hours), 4);
        }
        assertEq(hybrid.approvedPrincipal(), 0);
    }

    function testRecoveryBoundaryCannotBeCalledByOutsiders() public {
        vm.expectRevert(HybridVault.NotOwner.selector);
        hybrid.recoverLoanCollateral(1);
    }
}
