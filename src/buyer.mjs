// Buyer client: request -> 402 quote -> checks (quote, on-chain endpoint, provider reputation in the ink!
// registry) -> approve + pay on Portaldot's EVM -> retry with a signed proof -> body + provider receipt.
import {
  HEADER_PAYMENT, HEADER_REQUIRED, HEADER_RESPONSE, b64json, parseB64json, validateQuote, chainIdOf, requestHash,
  requestIdFor, proofMessage, VERSION, formatUnits,
} from './protocol.mjs';
import { settlement as settlementContract, erc20, readEndpoint, settlementIface, sendTx } from './evm.mjs';
import { getAddress } from 'ethers';

export class BuyError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param url               full URL of the paid resource
 * @param o.wallet          ethers Wallet (buyer key) connected to the Portaldot EVM RPC
 * @param o.expect          {chainId, settlement, token?} the buyer only pays this settlement contract
 * @param o.maxPrice        bigint, base units: never pay more per request
 * @param o.registry        optional registry client (InkRegistry | MemoryRegistry) for the reputation check
 * @param o.minScoreBps     refuse providers with a history and a score below this
 */
export async function buy(url, o) {
  const fetchImpl = o.fetch || fetch;
  const log = o.log || (() => {});
  const u = new URL(url);
  const first = await fetchImpl(u, { headers: { accept: 'application/json' } });
  if (first.status !== 402) {
    return { status: first.status, body: Buffer.from(await first.arrayBuffer()), receipt: null, paid: false };
  }
  const hdr = first.headers.get(HEADER_REQUIRED);
  if (!hdr) throw new BuyError('402 without a PAYMENT-REQUIRED header');
  const q = validateQuote(parseB64json(hdr));

  // ------------------------------------------------------------ quote checks (before any money moves)
  if (chainIdOf(q.network) !== o.expect.chainId) throw new BuyError(`quote is for ${q.network}, expected eip155:${o.expect.chainId}`);
  if (getAddress(q.settlement) !== getAddress(o.expect.settlement)) throw new BuyError('quote names an unexpected settlement contract');
  if (o.expect.token && getAddress(q.token) !== getAddress(o.expect.token)) throw new BuyError('quote names an unexpected token');
  if (BigInt(q.price) > o.maxPrice) throw new BuyError(`price ${q.price} above max ${o.maxPrice}`);
  if (q.requestHash !== requestHash('GET', u.pathname, u.searchParams)) throw new BuyError('quote is bound to a different request');
  if (q.expiresAt < Math.floor(Date.now() / 1000) + 30) throw new BuyError('quote expires too soon');

  const wallet = o.wallet;
  const s = settlementContract(q.settlement, wallet);
  const ep = await readEndpoint(s, q.endpointId);
  if (ep.provider === '0x0000000000000000000000000000000000000000') throw new BuyError('endpoint is not registered on-chain');
  if (getAddress(ep.provider) !== getAddress(q.provider)) throw new BuyError('quote provider differs from the on-chain endpoint provider');
  if (getAddress(ep.token) !== getAddress(q.token)) throw new BuyError('quote token differs from the on-chain endpoint token');
  if (!ep.active) throw new BuyError('endpoint is paused');
  if (BigInt(ep.price) > o.maxPrice) throw new BuyError('on-chain price above max');
  log(`quote: endpoint ${q.endpointId}, ${formatUnits(ep.price, q.decimals)} ${q.tokenSymbol}, provider ${ep.provider}`);

  let reputation = null;
  if (o.registry) {
    reputation = await o.registry.reputation(ep.provider, q.endpointId);
    log(`provider record (ink! registry): ${reputation.served} served, ${reputation.refunded} refunded, ${reputation.disputed} disputed, score ${(reputation.scoreBps / 100).toFixed(2)} %`);
    const history = reputation.served + reputation.refunded;
    if (o.minScoreBps && history > 0 && reputation.scoreBps < o.minScoreBps) throw new BuyError('provider score below the minimum');
  }

  // ------------------------------------------------------------ pay
  const token = erc20(ep.token, wallet);
  const allowance = BigInt(await token.allowance(wallet.address, q.settlement));
  const price = BigInt(ep.price);
  let approveTx = null;
  let approveBlock = null;
  if (allowance < price) {
    const amount = o.approveAmount && o.approveAmount > price ? o.approveAmount : price;
    const r = await sendTx(wallet, { to: ep.token, data: token.interface.encodeFunctionData('approve', [q.settlement, amount]) });
    approveTx = r.hash;
    approveBlock = r.blockNumber;
    log(`approved ${formatUnits(amount, q.decimals)} ${q.tokenSymbol}: ${r.hash}`);
  }
  const payReceipt = await sendTx(wallet, { to: q.settlement, data: settlementIface.encodeFunctionData('pay', [q.endpointId, q.nonce, price]) });
  const expectedRid = requestIdFor(o.expect.chainId, q.settlement, wallet.address, q.endpointId, q.nonce).toLowerCase();
  const paidLog = payReceipt.logs.map(l => { try { return settlementIface.parseLog(l); } catch { return null; } }).find(l => l && l.name === 'Paid');
  if (!paidLog || paidLog.args.requestId.toLowerCase() !== expectedRid) throw new BuyError('Paid event missing or request id mismatch');
  log(`paid: ${payReceipt.hash} (request ${expectedRid})`);

  // ------------------------------------------------------------ retry with proof
  const proof = {
    v: VERSION,
    requestId: expectedRid,
    nonce: q.nonce,
    payer: wallet.address,
    payTx: payReceipt.hash,
    signature: await wallet.signMessage(proofMessage(expectedRid, q.requestHash)),
  };
  let res;
  for (let attempt = 0; attempt < 10; attempt++) {
    res = await fetchImpl(u, { headers: { accept: 'application/json', [HEADER_PAYMENT]: b64json(proof) } });
    if (res.status !== 402) break;
    await sleep(3000);
  }
  const body = Buffer.from(await res.arrayBuffer());
  const rh = res.headers.get(HEADER_RESPONSE);
  const receipt = rh ? parseB64json(rh, 16_384) : null;
  return { status: res.status, body, receipt, paid: true, payTx: payReceipt.hash, payBlock: payReceipt.blockNumber, approveTx, approveBlock, requestId: expectedRid, quote: q, reputation };
}
