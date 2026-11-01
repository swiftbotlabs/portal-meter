// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MeterSettlement} from "../src/MeterSettlement.sol";
import {MockERC20, NoReturnToken, FalseToken, ReentrantToken, ISettlement} from "./Mocks.sol";

contract MeterSettlementTest is Test {
    MeterSettlement s;
    MockERC20 usd;
    address provider = makeAddr("provider");
    address payee = makeAddr("payee");
    address buyer = makeAddr("buyer");
    address other = makeAddr("other");
    uint96 constant PRICE = 25_000; // 0.025 of a 6-decimal token
    uint32 constant DELAY = 600;

    event Paid(bytes32 indexed requestId, uint32 indexed endpointId, address indexed payer, uint96 amount, bytes32 nonce);
    event Served(bytes32 indexed requestId, uint32 indexed endpointId, address payee, uint96 amount, bytes32 responseHash);
    event Refunded(
        bytes32 indexed requestId, uint32 indexed endpointId, address payer, uint96 amount, uint8 reason, bool byProvider
    );

    function setUp() public {
        s = new MeterSettlement();
        usd = new MockERC20("Meter Test USD", "tUSDm", 6);
        usd.mint(buyer, 1_000_000);
        vm.prank(buyer);
        usd.approve(address(s), type(uint256).max);
    }

    function _register() internal returns (uint32 id) {
        vm.prank(provider);
        id = s.registerEndpoint(payee, address(usd), PRICE, DELAY);
    }

    function _pay(uint32 id, bytes32 nonce) internal returns (bytes32 rid) {
        vm.prank(buyer);
        rid = s.pay(id, nonce, PRICE);
    }

    // ------------------------------------------------------------ registration
    function test_register_storesEndpoint() public {
        uint32 id = _register();
        assertEq(id, 1);
        assertEq(s.endpointCount(), 1);
        (address pr, address pe, address tk, uint96 price, uint32 d, bool active) = s.endpoint(id);
        assertEq(pr, provider);
        assertEq(pe, payee);
        assertEq(tk, address(usd));
        assertEq(price, PRICE);
        assertEq(d, DELAY);
        assertTrue(active);
    }

    function test_register_rejectsBadInput() public {
        vm.startPrank(provider);
        vm.expectRevert(MeterSettlement.ZeroAddress.selector);
        s.registerEndpoint(address(0), address(usd), PRICE, DELAY);
        vm.expectRevert(MeterSettlement.ZeroAddress.selector);
        s.registerEndpoint(payee, address(0), PRICE, DELAY);
        vm.expectRevert(MeterSettlement.ZeroPrice.selector);
        s.registerEndpoint(payee, address(usd), 0, DELAY);
        vm.expectRevert(MeterSettlement.BadRefundDelay.selector);
        s.registerEndpoint(payee, address(usd), PRICE, 59);
        vm.expectRevert(MeterSettlement.BadRefundDelay.selector);
        s.registerEndpoint(payee, address(usd), PRICE, 7 days + 1);
        vm.expectRevert(MeterSettlement.NotAToken.selector);
        s.registerEndpoint(payee, other, PRICE, DELAY); // an address without code is not a token
        vm.stopPrank();
    }

    function test_update_onlyProvider() public {
        uint32 id = _register();
        vm.prank(other);
        vm.expectRevert(MeterSettlement.NotProvider.selector);
        s.updateEndpoint(id, other, 1, DELAY, true);
        vm.expectRevert(MeterSettlement.UnknownEndpoint.selector);
        s.updateEndpoint(99, other, 1, DELAY, true);
        vm.prank(provider);
        s.updateEndpoint(id, other, 7, 120, false);
        (, address pe,, uint96 price, uint32 d, bool active) = s.endpoint(id);
        assertEq(pe, other);
        assertEq(price, 7);
        assertEq(d, 120);
        assertFalse(active);
    }

    // ------------------------------------------------------------ pay
    function test_pay_escrowsAndBindsPayer() public {
        uint32 id = _register();
        bytes32 nonce = keccak256("n1");
        bytes32 expected = keccak256(abi.encode(block.chainid, address(s), buyer, id, nonce));
        vm.expectEmit(true, true, true, true);
        emit Paid(expected, id, buyer, PRICE, nonce);
        bytes32 rid = _pay(id, nonce);
        assertEq(rid, expected);
        assertEq(rid, s.requestIdFor(buyer, id, nonce));
        assertEq(usd.balanceOf(address(s)), PRICE);
        (address payer, uint32 eid, uint8 st, uint40 at, uint96 amt) = s.payment(rid);
        assertEq(payer, buyer);
        assertEq(eid, id);
        assertEq(st, s.STATUS_PAID());
        assertEq(at, uint40(block.timestamp));
        assertEq(amt, PRICE);
    }

    function test_pay_sameNonceTwiceReverts() public {
        uint32 id = _register();
        _pay(id, bytes32(uint256(1)));
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.RequestExists.selector);
        s.pay(id, bytes32(uint256(1)), PRICE);
    }

    function test_pay_otherPayerSameNonceGetsOtherId() public {
        uint32 id = _register();
        bytes32 a = _pay(id, bytes32(uint256(1)));
        usd.mint(other, PRICE);
        vm.startPrank(other);
        usd.approve(address(s), PRICE);
        bytes32 b = s.pay(id, bytes32(uint256(1)), PRICE);
        vm.stopPrank();
        assertTrue(a != b);
        (address pa,,,,) = s.payment(a);
        (address pb,,,,) = s.payment(b);
        assertEq(pa, buyer);
        assertEq(pb, other);
    }

    function test_pay_guards() public {
        uint32 id = _register();
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.UnknownEndpoint.selector);
        s.pay(42, bytes32(0), PRICE);
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.PriceAboveMax.selector);
        s.pay(id, bytes32(0), PRICE - 1);
        vm.prank(provider);
        s.updateEndpoint(id, payee, PRICE, DELAY, false);
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.EndpointInactive.selector);
        s.pay(id, bytes32(0), PRICE);
    }

    function test_pay_withoutAllowanceReverts() public {
        uint32 id = _register();
        vm.prank(other);
        vm.expectRevert(MeterSettlement.TokenCallFailed.selector);
        s.pay(id, bytes32(0), PRICE);
    }

    function test_priceChangeDoesNotTouchOpenPayment() public {
        uint32 id = _register();
        bytes32 rid = _pay(id, bytes32(uint256(5)));
        vm.prank(provider);
        s.updateEndpoint(id, payee, PRICE * 4, DELAY, true);
        vm.prank(provider);
        s.settle(rid, bytes32(0));
        assertEq(usd.balanceOf(payee), PRICE);
    }

    // ------------------------------------------------------------ settle
    function test_settle_paysPayeeOnce() public {
        uint32 id = _register();
        bytes32 rid = _pay(id, bytes32(uint256(7)));
        bytes32 h = keccak256("response body");
        vm.expectEmit(true, true, false, true);
        emit Served(rid, id, payee, PRICE, h);
        vm.prank(provider);
        s.settle(rid, h);
        assertEq(usd.balanceOf(payee), PRICE);
        assertEq(usd.balanceOf(address(s)), 0);
        (, , uint8 st, , uint96 amt) = s.payment(rid);
        assertEq(st, s.STATUS_SERVED());
        assertEq(amt, 0);
        vm.prank(provider);
        vm.expectRevert(MeterSettlement.NotPaid.selector);
        s.settle(rid, h);
        vm.prank(provider);
        vm.expectRevert(MeterSettlement.NotPaid.selector);
        s.refund(rid, 1);
    }

    function test_settle_onlyProvider() public {
        uint32 id = _register();
        bytes32 rid = _pay(id, bytes32(uint256(8)));
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.NotProvider.selector);
        s.settle(rid, bytes32(0));
        vm.prank(other);
        vm.expectRevert(MeterSettlement.NotProvider.selector);
        s.settle(rid, bytes32(0));
        vm.expectRevert(MeterSettlement.NotPaid.selector);
        s.settle(keccak256("unknown"), bytes32(0));
    }

    // ------------------------------------------------------------ refund
    function test_refund_byProviderAnyTime() public {
        uint32 id = _register();
        bytes32 rid = _pay(id, bytes32(uint256(9)));
        uint256 before = usd.balanceOf(buyer);
        vm.expectEmit(true, true, false, true);
        emit Refunded(rid, id, buyer, PRICE, 1, true);
        vm.prank(provider);
        s.refund(rid, 1);
        assertEq(usd.balanceOf(buyer), before + PRICE);
        (, , uint8 st, , uint96 amt) = s.payment(rid);
        assertEq(st, s.STATUS_REFUNDED());
        assertEq(amt, 0);
        vm.prank(provider);
        vm.expectRevert(MeterSettlement.NotPaid.selector);
        s.settle(rid, bytes32(0));
        // a refunded request id can never be paid again
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.RequestExists.selector);
        s.pay(id, bytes32(uint256(9)), PRICE);
    }

    function test_refund_byPayerOnlyAfterDelay() public {
        uint32 id = _register();
        bytes32 rid = _pay(id, bytes32(uint256(10)));
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.RefundNotYetAllowed.selector);
        s.refund(rid, 2);
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.RefundNotYetAllowed.selector);
        s.refund(rid, 2);
        vm.warp(block.timestamp + 1);
        vm.prank(other);
        vm.expectRevert(MeterSettlement.NotAllowed.selector);
        s.refund(rid, 2);
        vm.expectEmit(true, true, false, true);
        emit Refunded(rid, id, buyer, PRICE, 2, false);
        vm.prank(buyer);
        s.refund(rid, 2);
        assertEq(usd.balanceOf(buyer), 1_000_000);
    }

    // ------------------------------------------------------------ token shapes
    function test_noReturnToken_works() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(buyer, 100);
        vm.prank(buyer);
        t.approve(address(s), 100);
        vm.prank(provider);
        uint32 id = s.registerEndpoint(payee, address(t), 40, DELAY);
        vm.prank(buyer);
        bytes32 rid = s.pay(id, bytes32(0), 40);
        vm.prank(provider);
        s.settle(rid, bytes32(0));
        assertEq(t.balanceOf(payee), 40);
    }

    function test_falseToken_reverts() public {
        FalseToken t = new FalseToken();
        vm.prank(provider);
        uint32 id = s.registerEndpoint(payee, address(t), 40, DELAY);
        vm.prank(buyer);
        vm.expectRevert(MeterSettlement.TokenCallFailed.selector);
        s.pay(id, bytes32(0), 40);
    }

    function test_reentrantRefundDuringSettleFails() public {
        ReentrantToken t = new ReentrantToken();
        t.mint(buyer, 100);
        vm.prank(buyer);
        t.approve(address(s), 100);
        // the attacker is the provider of its own endpoint with a hostile token
        vm.prank(address(t));
        uint32 id = s.registerEndpoint(payee, address(t), 50, DELAY);
        vm.prank(buyer);
        bytes32 rid = s.pay(id, bytes32(0), 50);
        t.arm(ISettlement(address(s)), rid);
        vm.prank(address(t));
        vm.expectRevert(MeterSettlement.TokenCallFailed.selector); // inner refund hits the guard, transfer fails
        s.settle(rid, bytes32(0));
        (, , uint8 st, , uint96 amt) = s.payment(rid);
        assertEq(st, s.STATUS_PAID()); // whole call rolled back, funds still escrowed once
        assertEq(amt, 50);
        assertEq(t.balanceOf(address(s)), 50);
    }

    // ------------------------------------------------------------ fuzz
    function testFuzz_requestIdBoundToPayer(address payer, bytes32 nonce) public {
        vm.assume(payer != address(0) && payer != address(s) && payer.code.length == 0);
        uint32 id = _register();
        usd.mint(payer, PRICE);
        vm.startPrank(payer);
        usd.approve(address(s), PRICE);
        bytes32 rid = s.pay(id, nonce, PRICE);
        vm.stopPrank();
        assertEq(rid, keccak256(abi.encode(block.chainid, address(s), payer, id, nonce)));
        (address p,,,,) = s.payment(rid);
        assertEq(p, payer);
    }

    function testFuzz_refundDelayWindow(uint32 delay, uint32 waitFor) public {
        delay = uint32(bound(delay, 60, 7 days));
        vm.prank(provider);
        uint32 id = s.registerEndpoint(payee, address(usd), PRICE, delay);
        bytes32 rid = _pay(id, bytes32(uint256(delay)));
        vm.warp(block.timestamp + uint256(waitFor) % (2 * uint256(delay)));
        bool allowed = uint256(waitFor) % (2 * uint256(delay)) >= delay;
        vm.prank(buyer);
        if (!allowed) vm.expectRevert(MeterSettlement.RefundNotYetAllowed.selector);
        s.refund(rid, 2);
    }
}

