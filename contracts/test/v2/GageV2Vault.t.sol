// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GageLegacyAdapter} from "../../src/v2/GageLegacyAdapter.sol";

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {GageV2Vault} from "../../src/v2/GageV2Vault.sol";
import {GageV2Rewards} from "../../src/v2/GageV2Rewards.sol";
import {GageV2Registry} from "../../src/v2/GageV2Registry.sol";
import {GageV2CollateralValidator} from "../../src/v2/GageV2CollateralValidator.sol";
import {GageV2CollateralAccount} from "../../src/v2/GageV2CollateralAccount.sol";
import {V2Loan, V2State, V2Ask} from "../../src/v2/V2Types.sol";
import {Collateral, Kind, Lane} from "../../src/types/Types.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract GageV2VaultTest is Test {
    MockERC20 internal usdg;
    MockERC20 internal sgage;
    MockERC20 internal stock;
    GageV2Registry internal registry;
    GageV2Vault internal vault;
    GageV2Rewards internal rewards;
    address internal borrower = makeAddr("borrower");
    address internal buyer = makeAddr("buyer");
    address internal fees = makeAddr("fees");
    address[4] internal lender;
    uint32 internal constant TERM = 7 days;
    uint32 internal constant GRACE = 1 days;

    function setUp() public virtual {
        vm.warp(10_000);
        usdg = new MockERC20("test USDG", "tUSDG", 6);
        sgage = new MockERC20("test sGAGE", "tsGAGE", 18);
        stock = new MockERC20("test stock", "tSTOCK", 18);
        uint32[] memory terms = new uint32[](1);
        terms[0] = TERM;
        registry = new GageV2Registry(address(this), terms, address(this));
        registry.setERC20Allowed(address(stock), true, Lane.STOCK, 1, type(uint128).max, type(uint256).max);
        registry.setRewardTerms(TERM, 100e18, 1, 5000);
        _deployVault(address(0), address(0));
        for (uint8 i; i < 4; ++i) {
            lender[i] = makeAddr(string(abi.encodePacked("lender", i)));
            usdg.mint(lender[i], 1_000_000e6);
            vm.prank(lender[i]);
            usdg.approve(address(vault), type(uint256).max);
        }
        usdg.mint(borrower, 1_000_000e6);
        usdg.mint(buyer, 1_000_000e6);
        stock.mint(borrower, 1_000_000e18);
        vm.startPrank(borrower);
        usdg.approve(address(vault), type(uint256).max);
        stock.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.prank(buyer);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _deployVault(address v3, address v4) internal {
        GageV2CollateralValidator validator =
            new GageV2CollateralValidator(registry, address(usdg), address(sgage), v3, v4);
        vault = new GageV2Vault(validator, fees, GRACE, GageLegacyAdapter(address(0)));
        rewards = vault.REWARDS();
        sgage.mint(address(this), 1_000_000e18);
        sgage.approve(address(rewards), type(uint256).max);
        rewards.fund(1_000_000e18);
    }

    function _list(uint128 principal, uint128 cap, uint256 amount) internal returns (uint256 id) {
        vm.prank(borrower);
        return vault.list(
            Collateral(Kind.ERC20, address(stock), amount), principal, cap, TERM, uint40(block.timestamp + 1 days), true
        );
    }

    function _active() internal returns (uint256 id) {
        id = _list(1000e6, 1100e6, 100e18);
        for (uint8 i; i < 4; ++i) {
            vm.prank(lender[i]);
            vault.fund(id, 1);
        }
    }

    function _trade(uint256 id, address seller, address receiver) internal {
        vm.prank(seller);
        vault.setAsk(id, 200e6, uint40(block.timestamp + 1 hours));
        V2Ask memory ask = vault.getAsk(id);
        vm.prank(buyer);
        vault.buy(id, seller, ask.nonce, 200e6, 100, receiver);
    }

    function _assertCash() internal view {
        assertEq(usdg.balanceOf(address(vault)), vault.accountedCash());
    }

    function _assertRewards() internal view {
        (uint256 free, uint256 reserved) = rewards.budget();
        assertEq(sgage.balanceOf(address(rewards)), free + reserved);
    }

    function test_onlyFourthUnitStartsClockProceedsFeesAndRewards() public {
        uint256 id = _list(1000e6, 1100e6, 100e18);
        vm.prank(lender[0]);
        vault.fund(id, 3);
        vm.warp(block.timestamp + 12 hours);
        V2Loan memory l = vault.getLoan(id);
        assertEq(uint256(l.state), uint256(V2State.FUNDING));
        assertEq(l.fundedAt, 0);
        assertEq(vault.cashCredit(borrower), 0);
        assertEq(vault.cashCredit(fees), 0);
        assertEq(vault.claimableRewards(id, lender[0]), 0);
        vm.prank(lender[1]);
        vault.fund(id, 1);
        l = vault.getLoan(id);
        assertEq(l.fundedAt, block.timestamp);
        assertEq(vault.cashCredit(borrower), 990e6);
        assertEq(vault.cashCredit(fees), 10e6);
        assertEq(vault.unitsOf(id, lender[0]), 3);
        _assertCash();
        _assertRewards();
    }

    function test_withdrawRefillCancelRefundsExactlyAndPausePreservesExits() public {
        uint256 id = _list(1000e6 + 3, 1100e6, 100e18);
        vm.prank(lender[0]);
        vault.fund(id, 2);
        vm.prank(lender[1]);
        vault.fund(id, 1);
        vm.prank(lender[0]);
        vault.withdrawCommitment(id);
        assertEq(vault.cashCredit(lender[0]), 500e6 + 2);
        vm.prank(lender[2]);
        vault.fund(id, 1);
        registry.pauseNewDeals(true);
        vm.prank(borrower);
        vault.cancelFunding(id);
        assertEq(vault.cashCredit(lender[1]), 250e6 + 1);
        assertEq(vault.cashCredit(lender[2]), 250e6 + 1);
        vm.prank(borrower);
        vault.withdrawCollateral(id, borrower);
        assertEq(stock.balanceOf(borrower), 1_000_000e18);
        for (uint8 i; i < 3; ++i) {
            vault.withdrawUSDGFor(lender[i]);
        }
        assertEq(vault.accountedCash(), 0);
        _assertCash();
    }

    function test_timeoutAnyoneRefundsButCannotTakeCollateral() public {
        uint256 id = _list(1000e6, 1100e6, 100e18);
        vm.prank(lender[0]);
        vault.fund(id, 1);
        vm.expectRevert(GageV2Vault.NotAuthorized.selector);
        vault.cancelFunding(id);
        vm.warp(block.timestamp + 1 days);
        vault.cancelFunding(id);
        vm.expectRevert(GageV2Vault.NotAuthorized.selector);
        vault.withdrawCollateral(id, buyer);
        vault.withdrawUSDGFor(lender[0]);
        assertEq(vault.accountedCash(), 0);
    }

    function test_tradeChargesOnePercentAndPreservesEarnedRewardAcrossUnclaimedSale() public {
        uint256 id = _active();
        uint256 start = vault.getLoan(id).fundedAt;
        vm.warp(start + TERM / 2);
        _trade(id, borrower, buyer);
        assertEq(vault.ownerOf(id), buyer);
        assertEq(vault.cashCredit(borrower), 990e6 + 198e6);
        assertEq(vault.cashCredit(fees), 10e6 + 2e6);
        assertEq(rewards.claimable(id, borrower), 125e18);
        vm.warp(start + TERM * 4 / 5);
        vm.prank(buyer);
        vault.reclaim(id, buyer);
        assertEq(rewards.claimable(id, borrower), 125e18);
        assertEq(rewards.claimable(id, buyer), 195e18);
        vm.prank(borrower);
        rewards.claim(id, borrower);
        vm.prank(buyer);
        rewards.claim(id, buyer);
        for (uint8 i; i < 4; ++i) {
            rewards.claimFor(id, lender[i]);
        }
        (uint256 free, uint256 reserved) = rewards.budget();
        assertEq(free, 1_000_000e18 - 640e18);
        assertEq(reserved, 0);
        _assertCash();
        _assertRewards();
    }

    function test_claimBeforeSaleAndSameAccountBorrowerLenderCannotDoubleClaim() public {
        uint256 id = _list(1000e6, 1100e6, 100e18);
        vm.prank(borrower);
        vault.fund(id, 2);
        vm.prank(lender[0]);
        vault.fund(id, 2);
        uint256 start = vault.getLoan(id).fundedAt;
        vm.warp(start + TERM / 2);
        vm.prank(borrower);
        rewards.claim(id, borrower);
        assertEq(sgage.balanceOf(borrower), 187.5e18);
        _trade(id, borrower, buyer);
        assertEq(rewards.claimable(id, borrower), 0);
        vm.warp(start + TERM);
        vm.prank(buyer);
        vault.reclaim(id, buyer);
        assertEq(rewards.claimable(id, borrower), 187.5e18);
        assertEq(rewards.claimable(id, buyer), 375e18);
        _assertRewards();
    }

    function test_underfundedRewardBudgetRevertsFourthContributionOnly() public {
        uint256 id = _list(20_000e6, 22_000e6, 100e18);
        // Drain the free budget through a separate valid reservation in a small ledger fixture.
        GageV2Rewards empty = new GageV2Rewards(sgage);
        vm.expectRevert(GageV2Rewards.InsufficientBudget.selector);
        empty.activate(1, borrower, lender, TERM, 1, 0);
        // The actual vault's last funding call is atomic when its reward allocation cannot be reserved.
        registry.setRewardTerms(TERM, 1_000_000e18, 1, 5000);
        id = _list(1000e6, 1100e6, 100e18);
        vm.prank(lender[0]);
        vault.fund(id, 3);
        uint256 beforeBalance = usdg.balanceOf(lender[1]);
        vm.prank(lender[1]);
        vm.expectRevert(GageV2Rewards.InsufficientBudget.selector);
        vault.fund(id, 1);
        assertEq(usdg.balanceOf(lender[1]), beforeBalance);
        assertEq(vault.getLoan(id).filled, 3);
        vm.prank(lender[0]);
        vault.withdrawCommitment(id);
        _assertCash();
    }

    function test_pausedOrBlockedRewardTokenDoesNotBlockRepaymentOrRecovery() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM / 2);
        sgage.setPaused(true);
        registry.pauseNewDeals(true);
        vm.prank(borrower);
        vault.reclaim(id, borrower);
        vm.prank(borrower);
        vault.withdrawCollateral(id, borrower);
        for (uint8 i; i < 4; ++i) {
            vault.withdrawUSDGFor(lender[i]);
        }
        vm.prank(borrower);
        vm.expectRevert(MockERC20.EnforcedPause.selector);
        rewards.claim(id, borrower);
        sgage.setPaused(false);
        rewards.claimFor(id, borrower);
        _assertRewards();
    }

    function test_fullCapRequiredAndRepaymentReturnsWholeCollateral() public {
        uint256 id = _active();
        vm.prank(borrower);
        usdg.approve(address(vault), 275e6);
        vm.prank(borrower);
        vm.expectRevert();
        vault.reclaim(id, borrower);
        assertEq(uint256(vault.getLoan(id).state), uint256(V2State.ACTIVE));
        vm.prank(borrower);
        usdg.approve(address(vault), 1100e6);
        vm.prank(borrower);
        vault.reclaim(id, borrower);
        for (uint8 i; i < 4; ++i) {
            assertEq(vault.cashCredit(lender[i]), 275e6);
        }
        vm.prank(borrower);
        vault.withdrawCollateral(id, borrower);
        vm.prank(borrower);
        vm.expectRevert();
        vault.withdrawCollateral(id, borrower);
        _assertCash();
    }

    function test_saleNoncePriceFeeAndRecipientAreBoundAndRawTransfersDisabled() public {
        uint256 id = _active();
        vm.prank(borrower);
        vm.expectRevert(GageV2Vault.UseMarketplace.selector);
        vault.transferFrom(borrower, buyer, id);
        vm.prank(borrower);
        vault.setAsk(id, 200e6, uint40(block.timestamp + 100));
        V2Ask memory ask = vault.getAsk(id);
        vm.prank(buyer);
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vault.buy(id, borrower, ask.nonce, 199e6, 100, buyer);
        vm.prank(buyer);
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vault.buy(id, borrower, ask.nonce, 200e6, 99, buyer);
        vm.prank(borrower);
        vault.cancelAsk(id);
        vm.prank(buyer);
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vault.buy(id, borrower, ask.nonce, 200e6, 100, buyer);
        assertEq(vault.ownerOf(id), borrower);
        _assertCash();
    }

    function test_repayStillAvailableAfterGraceUntilDefaultExecutes() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM + GRACE);
        vm.prank(borrower);
        vm.expectRevert(GageV2Vault.Deadline.selector);
        vault.setAsk(id, 1e6, uint40(block.timestamp + 1));
        vm.prank(borrower);
        vault.reclaim(id, borrower);
        vm.expectRevert(GageV2Vault.WrongState.selector);
        vault.finalizeDefault(id);
    }

    function test_defaultProportionateUnderlyingAndIndependentWithdrawals() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM + GRACE);
        vault.finalizeDefault(id);
        vm.prank(lender[0]);
        vault.recoverDefault(id, 0, 0, block.timestamp);
        stock.setBlocked(lender[1], true);
        vm.prank(lender[1]);
        vm.expectRevert();
        vault.withdrawRecovery(id, 0, lender[1]);
        for (uint8 i; i < 4; ++i) {
            address recipient = i == 1 ? buyer : lender[i];
            vm.prank(lender[i]);
            vault.withdrawRecovery(id, 0, recipient);
            assertEq(stock.balanceOf(recipient), 25e18);
        }
        vm.prank(lender[0]);
        vm.expectRevert(GageV2Vault.WrongState.selector);
        vault.withdrawRecovery(id, 0, buyer);
        assertEq(stock.balanceOf(vault.getLoan(id).account), 0);
        _assertRewards();
    }

    function testFuzz_partitionsConserveCashAndDefaultUnderlying(uint128 principal, uint128 amount, uint8 first)
        public
    {
        principal = uint128(bound(principal, 4, 1_000_000e6));
        amount = uint128(bound(amount, 1, 1_000_000e18));
        first = uint8(bound(first, 1, 3));
        uint256 id = _list(principal, principal, amount);
        vm.prank(lender[0]);
        vault.fund(id, first);
        vm.prank(lender[1]);
        vault.fund(id, 4 - first);
        vm.warp(block.timestamp + TERM + GRACE);
        vault.finalizeDefault(id);
        vm.prank(lender[0]);
        vault.recoverDefault(id, 0, 0, block.timestamp);
        for (uint8 i; i < 2; ++i) {
            // Zero raw-unit allocations are possible for tiny collateral amounts.
            if (amount >= 4 || (i == 0 || amount > first)) {
                vm.prank(lender[i]);
                vault.withdrawRecovery(id, 0, lender[i]);
            }
        }
        assertEq(stock.balanceOf(lender[0]) + stock.balanceOf(lender[1]), amount);
        _assertCash();
        _assertRewards();
    }

    function test_deploymentSizesRespectEip170() public view {
        assertLe(address(vault).code.length, 24_576);
        // Four constructor arguments are appended to creation code (EIP-3860).
        assertLe(type(GageV2Vault).creationCode.length + 128, 49_152);
        assertLe(address(rewards).code.length, 24_576);
        assertLe(vault.ACCOUNT_IMPLEMENTATION().code.length, 24_576);
    }

    function test_rejectedNftReceiptRollsBackPaymentRewardCheckpointAndOwnership() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM / 2);
        vm.prank(borrower);
        vault.setAsk(id, 200e6, uint40(block.timestamp + 100));
        V2Ask memory ask = vault.getAsk(id);
        uint256 cash = usdg.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert();
        vault.buy(id, borrower, ask.nonce, ask.price, 100, address(rewards));
        assertEq(vault.ownerOf(id), borrower);
        assertEq(usdg.balanceOf(buyer), cash);
        assertEq(vault.cashCredit(fees), 10e6);
        assertEq(rewards.claimable(id, borrower), 125e18);
        assertEq(vault.getAsk(id).nonce, ask.nonce);
        _assertCash();
        _assertRewards();
    }

    function test_tinyRewardsRemainMonotonicAcrossFrequentClaimsAndNoDustLiability() public {
        registry.setRewardTerms(TERM, 1, 1, 5000);
        uint256 id = _active(); // Ten wei total reward, five borrower and five lenders.
        uint256 start = vault.getLoan(id).fundedAt;
        for (uint256 step = 1; step <= 20; ++step) {
            vm.warp(start + TERM * step / 20);
            if (rewards.claimable(id, borrower) != 0) rewards.claimFor(id, borrower);
            for (uint8 i; i < 4; ++i) {
                if (rewards.claimable(id, lender[i]) != 0) rewards.claimFor(id, lender[i]);
            }
            _assertRewards();
        }
        vm.prank(borrower);
        vault.reclaim(id, borrower);
        (, uint256 reserved) = rewards.budget();
        assertEq(reserved, 0);
        assertEq(sgage.balanceOf(borrower), 5);
        uint256 total;
        for (uint8 i; i < 4; ++i) {
            total += sgage.balanceOf(lender[i]);
        }
        assertEq(total, 5);
    }

    function test_registryChangesCannotRepricePendingLoanOrExistingAsk() public {
        uint256 id = _list(1000e6, 1100e6, 100e18);
        registry.setFee(200);
        registry.setRewardTerms(TERM, 0, 1, 5000);
        for (uint8 i; i < 4; ++i) {
            vm.prank(lender[i]);
            vault.fund(id, 1);
        }
        assertEq(vault.cashCredit(borrower), 990e6);
        assertEq(vault.getLoan(id).borrowerReward, 500e18);
        vm.prank(borrower);
        vault.setAsk(id, 200e6, uint40(block.timestamp + 100));
        V2Ask memory ask = vault.getAsk(id);
        registry.setTradeFee(200);
        vm.prank(buyer);
        vault.buy(id, borrower, ask.nonce, ask.price, 100, buyer);
        assertEq(vault.cashCredit(fees), 12e6);
    }

    function test_twentySameBlockSelfFundingLoopsEarnZeroAndPayEveryOriginationFee() public {
        uint256 initialCash = usdg.balanceOf(borrower);
        (uint256 initialFree,) = rewards.budget();
        for (uint256 cycle; cycle < 20; ++cycle) {
            uint256 id = _list(1000e6, 1100e6, 100e18);
            vm.startPrank(borrower);
            vault.fund(id, 4);
            vault.reclaim(id, borrower);
            vault.withdrawCollateral(id, borrower);
            vault.withdrawUSDG(borrower);
            vm.stopPrank();
            assertEq(rewards.claimable(id, borrower), 0, "borrower plus all four lender rewards are zero");
            vm.prank(borrower);
            vm.expectRevert(GageV2Rewards.NothingToClaim.selector);
            rewards.claim(id, borrower);
        }
        assertEq(usdg.balanceOf(borrower), initialCash - 200e6);
        assertEq(vault.cashCredit(fees), 200e6);
        assertEq(sgage.balanceOf(borrower), 0);
        (uint256 free, uint256 reserved) = rewards.budget();
        assertEq(free, initialFree);
        assertEq(reserved, 0);
        _assertCash();
        _assertRewards();
    }

    function test_twentyOneMinuteSelfFundingLoopsEarnOnlyTheirQuadraticFraction() public {
        uint256 initialCash = usdg.balanceOf(borrower);
        uint256 expected;
        for (uint256 cycle; cycle < 20; ++cycle) {
            uint256 id = _list(1000e6, 1100e6, 100e18);
            vm.startPrank(borrower);
            vault.fund(id, 4);
            // Read the per-loan start: via-IR may cache block.timestamp across vm.warp within this test transaction.
            vm.warp(uint256(vault.getLoan(id).fundedAt) + 1 minutes);
            vault.reclaim(id, borrower);
            vault.withdrawCollateral(id, borrower);
            vault.withdrawUSDG(borrower);
            uint256 oneSide = uint256(500e18) * 60 * 60 / (uint256(TERM) * TERM);
            expected += 2 * oneSide;
            assertEq(rewards.claimable(id, borrower), 2 * oneSide);
            rewards.claim(id, borrower);
            vm.stopPrank();
        }
        assertEq(usdg.balanceOf(borrower), initialCash - 200e6);
        assertEq(vault.cashCredit(fees), 200e6);
        assertEq(sgage.balanceOf(borrower), expected);
        assertLt(expected, 0.0002e18, "twenty one-minute loops earn less than 0.0002 sGAGE at these rates");
        (uint256 free, uint256 reserved) = rewards.budget();
        assertEq(reserved, 0);
        assertEq(free, 1_000_000e18 - expected);
        _assertRewards();
    }
}
