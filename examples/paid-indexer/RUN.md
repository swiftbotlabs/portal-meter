# Run log: the paid indexer, installed from a clean folder and settled on the Portaldot V3 testnet

4 November 2026, 17:19 to 17:24 UTC. Run by the Portal Meter authors with our own testnet keys: provider
`0x43CA1C7C2551eA0eAD326320f2dA922EfA7C1599` (the key behind endpoints 1 and 2), buyer `0x0118d896dC979963341e9449218e63E158CB6AbA`.
Keys stay in a `0600` file and are never printed. Test tokens have no value. Output below is copied from the terminal;
long JSON lines are shortened with `…`.

Three Ethereum transactions in all: register (both VMs), open the session, settle the batch (both VMs).

## 1. Install from an empty folder

The package was packed from commit `2335d1e` (47 files, all byte-identical to that commit, sha256
`66c4def0cfab39e4e7c3f7d58b7d1984641cff5191614930db0c0908a4771754`). `npm i github:swiftbotlabs/portal-meter` packs the
same `files` list from the repository.

```text
$ mkdir clean && cp examples/paid-indexer/{*.mjs,package.json} clean/ && cp -r examples/paid-indexer/test clean/
$ cd clean    # the copy's github: dependency is dropped first, so that npm takes the tarball instead
$ npm install --ignore-scripts ./portal-meter-0.1.0.tgz
added 104 packages in 27s
$ npm test
# tests 9
# pass 9
# fail 0
$ npx portal-meter status
network      PortaldotV3 Testnet (EVM chain id 420420777)
settlement   0x9E7Ad2Aa754A0EBA70CFbd1db01d25ef97e5781e (Solidity, pallet-revive)
registry     5DHgN8JZRpyo9mDaG1BSNh224AZXcQw8p3Y8GZK1K2Vd8Ku4 (ink!, pallet-contracts): 3 endpoints, 16 anchors
…
endpoint 3   0.01 pUSD · https://portal-meter.swiftbotlab.workers.dev/v1/ · served 12, refunded 0, confirmed 0, disputed 0, score 100.0 %
```

## 2. Register the endpoint on both VMs, one transaction

```text
$ npx portal-meter register --keys provider.env --key-var PORTALDOT_EVM_PROVIDER_KEY --asset 7777 --price 0.01 \
    --url 'http://127.0.0.1:8788/v1/transfers/{address}'
endpoint 4: 0.01 per request, tx 0xcd423ae4d51437dff7e69846a9bac4ed82f610665bd1eb7672529f7d4251ac0b, block 323203
$ npx portal-meter status
…
endpoint 4   0.01 pUSD · http://127.0.0.1:8788/v1/transfers/{address} · served 0, refunded 0, confirmed 0, disputed 0, score 0.0 %
```

