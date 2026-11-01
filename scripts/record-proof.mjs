#!/usr/bin/env node
// Saves what the public RPC may prune later: receipts of every EVM transaction in deployments/testnet.json and all
// MeterSettlement events, into deployments/proof/. Fills missing block numbers. Read-only on the chain, no key.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NETWORK, PATHS } from '../src/config.mjs';
import { makeProvider, settlementIface } from '../src/evm.mjs';

const file = join(PATHS.root, 'deployments', 'testnet.json');
const dep = JSON.parse(readFileSync(file, 'utf8'));
const evm = makeProvider(NETWORK.evmRpc, NETWORK.chainId);
const dir = join(PATHS.root, 'deployments', 'proof');
mkdirSync(dir, { recursive: true });

const receipts = [];
for (const t of dep.transactions) {
  if (!t.layer.startsWith('evm')) continue;
  const r = await evm.getTransactionReceipt(t.hash);
  if (!r) {
    console.log(`no receipt (pruned?): ${t.hash}`);
    continue;
  }
  t.block = r.blockNumber;
  const costWei = r.gasUsed * r.gasPrice;
  t.costTpot = Number(costWei / 10n ** 12n) / 1e6;
  receipts.push({
    label: t.label, hash: r.hash, block: r.blockNumber, blockHash: r.blockHash, status: r.status, from: r.from, to: r.to,
    contractAddress: r.contractAddress, gasUsed: r.gasUsed.toString(), gasPrice: r.gasPrice.toString(), costTpot: t.costTpot,
    logs: r.logs.map(l => ({ address: l.address, topics: l.topics, data: l.data, index: l.index })),
  });
}
const logs = await evm.getLogs({ address: dep.settlement, fromBlock: dep.fromBlock, toBlock: 'latest' });
const events = logs.map(l => {
  const p = settlementIface.parseLog(l);
  return { event: p?.name, block: l.blockNumber, tx: l.transactionHash, args: p ? Object.fromEntries(p.fragment.inputs.map((inp, i) => [inp.name, p.args[i].toString()])) : null };
});
writeFileSync(join(dir, 'receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2) + '\n');
writeFileSync(file, JSON.stringify(dep, null, 2) + '\n');
console.log(`${receipts.length} receipts, ${events.length} events saved to deployments/proof/`);
for (const r of receipts) console.log(`${String(r.costTpot).padStart(12)} tPOT  block ${r.block}  ${r.label}`);
process.exit(0);
