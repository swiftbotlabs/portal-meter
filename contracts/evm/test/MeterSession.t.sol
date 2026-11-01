// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MeterSettlement} from "../src/MeterSettlement.sol";
import {MeterSession, IEndpoints} from "../src/MeterSession.sol";
import {MockERC20, NoReturnToken, FalseToken, ReenterOnTransfer} from "./Mocks.sol";

contract MeterSessionTest is Test {
    MeterSettlement settlement;
    MeterSession m;
    MockERC20 usd;
    address provider = makeAddr("provider");
    address payee = makeAddr("payee");
    address buyer = makeAddr("buyer");
    address other = makeAddr("other");
    uint256 signerKey = 0xA11CE;
    address signer;
    uint32 endpointId;
    uint96 constant PRICE = 10_000;
    uint96 constant BUDGET = 1_000_000;
    bytes32 constant NONCE = bytes32(uint256(7));

    event Redeemed(
        bytes32 indexed session, uint32 indexed endpointId, bytes32 head, uint96 cumulative, uint96 paid, uint32 count
    );

    function setUp() public {
        settlement = new MeterSettlement();
        m = new MeterSession(IEndpoints(address(settlement)));
        usd = new MockERC20("Meter Test USD", "tUSDm", 6);
        usd.mint(buyer, 10_000_000);
        signer = vm.addr(signerKey);
        vm.prank(provider);
        endpointId = settlement.registerEndpoint(payee, address(usd), PRICE, 600);
        vm.prank(buyer);
        usd.approve(address(m), type(uint256).max);
    }

    function _open() internal returns (bytes32 id) {
        vm.prank(buyer);
        id = m.open(endpointId, NONCE, signer, BUDGET, uint40(block.timestamp + 1 days));
    }

    function _redeem(bytes32 id, uint96 cum, uint32 count, bytes32 head, bytes memory sig) internal {
        vm.prank(provider);
        m.redeem(id, cum, count, head, sig);
    }

    function _sign(uint256 key, bytes32 id, uint96 cum, uint32 count, bytes32 head) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, m.voucherDigest(id, cum, count, head));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ open
    function test_open_locksBudget() public {
        bytes32 id = _open();
        assertEq(id, m.sessionIdFor(buyer, endpointId, NONCE));
        assertEq(usd.balanceOf(address(m)), BUDGET);
        (address p, uint32 e, uint40 x, address sg, uint96 d, uint96 r, uint32 c) = m.session(id);
        assertEq(p, buyer);
        assertEq(e, endpointId);
        assertEq(x, uint40(block.timestamp + 1 days));
        assertEq(sg, signer);
        assertEq(d, BUDGET);
        assertEq(r, 0);
        assertEq(c, 0);
    }

    function test_open_rejectsBadInput() public {
        uint40 ok = uint40(block.timestamp + 1 days);
        vm.startPrank(buyer);
        vm.expectRevert(MeterSession.ZeroAmount.selector);
        m.open(endpointId, NONCE, signer, 0, ok);
        vm.expectRevert(MeterSession.ZeroAddress.selector);
        m.open(endpointId, NONCE, address(0), BUDGET, ok);
        vm.expectRevert(MeterSession.UnknownEndpoint.selector);
        m.open(99, NONCE, signer, BUDGET, ok);
        vm.expectRevert(MeterSession.BadExpiry.selector);
        m.open(endpointId, NONCE, signer, BUDGET, uint40(block.timestamp + 9 minutes));
        vm.expectRevert(MeterSession.BadExpiry.selector);
        m.open(endpointId, NONCE, signer, BUDGET, uint40(block.timestamp + 31 days));
        vm.stopPrank();
    }

    function test_open_rejectsInactiveEndpoint() public {
        vm.prank(provider);
        settlement.updateEndpoint(endpointId, payee, PRICE, 600, false);
        vm.prank(buyer);
        vm.expectRevert(MeterSession.EndpointInactive.selector);
        m.open(endpointId, NONCE, signer, BUDGET, uint40(block.timestamp + 1 days));
    }

    function test_open_sameNonceTwiceRefused() public {
        _open();
        vm.prank(buyer);
        vm.expectRevert(MeterSession.SessionExists.selector);
        m.open(endpointId, NONCE, signer, BUDGET, uint40(block.timestamp + 1 days));
    }

    function test_sessionId_isBoundToThePayer() public {
        assertTrue(m.sessionIdFor(buyer, endpointId, NONCE) != m.sessionIdFor(other, endpointId, NONCE));
    }

    // ------------------------------------------------------------ redeem
    function test_redeem_paysOnlyTheNewPart() public {
        bytes32 id = _open();
        bytes32 h1 = keccak256("one");
        vm.expectEmit(true, true, false, true);
        emit Redeemed(id, endpointId, h1, 30_000, 30_000, 3);
        _redeem(id, 30_000, 3, h1, _sign(signerKey, id, 30_000, 3, h1));
        assertEq(usd.balanceOf(payee), 30_000);
        bytes32 h2 = keccak256("two");
        _redeem(id, 50_000, 5, h2, _sign(signerKey, id, 50_000, 5, h2));
        assertEq(usd.balanceOf(payee), 50_000);
        (,,,,, uint96 r, uint32 c) = m.session(id);
        assertEq(r, 50_000);
        assertEq(c, 5);
    }

    function test_redeem_onlyTheProvider() public {
        bytes32 id = _open();
        bytes32 h = keccak256("x");
        bytes memory sig = _sign(signerKey, id, 30_000, 3, h);
        vm.prank(other);
        vm.expectRevert(MeterSession.NotAllowed.selector);
        m.redeem(id, 30_000, 3, h, sig);
        vm.prank(buyer);
        vm.expectRevert(MeterSession.NotAllowed.selector);
        m.redeem(id, 30_000, 3, h, sig);
    }

    function test_redeem_refusesReplayOlderAndEqual() public {
        bytes32 id = _open();
        bytes32 h = keccak256("x");
        bytes memory sig = _sign(signerKey, id, 30_000, 3, h);
        _redeem(id, 30_000, 3, h, sig);
        vm.expectRevert(MeterSession.NotNewer.selector);
        _redeem(id, 30_000, 3, h, sig);
        bytes memory older = _sign(signerKey, id, 20_000, 2, h);
        vm.expectRevert(MeterSession.NotNewer.selector);
        _redeem(id, 20_000, 2, h, older);
        bytes memory sameCount = _sign(signerKey, id, 40_000, 3, h);
        vm.expectRevert(MeterSession.NotNewer.selector);
        _redeem(id, 40_000, 3, h, sameCount);
        assertEq(usd.balanceOf(payee), 30_000);
    }

    function test_redeem_refusesOverBudget() public {
        bytes32 id = _open();
        bytes32 h = keccak256("x");
        bytes memory sig = _sign(signerKey, id, BUDGET + 1, 1, h);
        vm.expectRevert(MeterSession.OverBudget.selector);
        _redeem(id, BUDGET + 1, 1, h, sig);
    }

    function test_redeem_refusesAnythingNotSignedByTheSessionKey() public {
        bytes32 id = _open();
        bytes32 h = keccak256("x");
        bytes memory wrongKey = _sign(0xB0B, id, 30_000, 3, h);
        vm.expectRevert(MeterSession.BadSignature.selector);
        _redeem(id, 30_000, 3, h, wrongKey);
        bytes memory good = _sign(signerKey, id, 30_000, 3, h);
        vm.expectRevert(MeterSession.BadSignature.selector); // tampered amount
        _redeem(id, 30_001, 3, h, good);
        vm.expectRevert(MeterSession.BadSignature.selector); // tampered count
        _redeem(id, 30_000, 4, h, good);
        vm.expectRevert(MeterSession.BadSignature.selector); // tampered head
        _redeem(id, 30_000, 3, keccak256("y"), good);
        vm.expectRevert(MeterSession.BadSignature.selector); // truncated
        _redeem(id, 30_000, 3, h, hex"00");
    }

    function test_redeem_refusesHighS() public {
        bytes32 id = _open();
        bytes32 h = keccak256("x");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, m.voucherDigest(id, 30_000, 3, h));
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory malleable = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(MeterSession.BadSignature.selector);
        _redeem(id, 30_000, 3, h, malleable);
    }

    function test_voucher_cannotCrossSessions() public {
        bytes32 id = _open();
        vm.prank(buyer);
        bytes32 id2 = m.open(endpointId, bytes32(uint256(8)), signer, BUDGET, uint40(block.timestamp + 1 days));
        bytes32 h = keccak256("x");
        bytes memory sig = _sign(signerKey, id, 30_000, 3, h);
        vm.expectRevert(MeterSession.BadSignature.selector);
        _redeem(id2, 30_000, 3, h, sig);
    }

    function test_redeem_worksInTheGraceWindow() public {
        bytes32 id = _open();
        vm.warp(block.timestamp + 1 days + 5 minutes);
        bytes32 h = keccak256("late");
        _redeem(id, 30_000, 3, h, _sign(signerKey, id, 30_000, 3, h));
        assertEq(usd.balanceOf(payee), 30_000);
    }

    // ------------------------------------------------------------ top up
    function test_topUp_extendsTheBudget() public {
        bytes32 id = _open();
        vm.prank(buyer);
        m.topUp(id, 500_000);
        bytes32 h = keccak256("x");
        _redeem(id, BUDGET + 1, 1, h, _sign(signerKey, id, BUDGET + 1, 1, h));
        assertEq(usd.balanceOf(payee), BUDGET + 1);
        vm.prank(buyer);
        vm.expectRevert(MeterSession.ZeroAmount.selector);
        m.topUp(id, 0);
        vm.prank(buyer);
        vm.expectRevert(MeterSession.NoSession.selector);
        m.topUp(bytes32(uint256(1)), 1);
    }

    // ------------------------------------------------------------ close
    function test_close_payerAfterExpiryAndGraceOnly() public {
        bytes32 id = _open();
        bytes32 h = keccak256("x");
        _redeem(id, 30_000, 3, h, _sign(signerKey, id, 30_000, 3, h));
        vm.prank(buyer);
        vm.expectRevert(MeterSession.TooEarly.selector);
        m.close(id);
        vm.warp(block.timestamp + 1 days + 15 minutes - 1);
        vm.prank(buyer);
        vm.expectRevert(MeterSession.TooEarly.selector);
        m.close(id);
        vm.warp(block.timestamp + 1);
        uint256 before = usd.balanceOf(buyer);
        vm.prank(buyer);
        m.close(id);
        assertEq(usd.balanceOf(buyer), before + BUDGET - 30_000);
        assertEq(usd.balanceOf(address(m)), 0);
    }

    function test_close_providerAnytime_strangerNever() public {
        bytes32 id = _open();
        vm.prank(other);
        vm.expectRevert(MeterSession.NotAllowed.selector);
        m.close(id);
        uint256 before = usd.balanceOf(buyer);
        vm.prank(provider);
        m.close(id);
        assertEq(usd.balanceOf(buyer), before + BUDGET);
    }

    function test_closedSession_cannotBeReopenedOrRedeemed() public {
        bytes32 id = _open();
        bytes32 h = keccak256("x");
        bytes memory sig = _sign(signerKey, id, 30_000, 3, h);
        vm.prank(provider);
        m.close(id);
        vm.expectRevert(MeterSession.NoSession.selector);
        _redeem(id, 30_000, 3, h, sig);
        vm.prank(buyer);
        vm.expectRevert(MeterSession.SessionExists.selector); // old vouchers stay dead
        m.open(endpointId, NONCE, signer, BUDGET, uint40(block.timestamp + 1 days));
        vm.prank(provider);
        vm.expectRevert(MeterSession.NoSession.selector);
        m.close(id);
        (address p,, uint40 x,, uint96 d,,) = m.session(id);
        assertEq(p, buyer);
        assertEq(x, 0);
        assertEq(d, 0);
    }

    // ------------------------------------------------------------ tokens
    function test_noReturnToken_works_falseToken_refused() public {
        NoReturnToken nr = new NoReturnToken();
        nr.mint(buyer, BUDGET);
        vm.prank(buyer);
        nr.approve(address(m), BUDGET);
        vm.prank(provider);
        uint32 e = settlement.registerEndpoint(payee, address(nr), PRICE, 600);
        vm.prank(buyer);
        m.open(e, NONCE, signer, BUDGET, uint40(block.timestamp + 1 days));
        assertEq(nr.balanceOf(address(m)), BUDGET);

        FalseToken ft = new FalseToken();
        vm.prank(provider);
        uint32 e2 = settlement.registerEndpoint(payee, address(ft), PRICE, 600);
        vm.prank(buyer);
        vm.expectRevert(MeterSession.TokenCallFailed.selector);
        m.open(e2, NONCE, signer, BUDGET, uint40(block.timestamp + 1 days));
    }

    function test_reentrantToken_cannotDoubleSpend() public {
        ReenterOnTransfer t = new ReenterOnTransfer();
        t.mint(buyer, BUDGET);
        vm.prank(provider);
        uint32 e = settlement.registerEndpoint(payee, address(t), PRICE, 600);
        vm.startPrank(buyer);
        t.approve(address(m), BUDGET);
        bytes32 id = m.open(e, NONCE, signer, BUDGET, uint40(block.timestamp + 1 days));
        vm.stopPrank();
        bytes32 h = keccak256("x");
        bytes memory sig = _sign(signerKey, id, 30_000, 3, h);
        t.arm(address(m), abi.encodeCall(m.redeem, (id, 30_000, 3, h, sig))); // the same voucher again, mid-payout
        vm.prank(provider);
        m.redeem(id, 30_000, 3, h, sig);
        assertTrue(t.attempted());
        assertFalse(t.succeeded());
        assertEq(t.balanceOf(payee), 30_000);
    }

    // ------------------------------------------------------------ fuzz
    function testFuzz_payeePlusRefundEqualsDeposit(uint96 budget, uint96 spent) public {
        budget = uint96(bound(budget, 1, 5_000_000));
        spent = uint96(bound(spent, 1, budget));
        vm.prank(buyer);
        bytes32 id = m.open(endpointId, NONCE, signer, budget, uint40(block.timestamp + 1 days));
        bytes32 h = keccak256("x");
        _redeem(id, spent, 1, h, _sign(signerKey, id, spent, 1, h));
        uint256 before = usd.balanceOf(buyer);
        vm.prank(provider);
        m.close(id);
        assertEq(usd.balanceOf(payee), spent);
        assertEq(usd.balanceOf(buyer) - before, budget - spent);
        assertEq(usd.balanceOf(address(m)), 0);
    }
}

