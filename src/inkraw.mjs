// Dependency-free read client for the ink! MeterRegistry: SCALE-encodes a ContractsApi_call dry-run, sends it
// with state_call over plain JSON-RPC (works from a browser: the Portaldot node answers with CORS *), and
// decodes the result. Used by the demo page and the verifier in the browser.

const hexToBytes = h => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const bytesToHex = b => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function compact(n) {
  n = BigInt(n);
  if (n < 64n) return Uint8Array.of(Number(n << 2n));
  if (n < 16384n) {
    const v = Number((n << 2n) | 1n);
    return Uint8Array.of(v & 0xff, v >> 8);
  }
  if (n < 1073741824n) {
    const v = (n << 2n) | 2n;
    return Uint8Array.of(Number(v & 0xffn), Number((v >> 8n) & 0xffn), Number((v >> 16n) & 0xffn), Number((v >> 24n) & 0xffn));
  }
  const bytes = [];
  let x = n;
  while (x > 0n) {
    bytes.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return Uint8Array.of(((bytes.length - 4) << 2) | 3, ...bytes);
}

const le = (n, size) => {
  const out = new Uint8Array(size);
  let x = BigInt(n);
  for (let i = 0; i < size; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

export class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.o = 0;
  }
  take(n) {
    if (this.o + n > this.b.length) throw new Error('SCALE: out of data');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  uint(size) {
    const s = this.take(size);
    let x = 0n;
    for (let i = size - 1; i >= 0; i--) x = (x << 8n) | BigInt(s[i]);
    return x;
  }
  compact() {
    const b0 = this.b[this.o];
    const mode = b0 & 3;
    if (mode === 0) return BigInt(this.u8() >> 2);
    if (mode === 1) return this.uint(2) >> 2n;
    if (mode === 2) return this.uint(4) >> 2n;
    this.u8();
    return this.uint((b0 >> 2) + 4);
  }
  bytes() { return this.take(Number(this.compact())); }
  weight() { return { refTime: this.compact(), proofSize: this.compact() }; }
}

/** Encode the ContractsApi_call runtime-API arguments. */
export function encodeContractsCall({ originHex, destHex, input }) {
  return concat(hexToBytes(originHex), hexToBytes(destHex), le(0, 16), Uint8Array.of(0), Uint8Array.of(0), compact(input.length), input);
}

/** Decode a ContractResult and return the contract's raw return bytes (throws on dispatch error / revert). */
export function decodeContractsResult(bytes) {
  const r = new Reader(bytes);
  r.weight(); // gas consumed
  const gasRequired = r.weight();
  const depKind = r.u8();
  const deposit = r.uint(16);
  r.bytes(); // debug message
  const isErr = r.u8();
  if (isErr !== 0) throw new Error('contract call failed (DispatchError)');
  const flags = Number(r.uint(4));
  const data = r.bytes();
  if (flags & 1) throw new Error('contract reverted');
  return { data, gasRequired, storageDeposit: { charge: depKind === 1, amount: deposit } };
}

/** ink! wraps every message result in Result<T, LangError>. */
function inkOk(data) {
  const r = new Reader(data);
  if (r.u8() !== 0) throw new Error('ink! LangError');
  return r;
}

export const decoders = {
  anchor(r) {
    if (r.u8() === 0) return null;
    return {
      endpointId: Number(r.uint(4)),
      outcome: r.u8(),
      amount: r.uint(16).toString(),
      receiptHash: bytesToHex(r.take(32)),
      block: Number(r.uint(4)),
      feedback: r.u8(),
    };
  },
  endpoint(r) {
    if (r.u8() === 0) return null;
    const uri = new TextDecoder().decode(r.bytes());
    return {
      uri,
      served: Number(r.uint(8)),
      refunded: Number(r.uint(8)),
      confirmed: Number(r.uint(8)),
      disputed: Number(r.uint(8)),
      volume: r.uint(16).toString(),
      registeredAt: Number(r.uint(4)),
      lastActivity: Number(r.uint(4)),
    };
  },
  reputation(r) {
    return { served: Number(r.uint(8)), refunded: Number(r.uint(8)), confirmed: Number(r.uint(8)), disputed: Number(r.uint(8)), scoreBps: Number(r.uint(2)) };
  },
  info(r) {
    return { settlement: bytesToHex(r.take(20)), chainId: Number(r.uint(8)), endpoints: Number(r.uint(4)), anchors: Number(r.uint(8)) };
  },
};

export class RawInkRegistry {
  /**
   * @param o.rpc        Substrate JSON-RPC over HTTP(S)
   * @param o.accountId  registry contract account id (0x + 64 hex)
   * @param o.origin     any account id used as the dry-run caller
   * @param o.selectors  {anchor, endpoint, reputation, info}: 0x + 8 hex, from the contract metadata
   */
  constructor({ rpc, accountId, origin, selectors, fetchImpl }) {
    Object.assign(this, { rpc, accountId, origin, selectors });
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  kind() { return 'ink'; }

  async #call(label, args) {
    const input = concat(hexToBytes(this.selectors[label]), ...args);
    const params = ['ContractsApi_call', bytesToHex(encodeContractsCall({ originHex: this.origin, destHex: this.accountId, input }))];
    const res = await this.fetch(this.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state_call', params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    const { data } = decodeContractsResult(hexToBytes(j.result));
    return decoders[label](inkOk(data));
  }

  anchor(providerH160, requestId) { return this.#call('anchor', [hexToBytes(providerH160), hexToBytes(requestId)]); }
  endpoint(providerH160, endpointId) { return this.#call('endpoint', [hexToBytes(providerH160), le(endpointId, 4)]); }
  reputation(providerH160, endpointId) { return this.#call('reputation', [hexToBytes(providerH160), le(endpointId, 4)]); }
  info() { return this.#call('info', []); }
}

export const _internal = { compact, le, hexToBytes, bytesToHex, concat };
