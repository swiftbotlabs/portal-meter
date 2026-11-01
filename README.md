# Portal Meter

[![CI](https://github.com/swiftbotlab/portal-meter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/swiftbotlab/portal-meter/actions/workflows/ci.yml)

**Pay-per-request API settlement for Portaldot V3, built on both of its contract VMs.**

An API provider lists an endpoint with a price. A client pays for **one request** in a Portaldot native asset,
reached from Solidity through the runtime's ERC-20 precompile. The payment waits in escrow in a Solidity contract on
Portaldot's EVM. The provider serves the request once and settles it, or refunds it when it cannot deliver. In the
same Ethereum-signed transaction, the outcome is anchored in an **ink!** registry on Portaldot's WASM VM, which
gives every provider a public, per-request track record that buyers can check before they pay.

By Swift Bot Labs for the Portaldot Hacker House 2026, track **Modular Cloud & Middleware**.

**Live page:** [swiftbotlab.github.io/portal-meter/demo/](https://swiftbotlab.github.io/portal-meter/demo/) reads the
PortaldotV3 testnet from your browser (network, the native-asset ERC-20 precompile, contracts, endpoints, provider
record, payments) and includes a free receipt verifier.

> **Status (2026-11-01):** contracts, seller, buyer, verifier, live page and tests are complete. The testnet
> deployment runs with one command (`scripts/deploy-testnet.mjs`) and is waiting for testnet tPOT; addresses and
> transactions will be listed under [Testnet deployment](#testnet-deployment).

## How a request is paid

![Architecture](pitch/architecture.svg)

1. `GET /v1/asset/7777` → `402 Payment Required` with a quote: endpoint, price, token, a fresh nonce, the hash of
   this exact request.
2. The client checks the quote against the on-chain endpoint and the provider's record in the ink! registry, then
   calls `MeterSettlement.pay(endpointId, nonce, maxPrice)`. The contract derives the request id from the payer's
   address, so the payment can never be claimed by anyone else.
3. The client retries with a proof signed by the paying key. The seller checks it and the on-chain payment, and
   claims the request id: **served once**.
4. The seller sends one Ethereum transaction to Portaldot's runtime pallets address with
   `utility.batchAll([revive.call(settle), contracts.call(record)])`: the Solidity settlement and the ink! anchor
   happen together or not at all. If it cannot deliver, the same transaction shape refunds instead.
5. The client gets the body and a provider-signed receipt. Anyone can verify it: **ACCEPT / REJECT** with every
   check, on the command line or in the browser.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md) ·
[SECURITY.md](SECURITY.md) · measured network facts in [docs/PORTALDOT_V3_NOTES.md](docs/PORTALDOT_V3_NOTES.md).

## Why Portaldot

| Portaldot V3 feature | What Portal Meter does with it |
|---|---|
| Native assets exposed to Solidity as ERC-20 (pallet-assets precompile) | endpoints are priced in a native asset (`tUSDm`); no wrapped token contract |
| Two contract VMs in one runtime (pallet-revive EVM + pallet-contracts WASM) | escrow in Solidity, provider registry in ink!, both keyed by the same EVM address |
| Runtime calls from Ethereum transactions (`revive.ethSubstrateCall`) | settlement + registry anchor in one atomic transaction signed by the provider's Ethereum key; buyers rate providers in ink! from their Ethereum key |
| Storage deposits (pallet-revive / pallet-contracts) | payments clear their amount slot when final, so the deposit comes back |

The ink! registry recomputes the Solidity request id (`keccak256(abi.encode(chainId, settlement, payer, endpoint,
nonce))`) from the caller's own address. Only the account that paid on the EVM side can rate a request, and no
bridge or oracle is involved.

## Testnet deployment

PortaldotV3 testnet: EVM chain id `420420777`, `https://test-evm-rpc-v3.portaldot.dev`,
`wss://test-node-v3.portaldot.dev`, explorer [scanner-testnet-v3.portaldot.dev](https://scanner-testnet-v3.portaldot.dev).

_Pending: the deployment script is ready and runs once the deployer account holds testnet tPOT. This section will
list the contract addresses, the asset, and every transaction (deploy, endpoint registration, one served request,
one refund, buyer feedback), as `deployments/testnet.json` will._

## Run it

Requirements: Node.js 20+, [Foundry](https://getfoundry.sh) for the contract tests.

```bash
npm ci --ignore-scripts
(cd contracts/evm && forge build && forge test)   # 20 Solidity tests: unit, fuzz, invariant
npm test                                           # 25 Node tests, incl. end to end on a local anvil chain
node scripts/probe.mjs                             # re-checks the Portaldot facts this project relies on (read-only)
```

Against the testnet deployment (`deployments/testnet.json`):

```bash
node bin/portal-meter.mjs status                                   # endpoints and provider record, no key
node bin/portal-meter.mjs serve --keys provider.env                # the HTTP 402 seller on 127.0.0.1:8402
node bin/portal-meter.mjs buy http://127.0.0.1:8402/v1/asset/7777 --keys buyer.env --out receipt.json
node bin/portal-meter.mjs verify receipt.json                      # ACCEPT / REJECT, no key
```

Key files are `0600` env files (`PORTALDOT_EVM_PROVIDER_KEY=0x…`, `PORTALDOT_EVM_BUYER_KEY=0x…`), testnet keys only.

### Deploy your own

```bash
node scripts/keygen.mjs ~/portaldot_testnet.env          # sr25519 + three EVM keys, 0600, prints addresses only
# fund the printed sr25519 address with testnet tPOT, then:
node scripts/deploy-testnet.mjs --keys ~/portaldot_testnet.env --plan   # cost estimate, sends nothing
node scripts/deploy-testnet.mjs --keys ~/portaldot_testnet.env          # resumable, step by step
```

The ink! contract is built in CI (`cargo contract build --release`, cargo-contract 5.0.3); the bundle used for the
deployment is committed under `contracts/ink/meter_registry/artifact/`.

## Repository

| Path | What |
|---|---|
| `contracts/evm/` | `MeterSettlement.sol` (Foundry): endpoints, escrowed per-request payments, settle once, refunds |
| `contracts/ink/meter_registry/` | `MeterRegistry` (ink! 5): endpoint URLs, outcome anchors, buyer feedback, reputation |
| `src/` | seller (HTTP 402), buyer client, receipt verifier, protocol, EVM and ink! clients, cross-VM batch builder |
| `bin/portal-meter.mjs` | command line: `status`, `verify`, `buy`, `serve` |
| `scripts/` | key generation (testnet only), network probe, deployment + live demo, pitch deck builder |
| `test/` | Node tests, including end to end on a local anvil chain |
| `demo/` | the live page (static, served by GitHub Pages) |
| `docs/` | architecture, protocol, Portaldot V3 network notes |
| `pitch/` | architecture diagram and pitch deck |

## Credits and prior work

- Builds on our MIT-licensed [HSK Meter](https://github.com/swiftbotlab/hsk-meter) (Oct 2026): the request-id
  binding and refund-on-failure ideas come from it. The contracts, the ink! registry, the cross-VM settlement, the
  Portaldot integration and the off-chain code in this repository were written for Portaldot during the Hacker House.
- [forge-std](https://github.com/foundry-rs/forge-std) v1.16.2 (MIT/Apache-2.0), vendored unmodified under
  `contracts/evm/lib/`, tests only. [ink!](https://github.com/use-ink/ink) 5.1.1 (Apache-2.0).
- [ethers](https://github.com/ethers-io/ethers.js) 6.16.0 (MIT) and [polkadot.js](https://github.com/polkadot-js/api)
  16.5.6 (Apache-2.0), pinned in `package-lock.json`; the browser bundle of ethers is vendored under `demo/vendor/`.

## License

MIT, see [LICENSE](LICENSE).
