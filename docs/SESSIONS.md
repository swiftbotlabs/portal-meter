# Prepaid sessions

Per-request escrow is the right tool for a call worth a few cents or more. It is the wrong tool for a call worth a
fraction of a cent, because on Portaldot every new storage slot locks a deposit, and the deposit is far larger than the
call. We measured it on our own first run:

| Blocks 276657 to 276660, per paid request | tPOT |
|---|---|
| Buyer: `pay()` writes two storage slots | 7.70 locked |
| Provider: `settle` frees one slot, the ink! anchor takes a new one, plus fees | 0.17 back, net |
| Left locked for good, per request | about 7.5 |

Sessions move everything per-request off-chain and keep the guarantees that matter.

## How a session works

1. **Open, once.** The payer calls `MeterSession.open(endpointId, nonce, signer, amount, expiresAt)`. The budget moves
   into the contract. `signer` can be a fresh key: an agent then holds a key that can spend this budget and nothing else.
2. **Every request: a voucher, no transaction.** The client signs an EIP-712 voucher and sends it in the
   `PAYMENT-VOUCHER` header. The seller checks it without touching the chain.
3. **Settle, whenever it pays to.** The provider sends the newest voucher of each session in one Ethereum transaction.
   For each session the batch runs `MeterSession.redeem` in Solidity and `MeterRegistry.record` in ink!, inside one
   `utility.batchAll`, so money and record land together or not at all.
4. **Close.** The provider can return the rest at any time. The payer can take it back after expiry plus a 15-minute
   grace period, which leaves the provider time to redeem its last voucher.

## The voucher

```
Voucher(bytes32 session, uint96 cumulative, uint32 count, bytes32 head)

head[0] = keccak256(abi.encode("portal-meter/session/1", session))
head[n] = keccak256(abi.encode(head[n-1], requestHash[n], responseHash[n-1]))
```

`cumulative` is the total the provider may collect so far; `redeem` pays the part not yet paid, so only the newest voucher
matters. `head` is what makes this more than a payment channel: the voucher for request `n` commits to the hash of the
response received for request `n-1`. The payer's signature, verified by Solidity in `redeem` and published in the
`Redeemed` event, is therefore an acknowledgement of exactly what was delivered.

| | Per-request escrow | Session |
|---|---|---|
| Who says "served" | the provider | the payer, by signing the next voucher |
| On-chain writes per request | 2 transactions, 3 new slots | none |
| What a dishonest provider can take | one request | one request: the client checks every receipt and stops signing |
| What a dishonest buyer can take | nothing | nothing: no voucher, no answer |
| Failed request | refund transaction | nothing happens: the seller does not record the voucher, the client signs the same step again |

## Verifying a session

The seller publishes `GET /v1/session/{id}/log`: for each request its number, request hash and response hash, no bodies.
Anyone can replay the chain from `head[0]` and compare it with the `Redeemed` events and the ink! anchors
(`verifyLog` in [`src/session.mjs`](../src/session.mjs); the live page has a button for it). A log that was edited, cut
short or reordered no longer reaches the head the payer signed.

## Limits

- The last request of a session is not acknowledged by any later voucher. It is paid for by the voucher that requested it.
- The contract checks the signature, not the chain: the steps of the hash chain are checked off-chain, by the seller
  before serving, and by anyone afterwards from the log.
- A provider paying itself can still produce a track record. Payer signatures raise the cost of faking volume, they do not
  remove it: sybil-resistant reputation is out of scope.
- The ink! registry counts one `served` per redeemed batch. The number of requests is in the `Redeemed` event.
- `MeterRegistry.rate` works on per-request payments. In a session the buyer's voice is the voucher itself.
- The seller keeps one state per session. If it loses that state the session cannot continue and the buyer opens a new one.