/// Invariant: the contract always holds exactly the sum of open (PAID) amounts.
contract Handler is Test {
    MeterSettlement public s;
    MockERC20 public usd;
    address public provider = address(0xA11CE);
    address public payee = address(0xBEEF);
    uint32 public id;
    bytes32[] public rids;
    uint256 public open;
    address[3] buyers = [address(0xB1), address(0xB2), address(0xB3)];

    constructor(MeterSettlement s_, MockERC20 u) {
        s = s_;
        usd = u;
        vm.prank(provider);
        id = s.registerEndpoint(payee, address(usd), 1000, 60);
        for (uint256 i = 0; i < 3; i++) {
            usd.mint(buyers[i], 1e12);
            vm.prank(buyers[i]);
            usd.approve(address(s), type(uint256).max);
        }
    }

    function pay(uint8 who, bytes32 nonce) external {
        address b = buyers[who % 3];
        (, , uint8 st0, , ) = s.payment(s.requestIdFor(b, id, nonce));
        if (st0 != 0) return;
        (,,, uint96 price,,) = s.endpoint(id);
        vm.prank(b);
        rids.push(s.pay(id, nonce, price));
        open += price;
    }

    function settle(uint256 i) external {
        if (rids.length == 0) return;
        bytes32 r = rids[i % rids.length];
        (, , uint8 st, , uint96 amt) = s.payment(r);
        if (st != 1) return;
        vm.prank(provider);
        s.settle(r, bytes32(i));
        open -= amt;
    }

    function refund(uint256 i, bool asPayer) external {
        if (rids.length == 0) return;
        bytes32 r = rids[i % rids.length];
        (address payer, , uint8 st, , uint96 amt) = s.payment(r);
        if (st != 1) return;
        if (asPayer) {
            vm.warp(block.timestamp + 61);
            vm.prank(payer);
        } else {
            vm.prank(provider);
        }
        s.refund(r, 1);
        open -= amt;
    }

    function reprice(uint96 p) external {
        p = uint96(bound(p, 1, 1e9));
        vm.prank(provider);
        s.updateEndpoint(id, payee, p, 60, true);
    }
}

contract MeterSettlementInvariantTest is Test {
    MeterSettlement s;
    MockERC20 usd;
    Handler h;

    function setUp() public {
        s = new MeterSettlement();
        usd = new MockERC20("Meter Test USD", "tUSDm", 6);
        h = new Handler(s, usd);
        targetContract(address(h));
    }

    function invariant_escrowEqualsOpenPayments() public view {
        assertEq(usd.balanceOf(address(s)), h.open());
    }
}
