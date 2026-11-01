// WASM side: the ink! MeterRegistry on pallet-contracts, plus an in-memory twin with the same rules
// (used by the offline tests and the local demo, where no pallet-contracts node is available).
import { keccak256, getAddress, getBytes } from 'ethers';
import { requestIdFor as evmRequestIdFor } from './protocol.mjs';

export const OUTCOME = Object.freeze({ SERVED: 1, REFUNDED: 2 });
export const FEEDBACK = Object.freeze({ NONE: 0, CONFIRMED: 1, DISPUTED: 2 });
const MAX_URI_LEN = 96;

export class RegistryError extends Error {}

function lc(h) {
  return String(h).toLowerCase();
}

/** Same rules as contracts/ink/meter_registry/lib.rs (kept in sync by test/registry.test.mjs). */
export class MemoryRegistry {
  constructor({ settlement, chainId }) {
    this.settlement = getAddress(settlement);
    this.chainId = chainId;
    this.endpoints = new Map();
    this.anchors = new Map();
    this.block = 1;
  }

  kind() {
    return 'memory';
  }

  #ek(p, id) {
    return `${lc(p)}:${id}`;
  }

  registerEndpoint(caller, endpointId, uri) {
    const u = Buffer.from(uri, 'utf8');
    if (u.length === 0) throw new RegistryError('UriEmpty');
    if (u.length > MAX_URI_LEN) throw new RegistryError('UriTooLong');
    const k = this.#ek(caller, endpointId);
    if (this.endpoints.has(k)) throw new RegistryError('AlreadyRegistered');
    this.endpoints.set(k, { uri, served: 0, refunded: 0, confirmed: 0, disputed: 0, volume: 0n, registeredAt: this.block, lastActivity: this.block });
  }

  record(caller, { endpointId, requestId, outcome, amount, receiptHash }) {
    if (/^0x0{64}$/.test(requestId)) throw new RegistryError('ZeroRequestId');
    if (outcome !== OUTCOME.SERVED && outcome !== OUTCOME.REFUNDED) throw new RegistryError('BadOutcome');
    const rec = this.endpoints.get(this.#ek(caller, endpointId));
    if (!rec) throw new RegistryError('NotRegistered');
    const ak = `${lc(caller)}:${lc(requestId)}`;
    if (this.anchors.has(ak)) throw new RegistryError('AlreadyAnchored');
    this.block += 1;
    if (outcome === OUTCOME.SERVED) {
      rec.served += 1;
      rec.volume += BigInt(amount);
    } else {
      rec.refunded += 1;
    }
    rec.lastActivity = this.block;
    this.anchors.set(ak, { endpointId, outcome, amount: BigInt(amount), receiptHash: lc(receiptHash), block: this.block, feedback: FEEDBACK.NONE });
  }

  rate(caller, { provider, endpointId, nonce, ok }) {
    const rid = this.requestIdFor(caller, endpointId, nonce);
    const a = this.anchors.get(`${lc(provider)}:${lc(rid)}`);
    if (!a) throw new RegistryError('NoSuchAnchor');
    if (a.endpointId !== endpointId || a.outcome !== OUTCOME.SERVED) throw new RegistryError('NotServed');
    if (a.feedback !== FEEDBACK.NONE) throw new RegistryError('AlreadyRated');
    const rec = this.endpoints.get(this.#ek(provider, endpointId));
    a.feedback = ok ? FEEDBACK.CONFIRMED : FEEDBACK.DISPUTED;
    if (ok) rec.confirmed += 1;
    else rec.disputed += 1;
  }

  requestIdFor(payer, endpointId, nonce) {
    return evmRequestIdFor(this.chainId, this.settlement, payer, endpointId, nonce);
  }

  async anchor(provider, requestId) {
    const a = this.anchors.get(`${lc(provider)}:${lc(requestId)}`);
    return a ? { ...a, amount: a.amount.toString() } : null;
  }

  async endpoint(provider, endpointId) {
    const e = this.endpoints.get(this.#ek(provider, endpointId));
    return e ? { ...e, volume: e.volume.toString() } : null;
  }

  async reputation(provider, endpointId) {
    return reputationOf(await this.endpoint(provider, endpointId));
  }
}

export function reputationOf(e) {
  if (!e) return { served: 0, refunded: 0, confirmed: 0, disputed: 0, scoreBps: 0 };
  const total = e.served + e.refunded;
  const good = Math.max(0, e.served - e.disputed);
  return {
    served: e.served,
    refunded: e.refunded,
    confirmed: e.confirmed,
    disputed: e.disputed,
    scoreBps: total === 0 ? 0 : Math.min(10_000, Math.floor((good * 10_000) / total)),
  };
}

// ------------------------------------------------------------------ the deployed ink! contract
const BIG_WEIGHT = { refTime: 50_000_000_000n, proofSize: 2_000_000n };

function unwrapOutput(out) {
  // ink! messages return Result<T, LangError>; polkadot.js gives Option<Codec>
  if (!out) return null;
  const j = out.toJSON ? out.toJSON() : out;
  if (j && typeof j === 'object' && 'ok' in j) return j.ok;
  if (j && typeof j === 'object' && 'err' in j) throw new RegistryError(`ink! error ${JSON.stringify(j.err)}`);
  return j;
}

/** Thin client over @polkadot/api-contract. `contract` is a ContractPromise for meter_registry. */
export class InkRegistry {
  constructor({ api, contract, readOrigin }) {
    this.api = api;
    this.contract = contract;
    this.readOrigin = readOrigin; // any funded or unfunded SS58 address; reads are dry-runs
    this.address = contract.address.toString();
  }

  kind() {
    return 'ink';
  }

  async #query(label, ...args) {
    const q = this.contract.query[label];
    if (!q) throw new RegistryError(`registry has no message ${label}`);
    const gasLimit = this.api.registry.createType('WeightV2', BIG_WEIGHT);
    const res = await q(this.readOrigin, { gasLimit, storageDepositLimit: null }, ...args);
    if (res.result.isErr) throw new RegistryError(`dry-run of ${label} failed: ${res.result.asErr.toString()}`);
    return { value: unwrapOutput(res.output), gasRequired: res.gasRequired, storageDeposit: res.storageDeposit };
  }

  async anchor(provider, requestId) {
    const { value } = await this.#query('anchor', provider, requestId);
    if (!value) return null;
    return {
      endpointId: Number(value.endpointId),
      outcome: Number(value.outcome),
      amount: BigInt(value.amount).toString(),
      receiptHash: lc(value.receiptHash),
      block: Number(value.block),
      feedback: Number(value.feedback),
    };
  }

  async endpoint(provider, endpointId) {
    const { value } = await this.#query('endpoint', provider, endpointId);
    if (!value) return null;
    return {
      uri: Buffer.from(getBytes(value.uri)).toString('utf8'),
      served: Number(value.served),
      refunded: Number(value.refunded),
      confirmed: Number(value.confirmed),
      disputed: Number(value.disputed),
      volume: BigInt(value.volume).toString(),
      registeredAt: Number(value.registeredAt),
      lastActivity: Number(value.lastActivity),
    };
  }

  async reputation(provider, endpointId) {
    const { value } = await this.#query('reputation', provider, endpointId);
    return {
      served: Number(value.served),
      refunded: Number(value.refunded),
      confirmed: Number(value.confirmed),
      disputed: Number(value.disputed),
      scoreBps: Number(value.scoreBps),
    };
  }

  async info() {
    const { value } = await this.#query('info');
    return { settlement: getAddress(value[0]), chainId: Number(value[1]), endpoints: Number(value[2]), anchors: Number(value[3]) };
  }

  async requestIdFor(payer, endpointId, nonce) {
    const { value } = await this.#query('requestIdFor', payer, endpointId, nonce);
    return lc(value);
  }

  /**
   * Build a contracts.call extrinsic for a state-changing message, sized by a dry-run from `origin`
   * (the SS58 account that will dispatch it, e.g. the twin of an EVM key).
   */
  async buildCall(origin, label, ...args) {
    const q = this.contract.query[label];
    const gasLimit = this.api.registry.createType('WeightV2', BIG_WEIGHT);
    const dry = await q(origin, { gasLimit, storageDepositLimit: null }, ...args);
    if (dry.result.isErr) throw new RegistryError(`dry-run of ${label} failed: ${dry.result.asErr.toString()}`);
    unwrapOutput(dry.output); // throws on LangError
    const inner = dry.output?.toJSON?.();
    if (inner && typeof inner === 'object' && inner.ok && typeof inner.ok === 'object' && 'err' in inner.ok) {
      throw new RegistryError(`${label} would fail: ${JSON.stringify(inner.ok.err)}`);
    }
    const w = dry.gasRequired;
    const weight = this.api.registry.createType('WeightV2', {
      refTime: (w.refTime.toBigInt() * 3n) / 2n,
      proofSize: (w.proofSize.toBigInt() * 3n) / 2n,
    });
    const dep = dry.storageDeposit.isCharge ? dry.storageDeposit.asCharge.toBigInt() : 0n;
    const storageDepositLimit = dep === 0n ? null : (dep * 12n) / 10n + 1n;
    const tx = this.contract.tx[label]({ gasLimit: weight, storageDepositLimit }, ...args);
    return { tx, call: tx.method, deposit: dep, weight };
  }
}

/** keccak256 of a UTF-8 string, 0x-prefixed (for refund reason hashes). */
export function hashText(s) {
  return keccak256(Buffer.from(s, 'utf8'));
}
