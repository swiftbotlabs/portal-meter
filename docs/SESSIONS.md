# Prepaid sessions

Per-request escrow is the right tool for a call worth a few cents or more. It is the wrong tool for a call worth a
fraction of a cent, because on Portaldot every new storage slot locks a deposit, and the deposit is far larger than the
call. We measured it on our own first run (blocks 276657 to 276660):

| Per paid request, escrow path | tPOT |
|---|---|
| Buyer: `pay()` writes two storage slots | 7.70 locked |
| Provider: `settle` frees one slot, the ink! anchor takes a new one, plus fees | 0.17 back, net |
| Left locked for good | about 7.5, for a price of 0.025 tUSDm |

Sessions move everything per-request off-chain and keep the guarantees that matter. Measured on the same testnet, against the
hosted seller ([`deployments/proof/session-measure.json`](../deployments/proof/session-measure.json)):

| One session of 100 requests, one batch | tPOT |
|---|---|
| Payer: `open` writes three storage slots | 11.55 locked |
| Per request: nothing on-chain | 0 |
| Provider: `redeem` writes no new slot, the ink! anchor takes one | 3.68 locked |
| Payer: `close` clears two slots | 7.67 back |
| Left locked for good | 7.6, or 0.076 per request |

The payer closed both measured sessions in blocks 297818 and 297819 and took back 15.34 tPOT, or 7.67 each, plus the unused 0.06 pUSD.

That is about 100 times less per request than the escrow path, and each further request in the session lowers it. Each further batch
adds one anchor. The seller decides when to settle: at 25 waiting requests, after 6 hours, or close to a session's expiry, with a gap
of 30 minutes between batches. Block [282559](https://scanner-testnet-v3.portaldot.dev/#/blocks/282559?tab=events) settled 137
requests from 3 sessions in one transaction, and block [282470](https://scanner-testnet-v3.portaldot.dev/#/blocks/282470?tab=events)
was sent by the seller's cron, unattended.

## How a session works

1. **Open, once.** The payer calls `MeterSession.open(endpointId, nonce, signer, amount, expiresAt)`. The budget moves
   into the contract. `signer` can be a fresh key: an agent then holds a key that can spend this budget and nothing else.
2. **Every request: a voucher, no transaction.** The client signs an EIP-712 voucher and sends it in the
   `PAYMENT-VOUCHER` header. The seller checks it without a transaction.
3. **Settle, whenever it pays to.** The provider sends the newest voucher of each session in one Ethereum transaction.
   For each session the batch runs `MeterSession.redeem` in Solidity and `MeterRegistry.record` in ink!, inside one
   `utility.batchAll`, so money and record land together or not at all.
4. **Close.** After expiry plus a 15-minute grace period the payer takes back what is unspent and two thirds of its storage
   deposit. The seller stops serving 30 minutes before expiry, so it has time to redeem its last voucher.

## The voucher

```
Voucher(bytes32 session, uint96 cumulative, uint32 count, bytes32 head)

head[0] = keccak256(abi.encode("portal-meter/session/1", session))
head[n] = keccak256(abi.encode(head[n-1], requestHash[n], responseHash[n-1]))
```

`cumulative` is the total the provider may collect so far. `redeem` pays the part not yet paid, so only the newest
voucher matters. `head` is what makes this more than a payment channel: the voucher for request `n` commits to the hash
of the response the client received for request `n-1`. `SessionClient` advances only after it has checked the body against
the receipt, so a redeemed head is a signature, from the session key, over the requests made and the responses accepted.

| | Per-request escrow | Session |
|---|---|---|
| Who says "served" | the provider | the session key, by signing the next voucher |
| Transactions per request | 2 | none |
| New storage per request | 3 slots | none |
| What a dishonest provider can take | one request | one request: the client checks every receipt and stops signing |
| What the provider risks | nothing | what it served and did not redeem before the payer can close |
| Failed request | refund transaction | nothing happens: the seller keeps no state for it, the client signs the same step again |
| Lost response | refund after the delay | send the same voucher again: same body, no second charge |

## What the chain proves, exactly

- `redeem` verifies the signature and the budget. It does not walk the hash chain: `head` is an opaque value to the
  contract, published in the `Redeemed` event and anchored in ink!. The chain steps are checked off-chain, by the seller before
  serving and by anyone afterwards.
- A batch up to request `n` covers requests `1..n` and responses `1..n-1`. The response to request `n` is acknowledged only when
  a voucher for `n+1` exists.
- A voucher is signed before the response exists, so the provider always holds a voucher for one request it has not served yet.
  If it redeems that voucher and sends nothing, the buyer loses that one price and stops.
- It proves which bytes were received and accepted by the client, not that they were any good.

## Verifying a session

The seller publishes `GET /v1/session/{id}/log`: for each request its number, request hash, response hash and running total,
no bodies. Anyone can replay the chain from `head[0]` and compare it with the `Redeemed` events and the ink! anchors
(`verifyLog` in [`src/session.mjs`](../src/session.mjs); `portal-meter session-verify <seller> --session s.json` on the command line; the
live page has a button for it). A log that was edited, cut
short or reordered no longer reaches the head that was signed. Editing the response of the very last redeemed request goes
unnoticed until a later batch covers it, and the check names the range it covers.

## Limits

- The public demo on the live page shares one key between visitors, and takes the session's place from the seller. It shows the
  mechanism. Acknowledgement means something only for a client that keeps its own state, as `SessionClient` does.
- A provider paying itself can still produce a track record. Signed vouchers raise the cost of faking volume, they do not
  remove it: sybil-resistant reputation is out of scope.
- The ink! registry counts one `served` per redeemed batch. The number of requests is in the `Redeemed` event.
- `MeterRegistry.rate` works on per-request payments. In a session the buyer's voice is the voucher it stops signing.
- The seller keeps one state per session. If it loses that state the session cannot continue and the buyer opens a new one.
