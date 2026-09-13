// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TokenBaseTest} from "../token/TokenBase.t.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {GageV2Vault} from "../../src/v2/GageV2Vault.sol";
import {GageV2Rewards} from "../../src/v2/GageV2Rewards.sol";
import {GageV2Registry} from "../../src/v2/GageV2Registry.sol";
import {GageV2CollateralValidator} from "../../src/v2/GageV2CollateralValidator.sol";
import {GageV2CollateralAccount} from "../../src/v2/GageV2CollateralAccount.sol";
import {GageLegacyAdapter} from "../../src/v2/GageLegacyAdapter.sol";
import {Collateral, Kind, Lane} from "../../src/types/Types.sol";
import {V2Loan, V2State, V2Ask, V2LenderAsk, V2LenderPurchase} from "../../src/v2/V2Types.sol";

contract V2Handler is Test {
    GageV2Vault public immutable VAULT;
    GageV2Rewards public immutable REWARDS;
    GageLegacyAdapter public immutable BRIDGE;
    MockERC20 public immutable USDG;
    MockERC20 public immutable COLLATERAL;
    address[5] public actors;
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public legacyFees;
    mapping(bytes32 => uint256) public calls;
    mapping(uint256 => mapping(address => bool)) public recovered;

    constructor(GageV2Vault vault, MockERC20 usdg, MockERC20 collateral) {
        VAULT = vault;
        USDG = usdg;
        COLLATERAL = collateral;
        REWARDS = vault.REWARDS();
        BRIDGE = vault.BRIDGE();
        for (uint256 i; i < 5; ++i) {
            actors[i] = address(uint160(0x1100 + i));
            vm.startPrank(actors[i]);
            usdg.approve(address(vault), type(uint256).max);
            collateral.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function list(uint8 who, uint128 raw, bool longTerm) external {
        if (VAULT.loanCount() >= 24) return;
        address actor = actors[who % 5];
        uint128 principal = uint128(bound(raw, 4, 1_000_000e6));
        COLLATERAL.mint(actor, 1e18);
        vm.prank(actor);
        VAULT.list(
            Collateral(Kind.ERC20, address(COLLATERAL), 1e18),
            principal,
            principal + principal / 10,
            longTerm ? 21 days : 7 days,
            uint40(block.timestamp + 1 days),
            false
        );
        calls["list"]++;
    }

    function fund(uint256 seed, uint8 who, uint8 unitsSeed) external {
        uint256 id = _id(seed);
        V2Loan memory l = VAULT.getLoan(id);
        if (l.state != V2State.FUNDING || block.timestamp >= l.fundingDeadline) return;
        uint8 units = uint8(bound(unitsSeed, 1, 4 - l.filled));
        address actor = actors[who % 5];
        USDG.mint(actor, l.principal);
        uint256 beforeBalance = USDG.balanceOf(actor);
        vm.prank(actor);
        VAULT.fund(id, units);
        deposited += beforeBalance - USDG.balanceOf(actor);
        if (l.filled + units == 4) legacyFees += l.originationFee;
        calls["fund"]++;
    }

    function refund(uint256 seed, uint8 who) external {
        uint256 id = _id(seed);
        address actor = actors[who % 5];
        if (VAULT.getLoan(id).state != V2State.FUNDING || VAULT.unitsOf(id, actor) == 0) return;
        vm.prank(actor);
        VAULT.withdrawCommitment(id);
        calls["refund"]++;
    }

    function cancel(uint256 seed) external {
        uint256 id = _id(seed);
        V2Loan memory l = VAULT.getLoan(id);
        if (l.state != V2State.FUNDING) return;
        vm.prank(l.originator);
        VAULT.cancelFunding(id);
        calls["cancel"]++;
    }

    function sell(uint256 seed, uint8 who, uint128 raw) external {
        uint256 id = _id(seed);
        V2Loan memory l = VAULT.getLoan(id);
        if (l.state != V2State.ACTIVE || block.timestamp + 1 hours >= uint256(l.fundedAt) + l.term + VAULT.GRACE()) {
            return;
        }
        address seller = VAULT.ownerOf(id);
        address buyer = actors[who % 5];
        uint128 price = uint128(bound(raw, 1, 100_000e6));
        vm.prank(seller);
        VAULT.setAsk(id, price, uint40(block.timestamp + 1 hours));
        V2Ask memory ask = VAULT.getAsk(id);
        USDG.mint(buyer, price);
        vm.prank(buyer);
        VAULT.buy(id, seller, ask.nonce, price, 100, buyer);
        deposited += price;
        calls["sale"]++;
    }

    function repay(uint256 seed) external {
        uint256 id = _id(seed);
        V2Loan memory l = VAULT.getLoan(id);
        if (l.state != V2State.ACTIVE) return;
        address actor = VAULT.ownerOf(id);
        USDG.mint(actor, l.cap);
        vm.prank(actor);
        VAULT.reclaim(id, actor);
        deposited += l.cap;
        calls["repay"]++;
    }

    function sellLender(uint256 seed, uint8 slotSeed, uint8 who, uint128 raw) external {
        uint256 id = _id(seed);
        if (VAULT.getLoan(id).state != V2State.ACTIVE) return;
        uint8 slot = slotSeed % 4;
        address seller = VAULT.lenders(id)[slot];
        address buyer = actors[who % 5];
        if (seller == buyer) return;
        uint128 price = uint128(bound(raw, 1, 100_000e6));
        uint8 mask = uint8(1 << slot);
        vm.prank(seller);
        VAULT.setLenderAsk(id, mask, price, uint40(block.timestamp + 1 hours), 100);
        V2LenderAsk memory ask = VAULT.getLenderAsk(id, seller);
        USDG.mint(buyer, price);
        vm.prank(buyer);
        VAULT.buyLender(id, V2LenderPurchase(seller, buyer, mask, price, 100, ask.nonce, 0));
        deposited += price;
        calls["lenderSale"]++;
    }

    function finalizeDefault(uint256 seed) external {
        uint256 id = _id(seed);
        V2Loan memory l = VAULT.getLoan(id);
        if (l.state != V2State.ACTIVE || block.timestamp < uint256(l.fundedAt) + l.term + VAULT.GRACE()) return;
        VAULT.finalizeDefault(id);
        calls["default"]++;
    }

    function withdrawCollateral(uint256 seed) external {
        uint256 id = _id(seed);
        V2Loan memory l = VAULT.getLoan(id);
        if (l.state != V2State.REPAID && l.state != V2State.CANCELLED) return;
        if (GageV2CollateralAccount(payable(l.account)).released()) return;
        vm.prank(l.collateralBeneficiary);
        VAULT.withdrawCollateral(id, l.collateralBeneficiary);
        calls["collateral"]++;
    }

    function recover(uint256 seed, uint8 who) external {
        uint256 id = _id(seed);
        V2Loan memory l = VAULT.getLoan(id);
        address actor = actors[who % 5];
        if (l.state != V2State.DEFAULTED || VAULT.unitsOf(id, actor) == 0 || recovered[id][actor]) return;
        bool ready = GageV2CollateralAccount(payable(l.account)).recovered();
        vm.startPrank(actor);
        if (!ready) VAULT.recoverDefault(id, 0, 0, block.timestamp);
        VAULT.withdrawRecovery(id, 0, actor);
        vm.stopPrank();
        recovered[id][actor] = true;
        calls["recovery"]++;
    }

    function claim(uint256 seed, uint8 who) external {
        uint256 id = _id(seed);
        address actor = actors[who % 5];
        // Claim at the current timestamp; repeated actions also exercise source/ledger rounding boundaries.
        if (REWARDS.claimable(id, actor) == 0) return;
        REWARDS.claimFor(id, actor);
        calls["reward"]++;
    }

    function recycle(uint256 seed) external {
        uint256 id = BRIDGE.adapterId(address(VAULT), _id(seed));
        if (id == 0 || BRIDGE.loan(id).closedAt == 0) return;
        BRIDGE.recycle(id);
        calls["recycle"]++;
    }

    function withdrawCash(uint8 who) external {
        address actor = who % 6 == 5 ? VAULT.FEE_RECIPIENT() : actors[who % 5];
        uint256 amount = VAULT.cashCredit(actor);
        if (amount == 0) return;
        VAULT.withdrawUSDGFor(actor);
        withdrawn += amount;
        calls["cash"]++;
    }

    function advance(uint32 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 0, 10 days));
    }

    function _id(uint256 seed) private view returns (uint256) {
        uint256 count = VAULT.loanCount();
        return count == 0 ? 0 : 1 + seed % count;
    }
}

