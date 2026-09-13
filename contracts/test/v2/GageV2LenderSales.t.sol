// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GageV2VaultTest} from "./GageV2Vault.t.sol";
import {GageV2Vault} from "../../src/v2/GageV2Vault.sol";
import {GageV2Rewards} from "../../src/v2/GageV2Rewards.sol";
import {V2Loan, V2State, V2LenderAsk, V2LenderPurchase} from "../../src/v2/V2Types.sol";

contract GageV2LenderSalesTest is GageV2VaultTest {
    function _ask(uint256 id, address seller, uint8 slots) internal returns (V2LenderPurchase memory p) {
        vm.prank(seller);
        vault.setLenderAsk(id, slots, 260e6, uint40(block.timestamp + 1 days), 100);
        V2LenderAsk memory a = vault.getLenderAsk(id, seller);
        p = V2LenderPurchase(seller, buyer, slots, a.price, a.feeBps, a.nonce, 0);
    }

    function test_lenderSaleTransfersRepaymentAndKeepsEarnedRewards() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM / 2);
        uint256 sellerEarned = rewards.claimable(id, lender[0]);
        V2Loan memory beforeLoan = vault.getLoan(id);
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        uint256 cash = usdg.balanceOf(buyer);
        vm.prank(buyer);
        vault.buyLender(id, p);
        assertEq(usdg.balanceOf(buyer), cash - 260e6);
        assertEq(vault.cashCredit(lender[0]), 257_400_000);
        assertEq(vault.cashCredit(fees), 12_600_000);
        assertEq(vault.unitsOf(id, buyer), 1);
        assertEq(vault.unitsOf(id, lender[0]), 0);
        assertEq(rewards.claimable(id, lender[0]), sellerEarned);
        assertEq(rewards.claimable(id, buyer), 0);
        assertEq(vault.getLoan(id).fundedAt, beforeLoan.fundedAt);
        assertEq(vault.getLoan(id).cap, beforeLoan.cap);
        assertEq(vault.ownerOf(id), borrower);
        rewards.claimFor(id, lender[0]);
        vm.warp(block.timestamp + TERM / 4);
        assertGt(rewards.claimable(id, buyer), 0);
        vm.prank(borrower);
        vault.reclaim(id, borrower);
        assertEq(vault.cashCredit(buyer), 275e6);
        assertEq(vault.cashCredit(lender[0]), 257_400_000);
        uint256 earnedAtClose = rewards.claimable(id, buyer);
        vm.warp(block.timestamp + TERM);
        assertEq(rewards.claimable(id, buyer), earnedAtClose);
        rewards.claimFor(id, buyer);
        _assertCash();
        _assertRewards();
    }

    function test_nonAdjacentBundleTransfersExactQuartersAndAllDefaultRights() public {
        uint256 id = _list(1000e6 + 3, 1100e6 + 1, 100e18 + 3);
        vm.prank(lender[0]);
        vault.fund(id, 1);
        vm.prank(lender[1]);
        vault.fund(id, 1);
        vm.prank(lender[0]);
        vault.fund(id, 1);
        vm.prank(lender[2]);
        vault.fund(id, 1);
        V2LenderPurchase memory p = _ask(id, lender[0], 5);
        V2LenderAsk[4] memory asks = vault.getLenderAsks(id);
        assertEq(asks[0].slots, 5);
        assertEq(asks[2].price, 0);
        vm.prank(buyer);
        vault.buyLender(id, p);
        vm.warp(block.timestamp + TERM + GRACE);
        vault.finalizeDefault(id);
        vm.prank(buyer);
        vault.recoverDefault(id, 0, 0, block.timestamp);
        vm.prank(buyer);
        vault.withdrawRecovery(id, 0, buyer);
        vm.prank(lender[1]);
        vault.withdrawRecovery(id, 0, lender[1]);
        vm.prank(lender[2]);
        vault.withdrawRecovery(id, 0, lender[2]);
        assertEq(stock.balanceOf(buyer), 50e18 + 2);
        assertEq(stock.balanceOf(buyer) + stock.balanceOf(lender[1]) + stock.balanceOf(lender[2]), 100e18 + 3);
        vm.expectRevert(GageV2Vault.NothingToClaim.selector);
        vm.prank(lender[0]);
        vault.withdrawRecovery(id, 0, lender[0]);
        vm.expectRevert(GageV2Vault.WrongState.selector);
        vm.prank(buyer);
        vault.withdrawRecovery(id, 0, buyer);
    }

    function test_priorClaimsRepeatedSalesAndBorrowerLenderOverlapConserveAllocation() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM / 4);
        rewards.claimFor(id, lender[0]);
        for (uint8 i; i < 12; ++i) {
            address seller = vault.lenders(id)[0];
            V2LenderPurchase memory p = _ask(id, seller, 1);
            p.recipient = seller == borrower ? lender[0] : borrower;
            vm.prank(buyer);
            vault.buyLender(id, p);
        }
        vm.warp(vault.getLoan(id).fundedAt + TERM);
        uint256 total;
        address[6] memory actors = [borrower, buyer, lender[0], lender[1], lender[2], lender[3]];
        for (uint8 i; i < actors.length; ++i) {
            total += sgage.balanceOf(actors[i]) + rewards.claimable(id, actors[i]);
            if (rewards.claimable(id, actors[i]) > 0) rewards.claimFor(id, actors[i]);
        }
        V2Loan memory l = vault.getLoan(id);
        assertEq(total, uint256(l.borrowerReward) + l.lenderReward);
        vm.prank(borrower);
        vault.reclaim(id, borrower);
        _assertCash();
        _assertRewards();
    }

    function test_staleCancellationRelistDeadlineAndExactBundleBinding() public {
        uint256 id = _active();
        V2LenderPurchase memory old = _ask(id, lender[0], 1);
        vm.prank(lender[0]);
        vault.cancelLenderAsk(id);
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vm.prank(buyer);
        vault.buyLender(id, old);
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vm.prank(buyer);
        vault.buyLender(id, old);
        p.slots = 3;
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vm.prank(buyer);
        vault.buyLender(id, p);
        p.slots = 1;
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vm.prank(buyer);
        vault.buyLender(id, p);
    }

    function test_ownershipAndStateAreRequiredAndZeroOrOutsideMasksFail() public {
        uint256 id = _list(1000e6, 1100e6, 100e18);
        vm.prank(lender[0]);
        vault.fund(id, 1);
        vm.expectRevert(GageV2Vault.WrongState.selector);
        vm.prank(lender[0]);
        vault.setLenderAsk(id, 1, 1, uint40(block.timestamp + 1), 100);
        vm.prank(lender[1]);
        vault.fund(id, 3);
        vm.expectRevert(GageV2Vault.NotAuthorized.selector);
        vm.prank(lender[0]);
        vault.setLenderAsk(id, 3, 1, uint40(block.timestamp + 1), 100);
        vm.expectRevert(GageV2Vault.InvalidUnits.selector);
        vm.prank(lender[0]);
        vault.setLenderAsk(id, 0, 1, uint40(block.timestamp + 1), 100);
        vm.expectRevert(GageV2Vault.InvalidUnits.selector);
        vm.prank(lender[0]);
        vault.setLenderAsk(id, 16, 1, uint40(block.timestamp + 1), 100);
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        p.recipient = address(0);
        vm.expectRevert(GageV2Vault.InvalidRecipient.selector);
        vm.prank(buyer);
        vault.buyLender(id, p);
        p.recipient = lender[0];
        vm.expectRevert(GageV2Vault.InvalidRecipient.selector);
        vm.prank(buyer);
        vault.buyLender(id, p);
    }

    function test_feeIsSnapshottedAndBothSidesApproveIt() public {
        uint256 id = _active();
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vm.prank(lender[0]);
        vault.setLenderAsk(id, 1, 260e6, uint40(block.timestamp + 1 days), 99);
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        registry.setTradeFee(200);
        p.maxFeeBps = 99;
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vm.prank(buyer);
        vault.buyLender(id, p);
        p.maxFeeBps = 100;
        vm.prank(buyer);
        vault.buyLender(id, p);
        assertEq(vault.cashCredit(lender[0]), 257_400_000);
    }

    function test_failedPaymentRollsBackOwnershipRewardsAndAsk() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM / 2);
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        uint256 earned = rewards.claimable(id, lender[0]);
        vm.prank(buyer);
        usdg.approve(address(vault), 0);
        vm.expectRevert();
        vm.prank(buyer);
        vault.buyLender(id, p);
        assertEq(vault.unitsOf(id, lender[0]), 1);
        assertEq(vault.unitsOf(id, buyer), 0);
        assertEq(rewards.claimable(id, lender[0]), earned);
        assertEq(vault.getLenderAsk(id, lender[0]).nonce, p.nonce);
        assertEq(vault.cashCredit(lender[0]), 0);
        _assertCash();
        _assertRewards();
    }

    function test_minimumRemainingRewardsProtectsDelayedPurchases() public {
        uint256 id = _active();
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        p.minRemainingReward = rewards.remainingLenderReward(id, 1);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(GageV2Vault.StaleAsk.selector);
        vm.prank(buyer);
        vault.buyLender(id, p);
        p.minRemainingReward = rewards.remainingLenderReward(id, 1);
        vm.prank(buyer);
        vault.buyLender(id, p);
    }

    function test_saleAfterGraceUntilFinalizationAndRepaymentRace() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM + GRACE);
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        registry.pauseNewDeals(true);
        vm.prank(buyer);
        vault.buyLender(id, p);
        assertEq(rewards.remainingLenderReward(id, 1), 0);
        V2LenderPurchase memory next = _ask(id, lender[1], 2);
        vm.prank(borrower);
        vault.reclaim(id, borrower);
        vm.expectRevert(GageV2Vault.WrongState.selector);
        vm.prank(buyer);
        vault.buyLender(id, next);
        assertEq(vault.getLenderAsks(id)[1].price, 0);
        assertEq(vault.cashCredit(buyer), 275e6);
    }

    function test_defaultFinalizationInvalidatesEveryAskBeforeRecovery() public {
        uint256 id = _active();
        vm.warp(block.timestamp + TERM + GRACE);
        V2LenderPurchase memory p = _ask(id, lender[0], 1);
        vault.finalizeDefault(id);
        vm.expectRevert(GageV2Vault.WrongState.selector);
        vm.prank(buyer);
        vault.buyLender(id, p);
        vm.expectRevert(GageV2Vault.WrongState.selector);
        vm.prank(lender[0]);
        vault.setLenderAsk(id, 1, 1, uint40(block.timestamp + 1), 100);
    }

    function testFuzz_lenderCurvePartitionConservesEveryRawUnit(uint128 total, uint32 elapsed, uint8 mask) public {
        total = uint128(bound(total, 1, 1e30));
        elapsed = uint32(bound(elapsed, 0, TERM));
        mask = uint8(bound(mask, 1, 15));
        GageV2Rewards ledger = new GageV2Rewards(sgage);
        sgage.mint(address(this), total);
        sgage.approve(address(ledger), total);
        ledger.fund(total);
        address[4] memory initial = [lender[0], lender[0], lender[0], lender[0]];
        ledger.activate(1, borrower, initial, TERM, 0, total);
        uint256 start = block.timestamp;
        vm.warp(start + elapsed);
        uint256 before = ledger.claimable(1, lender[0]);
        if (before > 0) ledger.claimFor(1, lender[0]);
        ledger.transferLender(1, lender[0], borrower, mask);
        ledger.transferLender(1, borrower, buyer, mask);
        ledger.transferLender(1, buyer, lender[0], mask);
        ledger.transferLender(1, lender[0], buyer, mask);
        assertEq(ledger.claimable(1, borrower), 0);
        assertEq(ledger.claimable(1, buyer), 0);
        vm.warp(start + TERM);
        ledger.close(1);
        assertEq(before + ledger.claimable(1, lender[0]) + ledger.claimable(1, buyer), total);
        if (ledger.claimable(1, lender[0]) > 0) ledger.claimFor(1, lender[0]);
        if (ledger.claimable(1, buyer) > 0) ledger.claimFor(1, buyer);
        (, uint256 reserved) = ledger.budget();
        assertEq(reserved, 0);
        assertEq(sgage.balanceOf(address(ledger)), 0);
    }
}
