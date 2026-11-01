# Portaldot V3 testnet: what we measured

Facts this project relies on, each checked against the live PortaldotV3 testnet (runtime `portaldot-v3` spec 3002,
node `3.0.0-dev-fddd43141f2`, genesis `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`) on
2026-11-01. The commands are in [`scripts/probe.mjs`](../scripts/probe.mjs), so anyone can re-run them.

## Endpoints

| | Value |
|---|---|
| Substrate RPC | `wss://test-node-v3.portaldot.dev` (JSON-RPC over `https://` works too, with CORS `*`) |
| EVM RPC | `https://test-evm-rpc-v3.portaldot.dev` (`web3_clientVersion` = `eth-rpc/main-fddd431`, Parity's eth-rpc adapter) |
| EVM chain id | `420420777` (`0x190f1ca9`) |
| Node console | https://node-console.portaldot.dev (polkadot.js apps; add `?rpc=wss://test-node-v3.portaldot.dev`) |
| Substrate explorer | https://scanner-testnet-v3.portaldot.dev (indexes the Substrate side: search blocks and `5...` accounts) |
| Token | tPOT, 14 decimals on Substrate, 18 on the EVM side (`Revive.NativeToEthRatio` = 10,000) |

The endpoints reject the default User-Agent of Python's `urllib` (Cloudflare error 1010); browsers, Node.js `fetch`,
ethers and polkadot.js are fine.

## Two contract VMs in one runtime

| | WASM | EVM |
|---|---|---|
| Pallet | `contracts` (ink!), `apiVersion` 4: ink! 5.x | `revive`, `AllowEVMBytecode = true`: plain `solc` output deploys, no `resolc` step |
| Deposit per byte | 6,000,000,000,000 planck = 0.06 tPOT | 0.06 tPOT |
| Deposit per storage item | 0.15 tPOT | 0.15 tPOT |
| Code hash lockup | 30 % | 30 % |
| Max code size | 125,952 bytes | EVM limits |

`Revive.AutoMap = true`: an account is mapped to its EVM address automatically on first use.

**Cost in practice:** storage deposits dominate. `eth_estimateGas` for deploying our 3,454-byte
`MeterSettlement` initcode returned `0x27f191fa3c028c` gas at a gas price of `0x6324`, i.e. about **285 tPOT**, almost
all of it the code deposit. On the WASM side, a `ContractsApi_instantiate` dry-run of our 16,090-byte ink!
`MeterRegistry` asks for a **1,270.29 tPOT** storage deposit (code, its 30 % hash lockup and the contract's own
storage). A storage slot that goes from zero to non-zero costs a deposit; setting it back to zero
returns it. That is why `MeterSettlement` clears the amount slot of every finished payment.

## Address mapping between the VMs

| From | To | Rule | Checked with |
|---|---|---|---|
| EVM address `0xabc...` | Substrate account | `0xabc...` followed by twelve `0xEE` bytes | `ReviveApi_account_id` |
| Substrate account (sr25519, ed25519) | EVM address | `keccak256(account_id)[12..32]` | `ReviveApi_address` |

So to fund a MetaMask key, send tPOT to its twin account (`scripts/lib/addr.mjs` computes it).

## Native assets are ERC-20 tokens on the EVM side

The runtime registers pallet-revive's ERC-20 precompile for `pallet-assets` (instance 1). Asset `id` is reachable at

```
0x{id as 8 hex digits}000000000000000000000000 00010000
```

(e.g. asset 7777 at `0x00001e6100000000000000000000000000010000`). `eth_call` of `totalSupply()` on that address
returned the asset's supply; prefix `0002` answers for `pool-assets`. A Solidity contract can therefore take payment
in a Portaldot native asset with the ordinary `transferFrom`/`transfer` calls, with no wrapped token contract to
deploy. Creating an asset costs `Assets.AssetDeposit` = 1 tPOT.

## Calling Substrate pallets from an EVM transaction

The runtime exposes `revive.ethSubstrateCall` and `ReviveApi_runtime_pallets_address` returns
`0x6d6f646c70792f70616464720000000000000000` (`"modlpy/paddr"`). An Ethereum transaction sent to that address with a
SCALE-encoded runtime call as its input is dispatched as that call, signed by the sender's twin account.
Portal Meter uses this path so the provider's EVM key can also write to the ink! registry; see
[ARCHITECTURE.md](ARCHITECTURE.md#cross-vm-path). What we saw on the live chain:

- A top-level transaction is decoded and dispatched (`eth_estimateGas` of garbage input: `Invalid call`; of a transfer
  from an empty account: `Token(FundsUnavailable)`; of a call to a missing ink! contract: `Contracts.ContractNotFound`).
- A **Solidity contract** calling the same address is a call to an empty account: it returns success and nothing runs.
- `utility.batchAll([revive.call, contracts.call])` works, `msg.sender` is the sender's H160, the ink! caller is its twin.
- Logs of the batched `revive.call` appear in `eth_getLogs` under the Ethereum transaction's hash.
- Receipts of these transactions report `gasUsed` 0, so read costs from balance changes.

## Faucet

There is no public faucet. Test tPOT is distributed by the Portaldot team to registered builders (native `5...`
address). Plan for the deposits. What our deployment cost in practice:

| Step | tPOT |
|---|---|
| `MeterSettlement`, 3,454 bytes of initcode | 280.85 |
| `MeterRegistry` (ink!), 16,090 bytes of wasm | 1,270.29 |
| First endpoint in Solidity / each further one | 15.39 / 11.55 |
| One paid request (buyer) | 7.70 |
| Settle or refund (the freed slot covers it) | 0 |
