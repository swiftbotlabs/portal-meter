// EVM side (pallet-revive): MeterSettlement + ERC-20 (incl. the pallet-assets precompile) helpers.
import { Contract, Interface, JsonRpcProvider, FetchRequest } from 'ethers';

export const SETTLEMENT_ABI = [
  'function registerEndpoint(address payee, address token, uint96 price, uint32 refundDelay) returns (uint32)',
  'function updateEndpoint(uint32 endpointId, address payee, uint96 price, uint32 refundDelay, bool active)',
  'function pay(uint32 endpointId, bytes32 nonce, uint96 maxPrice) returns (bytes32)',
  'function settle(bytes32 requestId, bytes32 responseHash)',
  'function refund(bytes32 requestId, uint8 reason)',
  'function requestIdFor(address payer, uint32 endpointId, bytes32 nonce) view returns (bytes32)',
  'function endpoint(uint32 endpointId) view returns (address provider, address payee, address token, uint96 price, uint32 refundDelay, bool active)',
  'function payment(bytes32 requestId) view returns (address payer, uint32 endpointId, uint8 status, uint40 paidAt, uint96 amount)',
  'function endpointCount() view returns (uint32)',
  'event EndpointRegistered(uint32 indexed endpointId, address indexed provider, address payee, address token, uint96 price, uint32 refundDelay)',
  'event EndpointUpdated(uint32 indexed endpointId, address payee, uint96 price, uint32 refundDelay, bool active)',
  'event Paid(bytes32 indexed requestId, uint32 indexed endpointId, address indexed payer, uint96 amount, bytes32 nonce)',
  'event Served(bytes32 indexed requestId, uint32 indexed endpointId, address payee, uint96 amount, bytes32 responseHash)',
  'event Refunded(bytes32 indexed requestId, uint32 indexed endpointId, address payer, uint96 amount, uint8 reason, bool byProvider)',
  'error ZeroAddress()', 'error ZeroPrice()', 'error BadRefundDelay()', 'error NotAToken()', 'error UnknownEndpoint()',
  'error NotProvider()', 'error EndpointInactive()', 'error PriceAboveMax()', 'error RequestExists()', 'error NotPaid()',
  'error RefundNotYetAllowed()', 'error TokenCallFailed()', 'error Reentrancy()', 'error NotAllowed()',
];

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
];

export const STATUS = Object.freeze({ NONE: 0, PAID: 1, SERVED: 2, REFUNDED: 3 });
export const STATUS_NAME = ['none', 'paid', 'served', 'refunded'];
export const settlementIface = new Interface(SETTLEMENT_ABI);

export function makeProvider(url, chainId) {
  const req = new FetchRequest(url);
  req.timeout = 30_000;
  return new JsonRpcProvider(req, chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 2000 });
}

export function settlement(address, runner) {
  return new Contract(address, SETTLEMENT_ABI, runner);
}

export function erc20(address, runner) {
  return new Contract(address, ERC20_ABI, runner);
}

export async function readPayment(c, requestId) {
  const [payer, endpointId, status, paidAt, amount] = await c.payment(requestId);
  return { payer, endpointId: Number(endpointId), status: Number(status), paidAt: Number(paidAt), amount: amount.toString() };
}

export async function readEndpoint(c, endpointId) {
  const [provider, payee, token, price, refundDelay, active] = await c.endpoint(endpointId);
  return { provider, payee, token, price: price.toString(), refundDelay: Number(refundDelay), active };
}

/** Find the Served / Refunded / Paid log for a request id (eth_getLogs keeps working after receipts are pruned). */
export async function findLogs(provider, settlementAddress, requestId, fromBlock = 0) {
  const logs = await provider.getLogs({ address: settlementAddress, topics: [null, requestId], fromBlock, toBlock: 'latest' });
  const out = [];
  for (const l of logs) {
    let parsed;
    try {
      parsed = settlementIface.parseLog(l);
    } catch {
      continue;
    }
    if (!parsed) continue;
    out.push({ name: parsed.name, args: parsed.args, tx: l.transactionHash, block: l.blockNumber });
  }
  return out;
}

/**
 * Send a transaction the way pallet-revive's eth-rpc expects: legacy type 0, explicit gas price a little above
 * the current one, gas limit = estimate + 10 % (the estimate includes the storage deposit expressed as gas).
 */
export async function sendTx(wallet, tx, { gasPriceBumpPct = 5n, gasLimitBumpPct = 10n } = {}) {
  const provider = wallet.provider;
  const [gasPrice, estimate] = await Promise.all([
    provider.send('eth_gasPrice', []).then(BigInt),
    provider.estimateGas({ ...tx, from: wallet.address }),
  ]);
  const sent = await wallet.sendTransaction({
    ...tx,
    type: 0,
    gasPrice: (gasPrice * (100n + gasPriceBumpPct)) / 100n,
    gasLimit: (estimate * (100n + gasLimitBumpPct)) / 100n,
  });
  const receipt = await waitReceipt(provider, sent.hash);
  if (receipt.status !== 1) throw new Error(`transaction ${sent.hash} failed`);
  return receipt;
}

/** Plain receipt polling: no block subscription to get stuck on, and a hard deadline. */
export async function waitReceipt(provider, hash, { timeoutMs = 180_000 } = {}) {
  const pollMs = Math.min(provider.pollingInterval ?? 2000, 2000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await provider.getTransactionReceipt(hash);
    if (r) return r;
    if (Date.now() > deadline) throw new Error(`no receipt for ${hash} after ${timeoutMs / 1000} s`);
    await new Promise(res => setTimeout(res, pollMs));
  }
}

export function describeRevert(err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x')) {
    try {
      const e = settlementIface.parseError(data);
      if (e) return e.name;
    } catch { /* not ours */ }
  }
  return err?.shortMessage || err?.info?.error?.message || err?.message || String(err);
}
