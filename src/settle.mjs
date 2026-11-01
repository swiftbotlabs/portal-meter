// How the seller finalises a paid request on-chain. Two settlers with the same interface:
//   EvmSettler  - plain Solidity calls from the provider key (+ an optional registry write, e.g. MemoryRegistry);
//   XvmSettler  - ONE Ethereum transaction to the runtime pallets address carrying
//                 utility.batchAll([revive.call(MeterSettlement.settle|refund), contracts.call(MeterRegistry.record)]),
//                 so the EVM settlement and the WASM anchor succeed or fail together. Without a registry
//                 the second call is system.remarkWithEvent(receiptHash): same transaction shape, Substrate-side anchor.
import { settlementIface, sendTx } from './evm.mjs';
import { OUTCOME } from './registry.mjs';
import { buildReviveCall, sendBatchFromEvmKey, twinSs58 } from './xvm.mjs';

/** Serialises async jobs (one signer = one nonce sequence). */
export class Queue {
  #tail = Promise.resolve();
  run(fn) {
    const p = this.#tail.then(fn, fn);
    this.#tail = p.catch(() => {});
    return p;
  }
}

export class EvmSettler {
  constructor({ wallet, settlementAddress, registry = null }) {
    this.wallet = wallet;
    this.settlementAddress = settlementAddress;
    this.registry = registry; // MemoryRegistry or null
    this.queue = new Queue();
    this.mode = 'evm';
  }

  async #send(data) {
    return this.queue.run(() => sendTx(this.wallet, { to: this.settlementAddress, data }));
  }

  async settle({ requestId, responseHash, endpointId, amount, receiptHash }) {
    const r = await this.#send(settlementIface.encodeFunctionData('settle', [requestId, responseHash]));
    if (this.registry) this.registry.record(this.wallet.address, { endpointId, requestId, outcome: OUTCOME.SERVED, amount, receiptHash });
    return { tx: r.hash, block: r.blockNumber, mode: this.mode };
  }

  async refund({ requestId, reason, endpointId, amount, receiptHash }) {
    const r = await this.#send(settlementIface.encodeFunctionData('refund', [requestId, reason]));
    if (this.registry) this.registry.record(this.wallet.address, { endpointId, requestId, outcome: OUTCOME.REFUNDED, amount, receiptHash });
    return { tx: r.hash, block: r.blockNumber, mode: this.mode };
  }
}

export class XvmSettler {
  constructor({ api, wallet, settlementAddress, inkRegistry = null }) {
    this.api = api;
    this.wallet = wallet;
    this.settlementAddress = settlementAddress;
    this.ink = inkRegistry;
    this.queue = new Queue();
    this.mode = 'xvm';
  }

  async #batch(evmData, rec) {
    return this.queue.run(async () => {
      const origin = twinSs58(this.wallet.address);
      const revive = await buildReviveCall(this.api, this.wallet.address, this.settlementAddress, evmData);
      const anchor = this.ink
        ? (await this.ink.buildCall(origin, 'record', rec.endpointId, rec.requestId, rec.outcome, rec.amount, rec.receiptHash)).call
        : this.api.tx.system.remarkWithEvent(rec.receiptHash);
      const { receipt } = await sendBatchFromEvmKey(this.api, this.wallet, [revive, anchor]);
      return receipt;
    });
  }

  async settle({ requestId, responseHash, endpointId, amount, receiptHash }) {
    const r = await this.#batch(settlementIface.encodeFunctionData('settle', [requestId, responseHash]),
      { endpointId, requestId, outcome: OUTCOME.SERVED, amount, receiptHash });
    return { tx: r.hash, block: r.blockNumber, mode: this.mode };
  }

  async refund({ requestId, reason, endpointId, amount, receiptHash }) {
    const r = await this.#batch(settlementIface.encodeFunctionData('refund', [requestId, reason]),
      { endpointId, requestId, outcome: OUTCOME.REFUNDED, amount, receiptHash });
    return { tx: r.hash, block: r.blockNumber, mode: this.mode };
  }
}