contract GageV2InvariantTest is TokenBaseTest {
    GageV2Vault internal v2;
    GageLegacyAdapter internal bridge;
    V2Handler internal handler;

    function setUp() public override {
        super.setUp();
        bridge = new GageLegacyAdapter(address(this), vault, dealRewards, usdg);
        vm.startPrank(safe);
        registry.setFee(100);
        registry.setERC20Allowed(address(bridge), true, Lane.STOCK, 1, 1, type(uint256).max);
        vm.stopPrank();
        uint32[] memory terms = new uint32[](2);
        terms[0] = T7;
        terms[1] = T21;
        GageV2Registry cfg = new GageV2Registry(address(this), terms, address(this));
        cfg.setERC20Allowed(address(nvda), true, Lane.STOCK, 1, type(uint128).max, type(uint256).max);
        GageV2CollateralValidator validator =
            new GageV2CollateralValidator(cfg, address(usdg), address(sgage), address(0), address(0));
        v2 = new GageV2Vault(validator, treasury, uint32(GRACE), bridge);
        bridge.setEngine(address(v2));
        handler = new V2Handler(v2, usdg, nvda);
        // Seed an active and a partially funded loan so all transitions are reachable from the first run.
        handler.list(0, 1000e6, false);
        handler.fund(0, 1, 2);
        handler.fund(0, 2, 2);
        handler.list(1, 999_999_999, true);
        handler.fund(1, 0, 1);
        targetContract(address(handler));
    }

    function invariant_cashEqualsDepositsLessWithdrawalsAndExactlyOneOriginationFee() public view {
        assertEq(v2.accountedCash(), handler.deposited() - handler.withdrawn() - handler.legacyFees());
        assertEq(usdg.balanceOf(address(v2)), v2.accountedCash());
        assertEq(usdg.balanceOf(address(bridge)), 0);
    }

    function invariant_everyLiquidSourceTokenIsAllocatedOrFreeAndEveryReceiptHasOneActiveLoan() public view {
        uint256 liquid = bridge.recycledFree();
        uint256 active;
        for (uint256 id = 1; id <= bridge.loanCount(); ++id) {
            GageLegacyAdapter.Loan memory l = bridge.loan(id);
            liquid += l.liquid;
            if (l.closedAt == 0) ++active;
            assertEq(l.engine, address(v2));
            assertEq(l.ledger, address(v2.REWARDS()));
            assertLe(l.paid, uint256(l.borrowerReward) + l.lenderReward);
        }
        assertEq(sgage.balanceOf(address(bridge)), liquid);
        assertEq(bridge.totalSupply(), active);
        assertEq(sgage.balanceOf(address(v2.REWARDS())), 0);
    }

    function invariant_rewardLedgerPreservesEarnedClaimsAndOnlyActiveFutureAllocations() public view {
        uint256 liability;
        GageV2Rewards r = v2.REWARDS();
        for (uint256 id = 1; id <= v2.loanCount(); ++id) {
            V2Loan memory l = v2.getLoan(id);
            for (uint256 i; i < 5; ++i) {
                liability += r.claimable(id, handler.actors(i));
            }
            if (l.state == V2State.ACTIVE) {
                uint256 elapsed = block.timestamp - l.fundedAt;
                if (elapsed > l.term) elapsed = l.term;
                liability += uint256(l.borrowerReward) - uint256(l.borrowerReward) * elapsed * elapsed
                / (uint256(l.term) * l.term);
                liability += uint256(l.lenderReward) - uint256(l.lenderReward) * elapsed * elapsed
                / (uint256(l.term) * l.term);
            }
        }
        (, uint256 reserved) = r.budget();
        assertEq(reserved, liability);
    }
}