/// Random sequences of open, redeem and close: the contract always holds exactly what open sessions still own.
contract SessionHandler is Test {
    MeterSession m;
    MockERC20 usd;
    uint32 endpointId;
    address payee;
    address provider;
    uint256 constant KEY = 0xA11CE;
    bytes32[] public ids;
    mapping(bytes32 => uint32) public counts;
    uint256 public opened;
    uint256 public paid;
    uint256 public returned;

    constructor(MeterSession m_, MockERC20 usd_, uint32 endpointId_, address payee_, address provider_) {
        m = m_;
        usd = usd_;
        endpointId = endpointId_;
        payee = payee_;
        provider = provider_;
        usd.approve(address(m), type(uint256).max);
    }

    function open(uint96 amount) external {
        amount = uint96(bound(amount, 1, 1_000_000));
        usd.mint(address(this), amount);
        bytes32 id = m.open(endpointId, bytes32(ids.length), vm.addr(KEY), amount, uint40(block.timestamp + 1 days));
        ids.push(id);
        opened += amount;
    }

    function redeem(uint256 which, uint96 more) external {
        if (ids.length == 0) return;
        bytes32 id = ids[which % ids.length];
        (,,,, uint96 d, uint96 r,) = m.session(id);
        if (d == 0 || r == d) return;
        uint96 c = r + uint96(bound(more, 1, d - r));
        uint32 n = counts[id] + 1;
        bytes32 h = keccak256(abi.encode(id, n));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(KEY, m.voucherDigest(id, c, n, h));
        vm.prank(provider);
        m.redeem(id, c, n, h, abi.encodePacked(rr, s, v));
        counts[id] = n;
        paid += c - r;
    }

    function close(uint256 which) external {
        if (ids.length == 0) return;
        bytes32 id = ids[which % ids.length];
        (,,,, uint96 d, uint96 r,) = m.session(id);
        if (d == 0) return;
        vm.warp(block.timestamp + 2 days);
        m.close(id); // this handler is the payer
        returned += d - r;
    }
}

contract MeterSessionInvariant is Test {
    MeterSettlement settlement;
    MeterSession m;
    MockERC20 usd;
    SessionHandler h;
    address payee = makeAddr("payee");

    function setUp() public {
        settlement = new MeterSettlement();
        m = new MeterSession(IEndpoints(address(settlement)));
        usd = new MockERC20("Meter Test USD", "tUSDm", 6);
        uint32 e = settlement.registerEndpoint(payee, address(usd), 1, 600);
        h = new SessionHandler(m, usd, e, payee, address(this));
        targetContract(address(h));
    }

    function invariant_contractHoldsExactlyWhatIsUnspent() public view {
        assertEq(usd.balanceOf(address(m)), h.opened() - h.paid() - h.returned());
        assertEq(usd.balanceOf(payee), h.paid());
    }
}
