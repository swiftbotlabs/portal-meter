// Free receipt verifier: ACCEPT or REJECT a Portal Meter receipt, listing every check.
// Reads only public chain state (EVM settlement + logs, ink! registry); needs no key.
import { getAddress, verifyMessage, keccak256 } from 'ethers';
import { validateReceipt, receiptMessage, receiptCoreHash, requestIdFor, chainIdOf } from './protocol.mjs';
import { settlement as settlementContract, readPayment, readEndpoint, findLogs, STATUS, STATUS_NAME } from './evm.mjs';
import { OUTCOME } from './registry.mjs';

/**
 * @param receipt         parsed receipt object
 * @param o.evm           ethers provider on the Portaldot EVM RPC
 * @param o.expect        {chainId, settlement?}
 * @param o.body          optional Buffer: the response body that came with the receipt
 * @param o.registry      optional registry client; when given, the WASM anchor must exist and match
 * @param o.fromBlock     optional start block for the log search
 */
export async function verifyReceipt(receipt, o) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const done = () => ({ verdict: checks.every(c => c.ok !== false) ? 'ACCEPT' : 'REJECT', checks });

  try {
    validateReceipt(receipt);
    add('receipt format', true, receipt.v);
  } catch (e) {
    add('receipt format', false, e.message);
    return done();
  }
  const chainId = chainIdOf(receipt.network);
  add('network', chainId === o.expect.chainId, `${receipt.network} (expected eip155:${o.expect.chainId})`);
  if (o.expect.settlement) {
    add('settlement contract', getAddress(receipt.settlement) === getAddress(o.expect.settlement), receipt.settlement);
  }
  let signer = null;
  try {
    signer = getAddress(verifyMessage(receiptMessage(receipt), receipt.signature));
  } catch { /* reported below */ }
  add('provider signature', signer === getAddress(receipt.provider), signer ? `signed by ${signer}` : 'unreadable signature');

  const core = receiptCoreHash(receipt);
  add('receipt hash', core === receipt.receiptHash.toLowerCase(), core);

  if (receipt.nonce) {
    const rid = requestIdFor(chainId, receipt.settlement, receipt.payer, receipt.endpointId, receipt.nonce).toLowerCase();
    add('request id bound to payer', rid === receipt.requestId.toLowerCase(), 'keccak256(chainId, settlement, payer, endpointId, nonce)');
  } else {
    add('request id bound to payer', null, 'no nonce in receipt');
  }

  if (o.body !== undefined && o.body !== null && receipt.outcome === 'served') {
    const h = keccak256(o.body);
    add('response body hash', h === receipt.responseHash.toLowerCase(), h);
  } else {
    add('response body hash', null, receipt.outcome === 'served' ? 'no body given' : 'refund receipt');
  }

  // ------------------------------------------------------------ EVM state
  const s = settlementContract(receipt.settlement, o.evm);
  let ep;
  try {
    ep = await readEndpoint(s, receipt.endpointId);
    add('endpoint provider on-chain', getAddress(ep.provider) === getAddress(receipt.provider), `endpoint ${receipt.endpointId} provider ${ep.provider}`);
    add('endpoint token', getAddress(ep.token) === getAddress(receipt.token), ep.token);
  } catch (e) {
    add('endpoint provider on-chain', false, e.shortMessage || e.message);
    return done();
  }
  const pay = await readPayment(s, receipt.requestId);
  const wantStatus = receipt.outcome === 'served' ? STATUS.SERVED : STATUS.REFUNDED;
  add('payment status', pay.status === wantStatus, `on-chain: ${STATUS_NAME[pay.status]}`);
  add('payment payer', pay.payer !== '0x0000000000000000000000000000000000000000' && getAddress(pay.payer) === getAddress(receipt.payer), pay.payer);
  add('payment endpoint', pay.endpointId === receipt.endpointId, String(pay.endpointId));

  const logs = await findLogs(o.evm, receipt.settlement, receipt.requestId, o.fromBlock ?? 0);
  const paid = logs.find(l => l.name === 'Paid');
  add('Paid event', !!paid && BigInt(paid.args.amount) === BigInt(receipt.amount) && getAddress(paid.args.payer) === getAddress(receipt.payer),
    paid ? `tx ${paid.tx}, amount ${paid.args.amount}` : 'not found');
  if (receipt.outcome === 'served') {
    const sv = logs.find(l => l.name === 'Served');
    add('Served event', !!sv && sv.args.responseHash.toLowerCase() === receipt.responseHash.toLowerCase()
      && BigInt(sv.args.amount) === BigInt(receipt.amount) && getAddress(sv.args.payee) === getAddress(ep.payee),
      sv ? `tx ${sv.tx}, payee ${sv.args.payee}` : 'not found');
    add('settlement tx matches receipt', !!sv && sv.tx.toLowerCase() === receipt.tx.toLowerCase(), sv ? sv.tx : '');
  } else {
    const rf = logs.find(l => l.name === 'Refunded');
    add('Refunded event', !!rf && BigInt(rf.args.amount) === BigInt(receipt.amount) && getAddress(rf.args.payer) === getAddress(receipt.payer),
      rf ? `tx ${rf.tx}, reason ${rf.args.reason}, by ${rf.args.byProvider ? 'provider' : 'payer'}` : 'not found');
    add('refund tx matches receipt', !!rf && rf.tx.toLowerCase() === receipt.tx.toLowerCase(), rf ? rf.tx : '');
  }

  // ------------------------------------------------------------ WASM anchor
  if (o.registry) {
    try {
      const a = await o.registry.anchor(receipt.provider, receipt.requestId);
      const want = receipt.outcome === 'served' ? OUTCOME.SERVED : OUTCOME.REFUNDED;
      add('ink! registry anchor', !!a && a.outcome === want && a.receiptHash === receipt.receiptHash.toLowerCase()
        && BigInt(a.amount) === BigInt(receipt.amount) && a.endpointId === receipt.endpointId,
        a ? `${o.registry.kind()} registry: outcome ${a.outcome}, block ${a.block}, receipt hash ${a.receiptHash.slice(0, 18)}...` : 'no anchor for this provider and request');
    } catch (e) {
      add('ink! registry anchor', false, e.message);
    }
  } else {
    add('ink! registry anchor', null, 'no registry configured');
  }
  return done();
}

export function formatReport({ verdict, checks }) {
  const mark = c => (c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'SKIP');
  return [`${verdict}`, ...checks.map(c => `  ${mark(c).padEnd(4)} ${c.name}${c.detail ? ': ' + c.detail : ''}`)].join('\n');
}
