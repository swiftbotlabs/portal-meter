#!/usr/bin/env node
// Negative controls against the live deployment. Dry-runs only (eth_call, ContractsApi_call): no key, nothing is sent.
// Shows that the rules hold on the real chain, not only in the test suite; results go to deployments/proof/.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Abi, ContractPromise } from '@polkadot/api-contract';
import { NETWORK, PATHS, loadDeployment } from '../src/config.mjs';
import { makeProvider, settlementIface } from '../src/evm.mjs';
import { InkRegistry } from '../src/registry.mjs';
import { RawInkRegistry } from '../src/inkraw.mjs';
import { verifyReceipt } from '../src/verify.mjs';
import { twinSs58 } from '../src/xvm.mjs';

const dep = loadDeployment();
const evm = makeProvider(NETWORK.evmRpc, NETWORK.chainId);
const served = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'receipts', 'served.json'), 'utf8'));
const refunded = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'receipts', 'refunded.json'), 'utf8'));
const out = [];
const note = (check, expected, got) => {
  const ok = expected === got;
  out.push({ check, expected, got, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}: ${got}`);
};
async function evmError(from, data) {
  try {
    await evm.call({ from, to: dep.settlement, data });
    return 'no revert';
  } catch (e) {
    const d = e?.data || e?.info?.error?.data;
    if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) return settlementIface.parseError(d)?.name ?? d;
    return e.shortMessage || e.message;
  }
}

const api = await ApiPromise.create({ provider: new WsProvider(NETWORK.substrateWs, 2500, {}, 30_000), noInitWarn: true });
const bundle = JSON.parse(readFileSync(join(PATHS.root, 'contracts', 'ink', 'meter_registry', 'artifact', 'meter_registry.contract'), 'utf8'));
const abi = new Abi(bundle, api.registry.getChainProperties());
const contract = new ContractPromise(api, abi, dep.registry.address);
const stranger = '5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdC'; // our sr25519 account: not provider, not payer
const raw = new RawInkRegistry({ rpc: NETWORK.substrateHttp, accountId: dep.registry.accountId, origin: dep.readOrigin, selectors: dep.registry.selectors });
const inkOpts = { evm, expect: { chainId: NETWORK.chainId, settlement: dep.settlement }, registry: raw, fromBlock: dep.fromBlock };

async function inkError(origin, label, ...args) {
  const ink = new InkRegistry({ api, contract, readOrigin: origin });
  try {
    await ink.buildCall(origin, label, ...args);
    return 'accepted';
  } catch (e) {
    return /would fail: "?([A-Za-z]+)/.exec(e.message)?.[1] ?? e.message;
  }
}

try {
  // ---------------------------------------------------------- Solidity rules
  const rid = served.receipt.requestId;
  note('settle a request that is already served', 'NotPaid', await evmError(dep.provider, settlementIface.encodeFunctionData('settle', [rid, '0x' + '00'.repeat(32)])));
  note('refund a request that is already served', 'NotPaid', await evmError(dep.provider, settlementIface.encodeFunctionData('refund', [rid, 1])));
  note('settle a refunded request', 'NotPaid', await evmError(dep.provider, settlementIface.encodeFunctionData('settle', [refunded.receipt.requestId, '0x' + '00'.repeat(32)])));
  note('pay again with a spent nonce', 'RequestExists', await evmError(dep.buyer, settlementIface.encodeFunctionData('pay', [1, served.receipt.nonce, 25000])));
  note('pay above the buyer limit', 'PriceAboveMax', await evmError(dep.buyer, settlementIface.encodeFunctionData('pay', [1, '0x' + '12'.repeat(32), 1])));

  // ---------------------------------------------------------- ink! rules
  const buyerTwin = twinSs58(dep.buyer);
  const providerTwin = twinSs58(dep.provider);
  note('payer rates the same request twice', 'AlreadyRated', await inkError(buyerTwin, 'rate', dep.provider, 1, served.receipt.nonce, false));
  note('a stranger rates the request (id recomputed from the caller)', 'NoSuchAnchor', await inkError(stranger, 'rate', dep.provider, 1, served.receipt.nonce, false));
  note('payer rates a refunded request', 'NotServed', await inkError(buyerTwin, 'rate', dep.provider, 2, refunded.receipt.nonce, true));
  note('a stranger records into the provider namespace', 'NotRegistered', await inkError(stranger, 'record', 1, '0x' + 'ab'.repeat(32), 1, 1, '0x' + 'cd'.repeat(32)));
  note('provider anchors the same request twice', 'AlreadyAnchored', await inkError(providerTwin, 'record', 1, rid, 1, 25000, '0x' + 'cd'.repeat(32)));

  // ---------------------------------------------------------- verifier REJECTs
  const verdict = async (r, body) => (await verifyReceipt(r, { ...inkOpts, body })).verdict;
  note('genuine receipt + body', 'ACCEPT', await verdict(served.receipt, Buffer.from(served.body)));
  note('genuine receipt, forged body', 'REJECT', await verdict(served.receipt, Buffer.from('{"forged":true}')));
  note('amount changed in the receipt', 'REJECT', await verdict({ ...served.receipt, amount: '1' }, Buffer.from(served.body)));
  note('served receipt rewritten as refunded', 'REJECT', await verdict({ ...served.receipt, outcome: 'refunded' }));
} finally {
  await api.disconnect();
}
writeFileSync(join(PATHS.root, 'deployments', 'proof', 'negative-checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks: out }, null, 2) + '\n');
console.log(`${out.filter(c => c.ok).length}/${out.length} as expected`);
process.exit(out.every(c => c.ok) ? 0 : 1);