Block [323203](https://scanner-testnet-v3.portaldot.dev/#/blocks/323203?tab=events), extrinsic 1: `revive.ContractEmitted`
(the endpoint in `MeterSettlement`), `contracts.ContractEmitted` and `contracts.Called` (the URL in the ink! registry),
`utility.BatchCompleted`. The provider paid 17.77 tPOT, nearly all of it storage deposit.

## 3. Start the seller

```text
$ node server.mjs --keys provider.env --endpoint 4 --port 8788 --state ledger.json --check-sec 15 --settle-min 2 --settle-gap 0
{"at":"2026-11-04T17:21:20.538Z","event":"listening","url":"http://127.0.0.1:8788/","endpointId":4,"provider":"0x43CA1C7C2551eA0eAD326320f2dA922EfA7C1599","price":"10000"}
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/v1/transfers/5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8P
402
$ curl -s http://127.0.0.1:8788/v1/transfers/bogus
{ "error": "not an SS58 or 0x address", "charged": false }
```

`--settle-min 2 --settle-gap 0` makes the seller settle as soon as two requests wait; the defaults are 25 requests or six hours.

## 4. The buyer opens a session, once

```text
$ npx portal-meter session-open 4 --keys buyer.env --budget 0.05 --days 7 --out session.json
session 0xa7228fed80913c74e7a0186d173d86ab2265a32130b71e37b5ab504fce978eb9: budget 0.05, tx 0x180b2ae8ca20b92fea3607e4506b05b63a00b792a9e1014aa386ba340519c9bc, block 323209, state in session.json
```

Block [323209](https://scanner-testnet-v3.portaldot.dev/#/blocks/323209?tab=events): `assets.Transferred` (0.05 pUSD into
`MeterSession`). The buyer paid 11.55 tPOT, the same storage deposit as every session measured before; 7.67 of it comes back at close.

## 5. Two paid calls, no transaction

```text
$ node buy.mjs http://127.0.0.1:8788/v1/transfers/5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8P --session session.json
HTTP 402  quote: 10000 base units of pUSD for endpoint 4, provider 0x43CA1C7C2551eA0eAD326320f2dA922EfA7C1599, request 0x6dd574fb41756bedb4f73ac91d699ad15f580c2a6cb72ca20a0af37d3922b6f6
voucher   1 signed: cumulative 10000, head 0x79b936acacf314820d31fcd4454850c522c9d0ba7d6763eba583c0ff06ca7c01
HTTP 200  receipt checked: response 0xae41989700b6c3064e566ebb9e6228a044c168963dc725edff5c7a0f1056acc0, signed by the provider
data      5 of 5 transfers of 5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8P, from Portaldot explorer indexer, https://scanner-testnet-v3-api.portaldot.dev
          block 282489  in    25 tPOT
          block 282414  in    30 tPOT
          block 282171  in    30 tPOT

$ node buy.mjs http://127.0.0.1:8788/v1/transfers/0x77df5A7c0375bE0A492C109CcaFB96551fa8Ca5C --session session.json
HTTP 402  quote: 10000 base units of pUSD for endpoint 4, provider 0x43CA1C7C2551eA0eAD326320f2dA922EfA7C1599, request 0x8a252b5ef2b87a57f49c1bbc3bf99de2c0fae3e6b360a833b4b6f44a039549d6
voucher   2 signed: cumulative 20000, head 0x3a1bd8b6fd6afd124eb84858d9e6c734ca02162a812465ca1fe8759601085fec
HTTP 200  receipt checked: response 0x9be2439ba365ddb0976e1cbf544e94f437ee7178366fefaaab11ba7eeb55e040, signed by the provider
data      1 of 4 transfers of 5EmsuTbjRoX4EBA1QGcNvDc3FHs7kvKj6rDPZk9L2zFTuzxA, from Portaldot explorer indexer, https://scanner-testnet-v3-api.portaldot.dev
          block 282228  in    35 tPOT
```

The second call names an EVM address; the seller sold the history of its Portaldot twin account. Voucher 2's head commits
to the hash of response 1.

"1 of 4" was a bug this run found: the explorer sends some amounts as a `0x` big-endian u128 instead of a decimal string, and
the first version of `upstream.mjs` dropped those rows. Fixed before the example was committed, with a test (step 7).

## 6. The seller settles: one Ethereum transaction, both VMs

```text
{"at":"2026-11-04T17:21:50.534Z","check":"settle","settled":false,"reason":"not due"}
{"at":"2026-11-04T17:22:14.995Z","check":"settle","settled":true,"tx":"0xfed599131a6419b4b6732da18e64f2350f96acd3cf86e1a05dbd33a59889ba4e","block":323215,"requests":2}
```

Block [323215](https://scanner-testnet-v3.portaldot.dev/#/blocks/323215?tab=events), extrinsic 1, 15 events:
`assets.Transferred` (0.02 pUSD to the payee), `revive.ContractEmitted` (`Redeemed`), `utility.ItemCompleted`,
`contracts.ContractEmitted`, `contracts.Called` and `contracts.StorageDepositTransferredAndHeld` (the ink! anchor),
`utility.BatchCompleted`. The provider paid 3.69 tPOT: one ink! anchor deposit plus the fee.

Read back from the chain afterwards with the repository's verifier code (log replay, `Redeemed` event, ink! anchor):

```text
Redeemed events [ { block: 323215, tx: '0xfed599131a6419b4b6732da18e64f2350f96acd3cf86e1a05dbd33a59889ba4e',
    head: '0x3a1bd8b6fd6afd124eb84858d9e6c734ca02162a812465ca1fe8759601085fec', count: 2, cumulative: '20000', paid: '20000', endpointId: 4 } ]
ink! endpoint 4 { uri: 'http://127.0.0.1:8788/v1/transfers/{address}', served: 1, refunded: 0, confirmed: 0, disputed: 0,
    volume: '20000', registeredAt: 323203, lastActivity: 323215 }
payee pUSD 20000
PASS log replays from the session genesis | 2 requests
PASS batch up to request 2 matches the payer-signed head on-chain (responses 1 to 1 acknowledged) | 0x3a1bd8b6fd6afd124eb84858d9e6c734ca02162a812465ca1fe8759601085fec
PASS ink! anchor for batch up to 2: endpoint, amount and receipt hash | block 323215, amount 20000, receiptHash 0x4ae78eb3e89522c67b17f856e9580fb0e0a18244ad679746b03c81610c27c9f0
ACCEPT
```

## 7. Restart, and the fix

The seller was stopped and started again with the fixed `upstream.mjs`. Its vouchers were in `ledger.json`, so the session
went on at request 3:

```text
$ node buy.mjs http://127.0.0.1:8788/v1/transfers/0x77df5A7c0375bE0A492C109CcaFB96551fa8Ca5C --session session.json
HTTP 402  quote: 10000 base units of pUSD for endpoint 4, provider 0x43CA1C7C2551eA0eAD326320f2dA922EfA7C1599, request 0x8a252b5ef2b87a57f49c1bbc3bf99de2c0fae3e6b360a833b4b6f44a039549d6
voucher   3 signed: cumulative 30000, head 0x0d906c3e345c1787c6238c533b39ec164d2a0ac1ab388fd23c3a6dc8a537c0dd
HTTP 200  receipt checked: response 0xf3a7ec4521a807364c6b9a4eb06b7d311ab16cd28182165f3038f82de495bfd6, signed by the provider
data      4 of 4 transfers of 5EmsuTbjRoX4EBA1QGcNvDc3FHs7kvKj6rDPZk9L2zFTuzxA, from Portaldot explorer indexer, https://scanner-testnet-v3-api.portaldot.dev
          block 282413  in    310 tPOT
          block 282228  in    35 tPOT
          block 282171  in    320 tPOT
```

Request 3 is signed and served but not settled yet: one request waiting is below this run's `--settle-min 2`.

## What this run does not show

- Outside demand. The provider, the buyer and the seller's machine are ours; the endpoint's URL is `127.0.0.1`.
- A second team. The example is ours, written against the published package only. The data comes from Portaldot's own
  public explorer, read at under 4 requests per second.
- Anything about mainnet costs. Test tokens have no value; the deposits are what this testnet charges today.
