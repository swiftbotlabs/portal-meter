// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MeterSettlement
/// @notice Per-request API settlement in an ERC-20 on Portaldot V3 (pallet-revive EVM).
///         A provider lists an endpoint (price, payee, token). A buyer pays for ONE request into escrow;
///         the request id is derived on-chain from the buyer's address, so a payment can never be claimed
///         by anyone else. The provider either settles it once (funds go to the payee, with a hash of the
///         response) or refunds it; if the provider does neither, the buyer can reclaim it after the
///         endpoint's refund delay.
/// @dev Built for pallet-revive's storage deposits: an endpoint is 3 slots, a payment 2 slots, and the
///      amount slot is cleared when a payment is finalised so its deposit comes back. The token can be any
///      ERC-20, including a Portaldot native asset through the pallet-assets ERC-20 precompile.
contract MeterSettlement {
    // ---------------------------------------------------------------- types
    struct Endpoint {
        address provider; // manages the endpoint: settles or refunds its requests
        uint32 refundDelay; // seconds after payment before the buyer may reclaim an unsettled payment
        bool active; // new payments accepted
        address payee; // receives settled payments
        address token; // ERC-20 used for payment
        uint96 price; // token base units per request
    }

    struct Payment {
        address payer;
        uint32 endpointId;
        uint8 status; // see STATUS_*
        uint40 paidAt; // block timestamp of the payment
        uint96 amount; // escrowed amount, zeroed once the payment is final
    }

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_PAID = 1;
    uint8 public constant STATUS_SERVED = 2;
    uint8 public constant STATUS_REFUNDED = 3;

    uint32 public constant MIN_REFUND_DELAY = 60;
    uint32 public constant MAX_REFUND_DELAY = 7 days;

    // ---------------------------------------------------------------- storage
    mapping(uint32 => Endpoint) private _endpoints;
    mapping(bytes32 => Payment) private _payments;
    uint32 public endpointCount;
    bool private _locked;

    // ---------------------------------------------------------------- events
    event EndpointRegistered(
        uint32 indexed endpointId, address indexed provider, address payee, address token, uint96 price, uint32 refundDelay
    );
    event EndpointUpdated(uint32 indexed endpointId, address payee, uint96 price, uint32 refundDelay, bool active);
    event Paid(bytes32 indexed requestId, uint32 indexed endpointId, address indexed payer, uint96 amount, bytes32 nonce);
    event Served(bytes32 indexed requestId, uint32 indexed endpointId, address payee, uint96 amount, bytes32 responseHash);
    event Refunded(
        bytes32 indexed requestId, uint32 indexed endpointId, address payer, uint96 amount, uint8 reason, bool byProvider
    );

    // ---------------------------------------------------------------- errors
    error ZeroAddress();
    error ZeroPrice();
    error BadRefundDelay();
    error NotAToken();
    error UnknownEndpoint();
    error NotProvider();
    error EndpointInactive();
    error PriceAboveMax();
    error RequestExists();
    error NotPaid();
    error RefundNotYetAllowed();
    error TokenCallFailed();
    error Reentrancy();
    error NotAllowed();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ---------------------------------------------------------------- provider
    /// @notice List a new endpoint. The caller becomes its provider.
    function registerEndpoint(address payee, address token, uint96 price, uint32 refundDelay)
        external
        returns (uint32 endpointId)
    {
        if (payee == address(0) || token == address(0)) revert ZeroAddress();
        if (price == 0) revert ZeroPrice();
        _checkDelay(refundDelay);
        _checkToken(token);
        endpointId = ++endpointCount;
        _endpoints[endpointId] = Endpoint({
            provider: msg.sender,
            refundDelay: refundDelay,
            active: true,
            payee: payee,
            token: token,
            price: price
        });
        emit EndpointRegistered(endpointId, msg.sender, payee, token, price, refundDelay);
    }

    /// @notice Change payee, price, refund delay or pause an endpoint. Open payments keep their amount.
    function updateEndpoint(uint32 endpointId, address payee, uint96 price, uint32 refundDelay, bool active) external {
        Endpoint storage e = _endpoints[endpointId];
        if (e.provider == address(0)) revert UnknownEndpoint();
        if (e.provider != msg.sender) revert NotProvider();
        if (payee == address(0)) revert ZeroAddress();
        if (price == 0) revert ZeroPrice();
        _checkDelay(refundDelay);
        e.payee = payee;
        e.price = price;
        e.refundDelay = refundDelay;
        e.active = active;
        emit EndpointUpdated(endpointId, payee, price, refundDelay, active);
    }

    /// @notice Deliver: move the escrowed amount to the payee, once. `responseHash` commits to what was served.
    function settle(bytes32 requestId, bytes32 responseHash) external nonReentrant {
        Payment storage p = _payments[requestId];
        if (p.status != STATUS_PAID) revert NotPaid();
        Endpoint storage e = _endpoints[p.endpointId];
        if (e.provider != msg.sender) revert NotProvider();
        uint96 amount = p.amount;
        p.status = STATUS_SERVED;
        p.amount = 0; // frees the slot's storage deposit
        _transfer(e.token, e.payee, amount);
        emit Served(requestId, p.endpointId, e.payee, amount, responseHash);
    }

    // ---------------------------------------------------------------- buyer
    /// @notice Pay for one request. The request id is bound to msg.sender: keccak256(chainid, this, payer, endpoint, nonce).
    /// @param maxPrice protects the buyer against a price change between quote and payment.
    function pay(uint32 endpointId, bytes32 nonce, uint96 maxPrice) external nonReentrant returns (bytes32 requestId) {
        Endpoint storage e = _endpoints[endpointId];
        if (e.provider == address(0)) revert UnknownEndpoint();
        if (!e.active) revert EndpointInactive();
        uint96 price = e.price;
        if (price > maxPrice) revert PriceAboveMax();
        requestId = requestIdFor(msg.sender, endpointId, nonce);
        Payment storage p = _payments[requestId];
        if (p.status != STATUS_NONE) revert RequestExists(); // a request id is usable exactly once, ever
        p.payer = msg.sender;
        p.endpointId = endpointId;
        p.status = STATUS_PAID;
        p.paidAt = uint40(block.timestamp);
        p.amount = price;
        _transferFrom(e.token, msg.sender, price);
        emit Paid(requestId, endpointId, msg.sender, price, nonce);
    }

    /// @notice Refund an unsettled payment. The provider may refund at any time (it could not deliver);
    ///         the payer may reclaim once the endpoint's refund delay has passed.
    /// @param reason free code for the record (1 = upstream failure, 2 = timeout, 3 = invalid request, ...)
    function refund(bytes32 requestId, uint8 reason) external nonReentrant {
        Payment storage p = _payments[requestId];
        if (p.status != STATUS_PAID) revert NotPaid();
        Endpoint storage e = _endpoints[p.endpointId];
        bool byProvider = msg.sender == e.provider;
        if (!byProvider) {
            if (msg.sender != p.payer) revert NotAllowed();
            if (block.timestamp < uint256(p.paidAt) + e.refundDelay) revert RefundNotYetAllowed();
        }
        uint96 amount = p.amount;
        address payer = p.payer;
        p.status = STATUS_REFUNDED;
        p.amount = 0;
        _transfer(e.token, payer, amount);
        emit Refunded(requestId, p.endpointId, payer, amount, reason, byProvider);
    }

    // ---------------------------------------------------------------- views
    function requestIdFor(address payer, uint32 endpointId, bytes32 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), payer, endpointId, nonce));
    }

    function endpoint(uint32 endpointId)
        external
        view
        returns (address provider, address payee, address token, uint96 price, uint32 refundDelay, bool active)
    {
        Endpoint storage e = _endpoints[endpointId];
        return (e.provider, e.payee, e.token, e.price, e.refundDelay, e.active);
    }

    function payment(bytes32 requestId)
        external
        view
        returns (address payer, uint32 endpointId, uint8 status, uint40 paidAt, uint96 amount)
    {
        Payment storage p = _payments[requestId];
        return (p.payer, p.endpointId, p.status, p.paidAt, p.amount);
    }

    // ---------------------------------------------------------------- internals
    function _checkDelay(uint32 d) private pure {
        if (d < MIN_REFUND_DELAY || d > MAX_REFUND_DELAY) revert BadRefundDelay();
    }

    /// @dev An address with no code (or a precompile that is not an ERC-20) would make a low-level transfer
    ///      "succeed" without moving anything, so the token must answer totalSupply() with one word.
    function _checkToken(address token) private view {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x18160ddd));
        if (!ok || ret.length != 32) revert NotAToken();
    }

    function _transferFrom(address token, address from, uint256 amount) private {
        _call(token, abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
    }

    function _transfer(address token, address to, uint256 amount) private {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
    }

    /// @dev Accepts tokens that return true or nothing (USDT style); anything else reverts.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenCallFailed();
        }
    }
}
