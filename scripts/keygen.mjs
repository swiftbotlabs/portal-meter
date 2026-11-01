// Generates a fresh TESTNET-ONLY key set and writes it to a 0600 env file.
// Prints public addresses only. Refuses to overwrite an existing file.
// usage: node scripts/keygen.mjs <path/to/portaldot_testnet.env>
import { writeFileSync, existsSync, openSync, closeSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { cryptoWaitReady, mnemonicGenerate, encodeAddress } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';
import { Wallet } from 'ethers';
import { twinAccountId } from './lib/addr.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: keygen.mjs <out.env>'); process.exit(2); }
if (existsSync(out)) { console.error('refusing to overwrite', out); process.exit(3); }
await cryptoWaitReady();
const mnemonic = mnemonicGenerate(24);
const kr = new Keyring({ type: 'sr25519', ss58Format: 42 });
const sub = kr.addFromMnemonic(mnemonic);
const roles = ['DEPLOYER', 'PROVIDER', 'BUYER'];
const evm = Object.fromEntries(roles.map(r => {
  let w; do { w = new Wallet('0x' + randomBytes(32).toString('hex')); } while (!w);
  return [r, w];
}));
const lines = [
  '# Portaldot V3 TESTNET ONLY keys (generated ' + new Date().toISOString() + '). Never use on mainnet.',
  'PORTALDOT_SUB_MNEMONIC="' + mnemonic + '"',
  'PORTALDOT_SUB_ADDRESS=' + sub.address,
  ...roles.flatMap(r => [
    `PORTALDOT_EVM_${r}_KEY=${evm[r].privateKey}`,
    `PORTALDOT_EVM_${r}_ADDRESS=${evm[r].address}`,
  ]),
];
const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
writeFileSync(fd, lines.join('\n') + '\n');
closeSync(fd);
console.log('substrate (sr25519) SS58:', sub.address);
for (const r of roles) {
  console.log(`evm ${r.toLowerCase()}: ${evm[r].address}  twin SS58: ${encodeAddress(twinAccountId(evm[r].address), 42)}`);
}
