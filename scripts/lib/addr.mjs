// pallet-revive address mapping (polkadot-sdk AccountId32Mapper):
//  - an Ethereum-style H160 owns the substrate account H160 ++ 0xEE * 12 ("twin");
//  - an ordinary 32-byte account appears in the EVM as keccak256(account)[12..].
import { hexToU8a, u8aToHex, u8aConcat } from '@polkadot/util';
import { keccakAsU8a, decodeAddress } from '@polkadot/util-crypto';

export function twinAccountId(h160) {
  const a = hexToU8a(h160);
  if (a.length !== 20) throw new Error('not a 20-byte address');
  return u8aConcat(a, new Uint8Array(12).fill(0xee));
}

export function isEthDerived(accountId32) {
  const a = accountId32 instanceof Uint8Array ? accountId32 : decodeAddress(accountId32);
  return a.length === 32 && a.slice(20).every(b => b === 0xee);
}

export function h160OfAccount(account) {
  const a = account instanceof Uint8Array ? account : decodeAddress(account);
  if (a.length !== 32) throw new Error('not a 32-byte account');
  if (isEthDerived(a)) return u8aToHex(a.slice(0, 20));
  return u8aToHex(keccakAsU8a(a, 256).slice(12));
}
