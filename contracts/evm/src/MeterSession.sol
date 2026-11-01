// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev The part of MeterSettlement a session needs: who runs an endpoint, who gets paid, in which token.
interface IEndpoints {
    function endpoint(uint32 endpointId)
        external
        view
        returns (address provider, address payee, address token, uint96 price, uint32 refundDelay, bool active);
}

/// @title MeterSession
/// @notice Prepaid sessions for high-frequency APIs on Portaldot V3 (pallet-revive EVM).
///         One on-chain payment per request locks about 7.7 tPOT of storage deposit, far above the price of a
///         sub-cent API call. A session locks a budget once. Each request is then covered by an off-chain EIP-712
///         voucher, and the provider redeems the newest voucher whenever it likes, in one transaction.
///
///         A voucher is signed over (session, cumulative, count, head). `head` is a hash chain:
///             head[n] = keccak256(abi.encode(head[n-1], requestHash[n], responseHash[n-1]))
///         so the payer's signature for request n acknowledges the exact response it received for request n-1.
///         The chain itself is checked off-chain; the contract only verifies the signature and publishes `head`,
///         which makes every redeemed batch a payer-signed record of what was delivered, not a provider's claim.
/// @dev Built for pallet-revive's storage deposits: a session is 3 slots, all paid for by the payer at `open`. Redeeming
///      only updates a slot, so the provider locks nothing here. `close` clears 2 of the 3 slots, which returns their
///      deposit to the payer, and keeps the first, so that a session id can never be reopened and old vouchers can
///      never be replayed.
contract MeterSession {
    // ---------------------------------------------------------------- types
    struct Session {
        address payer; // funds the session and receives what is left of it
        uint32 endpointId; // endpoint in MeterSettlement
        uint40 expiresAt; // 0 once the session is closed
        address signer; // key that signs vouchers: the payer, or a capped session key
        uint96 deposit; // token base units locked so far
        uint96 redeemed; // cumulative amount already paid to the payee
        uint32 count; // requests covered by the last redeemed voucher
        bool funded; // keeps this slot non-zero, so that the payer pays its deposit at open, not the provider at redeem
    }

    uint32 public constant MIN_DURATION = 10 minutes;
    uint32 public constant MAX_DURATION = 30 days;
    /// @notice Time after expiry during which the payer cannot close, so that a last voucher can still be redeemed.
    uint32 public constant CLOSE_GRACE = 15 minutes;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 session,uint96 cumulative,uint32 count,bytes32 head)");
    bytes32 private constant NAME_HASH = keccak256("Portal Meter Session");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // ---------------------------------------------------------------- storage
    IEndpoints public immutable endpoints;
    mapping(bytes32 => Session) private _sessions;

    // ---------------------------------------------------------------- events
    event SessionOpened(
        bytes32 indexed session,
        uint32 indexed endpointId,
        address indexed payer,
        address signer,
        uint96 amount,
        uint40 expiresAt,
        bytes32 nonce
    );
    event SessionToppedUp(bytes32 indexed session, uint96 amount, uint96 deposit);
    event Redeemed(
        bytes32 indexed session, uint32 indexed endpointId, bytes32 head, uint96 cumulative, uint96 paid, uint32 count
    );
    event SessionClosed(bytes32 indexed session, address indexed payer, uint96 returned);

    // ---------------------------------------------------------------- errors
    error UnknownEndpoint();
    error EndpointInactive();
    error ZeroAmount();
    error ZeroAddress();
    error BadExpiry();
    error SessionExists();
    error NoSession();
    error BadSignature();
    error NotNewer();
    error OverBudget();
    error NotAllowed();
    error TooEarly();
    error TokenCallFailed();
    error FeeOnTransfer();

    constructor(IEndpoints settlement) {
        if (address(settlement) == address(0)) revert ZeroAddress();
        endpoints = settlement;
    }

    // ---------------------------------------------------------------- payer
    /// @notice Lock `amount` for one endpoint until `expiresAt`. `signer` signs vouchers: use a fresh key to give an
    ///         agent a capped budget without giving it your wallet.
    function open(uint32 endpointId, bytes32 nonce, address signer, uint96 amount, uint40 expiresAt)
        external
        returns (bytes32 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (signer == address(0)) revert ZeroAddress();
        (address provider,, address token,,, bool active) = endpoints.endpoint(endpointId);
        if (provider == address(0)) revert UnknownEndpoint();
        if (!active) revert EndpointInactive();
        if (expiresAt < block.timestamp + MIN_DURATION || expiresAt > block.timestamp + MAX_DURATION) {
            revert BadExpiry();
        }
        id = sessionIdFor(msg.sender, endpointId, nonce);
        Session storage s = _sessions[id];
        if (s.payer != address(0)) revert SessionExists();
        s.payer = msg.sender;
        s.endpointId = endpointId;
        s.expiresAt = expiresAt;
        s.signer = signer;
        s.deposit = amount;
        s.funded = true;
        _pull(token, amount);
        emit SessionOpened(id, endpointId, msg.sender, signer, amount, expiresAt, nonce);
    }

    /// @notice Add budget to an open session. Anyone may pay in; it comes back to the payer at close.
    function topUp(bytes32 id, uint96 amount) external {
        if (amount == 0) revert ZeroAmount();
        Session storage s = _open(id);
        s.deposit += amount;
        (,, address token,,,) = endpoints.endpoint(s.endpointId);
        _pull(token, amount);
        emit SessionToppedUp(id, amount, s.deposit);
    }

    // ---------------------------------------------------------------- provider
    /// @notice Pay out a voucher: the part of `cumulative` not paid yet goes to the endpoint's payee. Only the provider
    ///         may submit it, so that nobody can copy a voucher from a pending batch and make that batch revert.
    function redeem(bytes32 id, uint96 cumulative, uint32 count, bytes32 head, bytes calldata signature) external {
        Session storage s = _open(id);
        uint32 endpointId = s.endpointId;
        (address provider, address payee, address token,,,) = endpoints.endpoint(endpointId);
        if (msg.sender != provider) revert NotAllowed();
        if (_recover(voucherDigest(id, cumulative, count, head), signature) != s.signer) revert BadSignature();
        uint96 done = s.redeemed;
        if (cumulative <= done || count <= s.count) revert NotNewer();
        if (cumulative > s.deposit) revert OverBudget();
        uint96 paid = cumulative - done;
        s.redeemed = cumulative;
        s.count = count;
        _call(token, abi.encodeWithSelector(0xa9059cbb, payee, uint256(paid)));
        emit Redeemed(id, endpointId, head, cumulative, paid, count);
    }

    // ---------------------------------------------------------------- end of a session
    /// @notice Return what is unspent to the payer, once the session has expired and the grace period has passed.
    ///         Only the payer may do it: whoever clears storage gets its deposit back, and the payer paid for it.
    function close(bytes32 id) external {
        Session storage s = _open(id);
        address payer = s.payer;
        if (msg.sender != payer) revert NotAllowed();
        if (block.timestamp < uint256(s.expiresAt) + CLOSE_GRACE) revert TooEarly();
        (,, address token,,,) = endpoints.endpoint(s.endpointId);
        uint96 back = s.deposit - s.redeemed;
        s.expiresAt = 0;
        s.signer = address(0);
        s.deposit = 0;
        s.redeemed = 0;
        s.count = 0;
        s.funded = false;
        if (back != 0) _call(token, abi.encodeWithSelector(0xa9059cbb, payer, uint256(back)));
        emit SessionClosed(id, payer, back);
    }

    // ---------------------------------------------------------------- views
    function sessionIdFor(address payer, uint32 endpointId, bytes32 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), payer, endpointId, nonce));
    }

    function session(bytes32 id)
        external
        view
        returns (
            address payer,
            uint32 endpointId,
            uint40 expiresAt,
            address signer,
            uint96 deposit,
            uint96 redeemed,
            uint32 count
        )
    {
        Session storage s = _sessions[id];
        return (s.payer, s.endpointId, s.expiresAt, s.signer, s.deposit, s.redeemed, s.count);
    }

    function voucherDigest(bytes32 id, uint96 cumulative, uint32 count, bytes32 head) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, id, cumulative, count, head));
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    // ---------------------------------------------------------------- internals
    function _open(bytes32 id) private view returns (Session storage s) {
        s = _sessions[id];
        if (s.expiresAt == 0) revert NoSession();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    /// @dev All sessions of a token share one balance, so a token that delivers less than it was told to move would let
    ///      one session eat into another. Such tokens are refused.
    function _pull(address token, uint96 amount) private {
        uint256 before = _balance(token);
        _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), uint256(amount)));
        if (_balance(token) != before + amount) revert FeeOnTransfer();
    }

    function _balance(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length != 32) revert TokenCallFailed();
        return abi.decode(ret, (uint256));
    }

    /// @dev Accepts tokens that return true or nothing (USDT style); anything else reverts.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenCallFailed();
        }
    }
}
