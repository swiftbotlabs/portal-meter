# Protocol: `portal-meter/1`

An HTTP 402 flow in the style of x402, with escrow on Portaldot's EVM. All JSON that is hashed or signed is
canonical: keys sorted recursively, no whitespace (`canonical()` in `src/protocol.mjs`). Headers carry base64 of
that JSON and are capped at 4 KB (receipts at 16 KB).

## 1. Quote

`GET /v1/asset/7777` without payment returns `402 Payment Required`, the quote in the `PAYMENT-REQUIRED` header
and in the body as `accepts[0]`:

```json
{
  "v": "portal-meter/1",
  "scheme": "escrow-per-request",
  "network": "eip155:420420777",
  "settlement": "0x… MeterSettlement",
  "registry": { "kind": "ink", "address": "5… MeterRegistry" },
  "provider": "0x… provider EVM address",
  "endpointId": 2,
  "token": "0x… ERC-20 (the tUSDm precompile)",
  "tokenSymbol": "tUSDm",
  "decimals": 6,
  "price": "10000",
  "nonce": "0x… 32 random bytes",
  "resource": "GET /v1/asset/7777",
  "requestHash": "keccak256(canonical({m, p, q}))",
  "expiresAt": 1793500000
}
```

Malformed input (a bad address, a non-numeric id) gets a free `400`; nobody pays for a request that cannot be
answered. Whether an asset exists is not checked before payment, because that answer is the data being sold.

## 2. Pay

The buyer checks the quote (network, settlement contract, token, price cap, that `requestHash` matches its own
request), reads the endpoint from `MeterSettlement` (provider, token, price, active) and the provider's record from
`MeterRegistry`, then calls `pay(endpointId, nonce, maxPrice)`. The contract derives

```text
requestId = keccak256(abi.encode(uint256 chainId, address settlement, address payer, uint32 endpointId, bytes32 nonce))
```

The same formula is implemented in the ink! registry (`request_id_for`) and in JS (`requestIdFor`); one test vector
is asserted in all three.

## 3. Retry with proof

`PAYMENT` header:

```json
{ "v": "portal-meter/1", "requestId": "0x…", "nonce": "0x…", "payer": "0x…", "payTx": "0x…",
  "signature": "personal_sign by the payer of: portal-meter/1 payment proof\nrequest: <requestId>\nresource: <requestHash>" }
```

The seller checks, in order: the quote exists and was issued for this exact request and endpoint; the request id
recomputes from payer, endpoint and nonce; the signature recovers to the payer (someone who saw the payment on-chain
cannot use it); on-chain status is `PAID` with the right payer, endpoint and amount; the request id was never
claimed before (served once). A proof that arrives before the payment is mined gets `402` with `Retry-After: 6`.

## 4. Response and receipt

Served: `200` with the body; refunded: `404`/`502` with the refund receipt. Either way the `PAYMENT-RESPONSE`
header carries the provider-signed receipt:

```json
{
  "v": "portal-meter/1", "network": "eip155:420420777", "settlement": "0x…", "registry": { … }, "provider": "0x…",
  "endpointId": 1, "requestId": "0x…", "nonce": "0x…", "payer": "0x…", "amount": "25000", "token": "0x…",
  "requestHash": "0x…", "responseHash": "keccak256(body)", "outcome": "served",
  "receiptHash": "keccak256(canonical(receipt core))",
  "tx": "0x… settle (or refund) transaction", "block": 123, "settledVia": "xvm", "issuedAt": 1793500000,
  "signature": "personal_sign by the provider of: portal-meter/1 receipt\n<canonical receipt without signature>"
}
```

The **receipt core** (`v, network, settlement, endpointId, requestId, payer, amount, requestHash, responseHash,
outcome`) exists before any transaction is sent; its hash is what the ink! registry anchors in the same transaction
as the settlement.

## 5. Verify

`verifyReceipt()` (CLI and the live page) returns ACCEPT only if no check fails:

| Check | Against |
|---|---|
| receipt format | schema |
| network, settlement contract | what the verifier expects |
| provider signature | recovers to `provider` |
| receipt hash | recomputed core hash |
| request id bound to payer | recomputed from payer, endpoint, nonce |
| response body hash | `keccak256(body)` when the body is given |
| endpoint provider on-chain, endpoint token | `MeterSettlement.endpoint()` |
| payment status, payer, endpoint | `MeterSettlement.payment()` |
| Paid event | amount and payer |
| Served / Refunded event, tx | response hash, amount, payee; the log's transaction is the receipt's `tx` |
| ink! registry anchor | outcome, amount, endpoint and `receiptHash` stored under the provider's address |
