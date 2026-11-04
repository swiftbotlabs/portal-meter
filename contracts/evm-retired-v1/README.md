# Retired: first MeterSession deployment

This folder holds the exact source of the first MeterSession we deployed on the Portaldot V3 testnet
(chain 420420777), before the independent security review:

- address `0xeA6bf3B925B9CA1435e19D2369B0c38D795887c4`
- deploy tx `0x8afb7c6c5fe04d5d0e5cf50caf05322ae0d3886fcc2f96cf3c5b078282206e74`, block 282230
- source as of commit 14992b6

It was replaced after the review by the MeterSession in `contracts/evm` (`0xCc2aBc8AC1B5676e8f9678bb5B6881A0b743B3d5`).
Nothing new should use this address. It stays here only so every contract we ever deployed can be checked
against its source, byte for byte.

Check it yourself:

```sh
cd contracts/evm-retired-v1
forge build
cast code 0xeA6bf3B925B9CA1435e19D2369B0c38D795887c4 --rpc-url https://test-evm-rpc-v3.portaldot.dev
```

The deployed code equals `out/MeterSession.sol/MeterSession.json` `deployedBytecode`, with the one immutable
(the settlement address `0x9E7Ad2Aa754A0EBA70CFbd1db01d25ef97e5781e`) filled in by the constructor.
