# Portal Meter

Pay-per-request API settlement for **Portaldot V3**, built on both of its contract VMs.

An API provider lists an endpoint with a price. A client pays for a single request in an ERC-20, which can be a
Portaldot native asset, and the payment is held in escrow by a Solidity contract on Portaldot's EVM. The provider
serves the request once and settles it on-chain. If it cannot deliver, the payment is refunded. An ink! contract on
Portaldot's WASM VM keeps a public record of each provider's served and refunded requests, so any client can check
a provider's track record before paying.

By Swift Bot Labs for the Portaldot Hacker House 2026, track **Modular Cloud & Middleware**.

**Live page:** [swiftbotlab.github.io/portal-meter/demo/](https://swiftbotlab.github.io/portal-meter/demo/) reads the
PortaldotV3 testnet from your browser (network, the native-asset ERC-20 precompile, contracts, endpoints, provider
record, payments) and includes a free receipt verifier.

> **Status (2026-11-01): in development.** The EVM settlement contract, the ink! registry, the HTTP seller, the
> buyer client, the receipt verifier and the live page are in this repository, with tests. The testnet deployment
> is next; its addresses and transactions will be listed here.

## Why Portaldot

- **Two VMs, one chain.** Settlement runs where the ERC-20 tooling is (pallet-revive, plain Solidity). Provider
  reputation runs in ink! on pallet-contracts. Both halves use the same account identity.
- **Native assets as ERC-20.** Portaldot exposes every `pallet-assets` token to Solidity through an ERC-20
  precompile, so a provider can price an endpoint in a native asset without deploying a wrapped token.
- **Substrate calls from an EVM key.** `revive.ethSubstrateCall` lets the provider's EVM key also write to the
  WASM registry.

Measured network facts are in [docs/PORTALDOT_V3_NOTES.md](docs/PORTALDOT_V3_NOTES.md).

## Repository

| Path | What |
|---|---|
| `contracts/evm/` | `MeterSettlement.sol` (Foundry): endpoints, escrowed per-request payments, settle once, refunds |
| `src/` | seller (HTTP 402), buyer client, receipt verifier, protocol, EVM and ink! clients, cross-VM batch builder |
| `test/` | Node tests, including end to end on a local anvil chain |
| `demo/` | the live page (static, served by GitHub Pages) |
| `contracts/ink/` | `MeterRegistry` (ink! 5): endpoint URLs, outcome anchors, buyer feedback |
| `docs/` | network notes, architecture, protocol |
| `scripts/` | key generation (testnet only), read-only network probe |

## Run the tests

```bash
cd contracts/evm
forge test        # unit, fuzz and invariant tests
forge build --sizes
```

```bash
npm ci --ignore-scripts
node scripts/probe.mjs   # re-checks the network facts against the live testnet, read-only
```

## Credits and prior work

- Builds on our MIT-licensed [HSK Meter](https://github.com/swiftbotlab/hsk-meter) (Oct 2026): the request-id
  binding and refund-on-failure ideas come from it. The contracts, the ink! registry, the Portaldot integration and
  the off-chain code in this repository were written for Portaldot during the Hacker House.
- [forge-std](https://github.com/foundry-rs/forge-std) v1.16.2 (MIT/Apache-2.0), vendored unmodified under
  `contracts/evm/lib/`, used by the tests only.
- [ethers](https://github.com/ethers-io/ethers.js) 6.16.0 (MIT) and [polkadot.js](https://github.com/polkadot-js/api)
  16.5.6 (Apache-2.0), pinned in `package-lock.json`.

## License

MIT, see [LICENSE](LICENSE).
