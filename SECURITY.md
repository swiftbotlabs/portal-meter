# Security

Portal Meter moves (test) money and serves data to strangers, so every input is treated as hostile. This file lists
what each part defends against and what it does not. Report problems through a GitHub issue (no secrets in issues).

## Contracts

| Threat | Defence |
|---|---|
| Someone claims another buyer's payment | `requestId` is derived on-chain from `msg.sender`; the seller also requires a payer signature over the request id and the request hash |
| Paying twice for one request id / replay after refund | a request id can be paid once, ever: the status slot is kept when the amount slot is cleared |
| Provider goes silent after being paid | the payer can `refund` after the endpoint's `refundDelay` (60 s to 7 days) |
| Price raised between quote and payment | `pay(…, maxPrice)` reverts above the buyer's cap |
| Endpoint registered with an address that is not a token | `registerEndpoint` requires a one-word `totalSupply()` answer; low-level transfers also check the return data (`true` or nothing) |
| Re-entrancy through a hostile token | state is final before every transfer, plus a re-entrancy guard (tested with a token that re-enters `refund`) |
| Writing into another provider's registry entries | the ink! registry namespaces every write by the caller's own EVM address |
| Fake feedback | `rate` recomputes the request id from the caller's address, so only the payer can rate, once, and only a served request |
| Squatting anchors to block a provider | anchors are keyed by (provider, request id); others write only in their own namespace |

Not covered: `settle` is the provider's call. A dishonest provider can settle without delivering; the contract
cannot see the HTTP response. What the buyer has then is a public record: the absent or wrong body against the
hash in the `Served` event, and a dispute in the ink! registry. Buyers should cap what they pay a provider without
history. The registry also records what providers declare; a provider that pays itself can inflate its own
"served" count. The verifier detects anchors that have no matching `Served`/`Refunded` event, and `rate` gives
real payers a voice, but sybil-resistant reputation is out of scope.

## Sessions (`MeterSession`, voucher protocol, hosted seller)

| Threat | Defence |
|---|---|
| Replay of a voucher | `redeem` only accepts a higher `cumulative` and `count`; the signature covers session, cumulative, count and head; the EIP-712 domain binds chain and contract |
| Reopening a closed session to replay old vouchers | `close` keeps the first slot, and `open` refuses an id that was ever used |
| Voucher copied from a pending batch to make it revert | `redeem` is provider-only |
| A session key spending more than its budget | `redeem` refuses `cumulative` above the deposit; the seller checks the same before serving |
| Malleable signatures | `s` must be in the lower half of the curve order, the length must be 65 |
| Provider redeeming what was not served | it holds at most one unserved voucher, because the next one needs the previous response. The client checks every receipt and stops signing on a mismatch |
| Provider rewriting history | the head signed by the payer stops matching: `verifyLog` replays the public log against the `Redeemed` event |
| Hostile token | state is final before every token call (tested with a token that re-enters `redeem`); an endpoint's token is fixed at registration, and it only affects sessions of that endpoint |
| Provider never redeems, payer stuck | after expiry plus 15 minutes the payer can close and take back what is unspent |

Hosted seller (`worker/`):
- The provider key is a testnet key for this seller only, with a small tPOT balance, stored as a Worker secret. It holds no other funds.
- `/admin/settle` needs a bearer token compared in constant time. Without it the route answers 404.
- Per-address limits: 60 quotes, 30 paid requests, 240 free reads a minute, plus a global limit on paid requests.
- Upstream calls are serialised with a 220 ms gap, so the public Portaldot nodes never see more than 5 requests a second from this
  service, and the queue is capped at 40. Paid responses are cached for 15 seconds per path.
- Input is validated before a quote is issued, and the seller only talks to the two configured nodes. No user-supplied URL is fetched.
- The public demo key on the live page is derived from a public string on purpose. It can only sign vouchers for one session of test
  tokens, capped on-chain, and the only place that session pays is our own payee.

Not covered: an endpoint token that charges a fee on transfer would make the contract's book exceed its balance for that token.
Native assets do not do that. pallet-assets accounts have a minimum balance, so an amount below it cannot be paid to an empty
account; the first redeem of a session must be at least that minimum (0.01 pUSD).

## Seller

- GET only, URL ≤ 2,048 bytes, header block ≤ 16 KB, `PAYMENT` header ≤ 4 KB, strict base64/JSON parsing with a
  schema for every field (`src/protocol.mjs`).
- Malformed input is rejected before a quote is issued; nobody is asked to pay for an impossible request.
- Per-IP limits for quotes (60/min) and paid retries (30/min); bounded quote and request tables.
- Served once: the request id is claimed atomically before any work; the state file is written atomically (tmp +
  rename, mode 0600); a request interrupted by a crash is marked `interrupted`, never served again silently.
- Data is only fetched from the configured Portaldot nodes, with 10 s timeouts. No user-supplied URL is fetched.
- Nothing is delivered unless the settlement transaction succeeded; if settling fails the payment stays refundable.
- The seller binds to 127.0.0.1 by default.

## Keys

- Keys are read at run time from a 0600 env file outside the repository (`--keys`); the deploy script refuses a
  file readable by group or others and never prints a key.
- Testnet keys only. CI has no secrets and signs nothing; the Node tests generate throwaway wallets on a local
  anvil chain.
- Every commit is gated on a secret scan (exact values from the key file plus generic credential patterns).

## Supply chain

- Node dependencies pinned in `package-lock.json`, installed with `--ignore-scripts`.
- `forge-std` v1.16.2 vendored unmodified (checked byte for byte against the official release tarball, sha256
  `35dbdf9c…4275`), used by tests only. The browser bundle of ethers 6.16.0 is vendored with its checksum
  (`demo/vendor/README.md`); the live page loads no third-party scripts.
- GitHub Actions are pinned by commit SHA.
