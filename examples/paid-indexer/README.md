# Paid indexer: a Portal Meter seller in its own folder

Account transfer history from Portaldot's public explorer indexer, sold per call at 0.01 pUSD with Portal Meter sessions
and settled across both of Portaldot's contract VMs. A plain RPC node cannot answer "which transfers touched this
account?" without scanning every block; an indexer can, and this is the kind of read an indexer operator would charge for.

**What this is, honestly:** an example built by the Portal Meter authors, written the way a third party would write it.
It depends on the published package only (`portal-meter` in [`package.json`](package.json)), uses only its public entry
points, and was installed and run from an empty folder. It is not a second team and it is not a service we run: the
upstream data is Portaldot's own explorer API, used at under 4 requests per second, and the endpoint's URL in the ink!
registry is `http://127.0.0.1:8788/...` because the seller ran on our machine. The recorded run is in [RUN.md](RUN.md).

## What it uses from the package

| Entry point | For |
|---|---|
| `portal-meter` | `createMeter`, the Node adapters `nodeRequest` and `sendNode` |
| `portal-meter/settle` | `createSettler`: when to settle, chain re-read, dry-run, one cross-VM transaction |
| `portal-meter/chain` | reading a session from `MeterSession` |
| `portal-meter/address` | SS58 with checksum, and an EVM address mapped to its Portaldot twin |
| `portal-meter/session-client` | the buyer: quote checks, vouchers, receipt checks |
| `portal-meter/deployments/sessions.json` | the testnet contracts |
| `npx portal-meter` | `register`, `session-open`, `status` |

Its own code is about 300 lines: [`app.mjs`](app.mjs) (routes), [`upstream.mjs`](upstream.mjs) (the explorer client,
fixed host, timeouts, size cap, spacing), [`file-ledger.mjs`](file-ledger.mjs) (vouchers survive a restart),
[`server.mjs`](server.mjs) (wiring, settlement loop with a watchdog), [`buy.mjs`](buy.mjs) (one paid call).

## Run it

Node.js 20+, a provider key and a buyer key with testnet tPOT, and some pUSD (asset 7777) for the buyer, from the native exchange.
Key files are `0600` env files; keys are never printed.

```bash
npm install                      # installs portal-meter from github:swiftbotlabs/portal-meter
npm test                         # 9 tests, offline

npx portal-meter register --keys provider.env --key-var PORTALDOT_EVM_PROVIDER_KEY \
  --asset 7777 --price 0.01 --url 'http://127.0.0.1:8788/v1/transfers/{address}'        # one tx, both VMs: prints the endpoint id
node server.mjs --keys provider.env --endpoint <id>                                     # the seller, on 127.0.0.1:8788

npx portal-meter session-open <id> --keys buyer.env --budget 0.05 --out session.json    # lock a budget once
node buy.mjs http://127.0.0.1:8788/v1/transfers/<ss58-or-0x-address> --session session.json
```

The seller settles when 25 requests are waiting or the oldest has waited 6 hours (`--settle-min`, `--settle-gap` change
that), logs one line per check, and exits with an error after 5 failed checks in a row so a supervisor can restart it.

## Routes

- `GET /v1/transfers/{address}` paid: SS58 or 0x address; a bad address is refused with 400 before any quote, for free
- `GET /v1/session/{id}` free: where a session stands, for a client that lost its place
- `GET /v1/session/{id}/log` free: request and response hashes, so anyone can replay the session against the chain
- `GET /` free: what is for sale, and for how much

A request the explorer cannot answer (down, too slow, too large, not JSON) is answered 502 and charges nothing.
