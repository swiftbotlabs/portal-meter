// Portaldot V3 addresses without polkadot.js: SS58 (prefix 42) with its checksum, and the EVM view of an account
// that pallet-revive uses (an H160 maps to its twin H160 ++ 0xEE*12). Throws BadInput (httpStatus 400) on bad input,
// so an API can refuse a request before it quotes a price for it.
export { BadInput, parseAddress, ss58Decode, ss58Encode } from './lite-data.mjs';
