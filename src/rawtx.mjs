// A transaction sender over plain JSON-RPC, for runtimes where an ethers provider is too much (the Worker).
// Same rules as evm.mjs sendTx: legacy type 0, gas price + 5 %, gas limit = estimate + 10 %.

export function jsonRpc(url, fetchImpl = globalThis.fetch.bind(globalThis)) {
  let id = 0;
  return async (method, params = []) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
}

/**
 * @param rpc      jsonRpc() function on the EVM endpoint
 * @param wallet   ethers Wallet (no provider needed)
 * @param tx       {to, data}
 * @returns receipt as returned by the node
 */
export async function sendRaw(rpc, wallet, chainId, tx, { sleep = ms => new Promise(r => setTimeout(r, ms)), polls = 20, pollMs = 3000 } = {}) {
  const from = wallet.address;
  const [gasPrice, gas, nonce] = await Promise.all([
    rpc('eth_gasPrice').then(BigInt),
    rpc('eth_estimateGas', [{ from, to: tx.to, data: tx.data, value: '0x0' }]).then(BigInt),
    rpc('eth_getTransactionCount', [from, 'pending']).then(BigInt),
  ]);
  const raw = await wallet.signTransaction({
    type: 0, chainId, nonce: Number(nonce), to: tx.to, data: tx.data, value: 0n,
    gasPrice: (gasPrice * 105n) / 100n, gasLimit: (gas * 110n) / 100n,
  });
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  for (let i = 0; i < polls; i++) {
    await sleep(pollMs);
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) {
      if (BigInt(r.status) !== 1n) throw new Error(`transaction ${hash} failed`);
      return { hash, block: Number(BigInt(r.blockNumber)), receipt: r };
    }
  }
  throw new Error(`no receipt for ${hash}`);
}
