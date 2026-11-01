// The public Portal Meter seller: a paid Portaldot data API that holds no database and runs no server.
//
//   GET /v1/asset/{id}        cross-VM view of a native asset        0.01 pUSD
//   GET /v1/account/{addr}    cross-VM view of an account            0.01 pUSD
//   GET /v1/session/{id}      where a session stands (free)
//   GET /v1/session/{id}/log  the public request log of a session (free): anyone can replay its hash chain
//   GET /v1/batches           settled batches with their transactions (free)
//   GET /.well-known/portal-meter, /health
//
// One Durable Object is the single writer for all sessions and the only place that talks to the chain, which keeps
// the public Portaldot RPC endpoints below the 5 requests per second the Portaldot team asks for.
// The provider key is a testnet key, held as a Worker secret. It signs receipts and settlement transactions.
import { DurableObject } from 'cloudflare:workers';
import { Wallet } from 'ethers';
import { createMeter } from '../../src/meter.mjs';
import { pendingSessions, settleSessions, shouldSettle } from '../../src/session-settle.mjs';
import { redeemCalldata, sessionReader } from '../../src/session-chain.mjs';
import { CALLS_SPEC_3002 } from '../../src/runtime-calls.mjs';
import { RpcError, jsonRpc } from '../../src/rawtx.mjs';
import { HEADER_REQUIRED, HEADER_RESPONSE } from '../../src/protocol.mjs';
import { HEADER_VOUCHER } from '../../src/session.mjs';
import { accountView, assetView, assetId, parseAddress } from '../../src/lite-data.mjs';

const LEDGER_NAME = 'ledger-2'; // one per MeterSession deployment

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': `${HEADER_VOUCHER}, accept`,
  'access-control-expose-headers': `${HEADER_REQUIRED}, ${HEADER_RESPONSE}`,
  'access-control-max-age': '600',
};
const LIMITS = { quote: 60, paid: 30, free: 240, health: 30, windowSec: 60, globalPaid: 120, maxKeys: 20_000 };
const UPSTREAM_GAP_MS = 260; // public traffic, under 4 requests per second to the public nodes
const SETTLE_GAP_MS = 1100; // settlement has its own queue, so a flood of reads cannot starve it; together under 5 per second
const MAX_UPSTREAM_QUEUE = 40;
const CACHE_SEC = 15;
const MAX_SESSIONS_IN_A_BATCH = 4;
const MIN_PROVIDER_TPOT = 8n * 10n ** 18n; // EVM view of the balance: keep enough for one more batch
const MIN_DEPOSIT = 250_000n; // 0.25 pUSD: a batch locks one anchor deposit, so a session must be worth one
const MIN_FORCED_VALUE = 50_000n; // 0.05 pUSD: below this, an expiring session does not force a batch of its own
const MAX_UNSETTLED = 3_000_000n; // 3 pUSD of credit per session between settlements

function json(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2) + '\n', {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...CORS, ...headers },
  });
}

/** Rate-limit key: IPv6 addresses are handed out in /64 blocks, so count the block. */
function clientKey(ip) {
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

class Busy extends Error {
  constructor() {
    super('busy');
    this.httpStatus = 429;
    this.publicMessage = 'the demo is busy, try again in a minute';
  }
}

const withCors = r => {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
};

class DoLedger {
  constructor(storage) {
    this.s = storage;
  }
  async get(id) {
    return (await this.s.get(`s:${id}`)) ?? null;
  }
  async put(id, st) {
    await this.s.put(`s:${id}`, st);
    // settlement looks only at this index, so old and idle sessions cost nothing and can never crowd out a live one
    if (st.lastVoucher && st.count > (st.redeemedCount ?? 0) && !st.stuck) await this.s.put(`p:${id}`, 1);
    else await this.s.delete(`p:${id}`);
  }
  async append(id, row) {
    await this.s.put(`l:${id}:${String(row.n).padStart(10, '0')}`, row);
  }
  async log(id, { from = 1, limit = 500 } = {}) {
    const m = await this.s.list({ start: `l:${id}:${String(from).padStart(10, '0')}`, end: `l:${id};`, limit });
    return [...m.values()];
  }
  async pending() {
    const keys = [...(await this.s.list({ prefix: 'p:', limit: 200 })).keys()];
    return (await Promise.all(keys.map(k => this.get(k.slice(2))))).filter(Boolean);
  }
}

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.ledger = new DoLedger(ctx.storage);
    this.hits = new Map();
    this.windowStart = 0;
    this.cache = new Map();
    this.gate = Promise.resolve();
    this.settleGate = Promise.resolve();
    this.queued = 0;
    const evmRaw = jsonRpc(env.EVM_RPC);
    const subRaw = jsonRpc(env.SUB_RPC);
    this.evm = (m, p) => this.throttled(() => evmRaw(m, p));
    this.sub = (m, p) => this.throttled(() => subRaw(m, p));
    this.settleRpc = (m, p) => {
      const run = this.settleGate.then(async () => {
        await new Promise(r => setTimeout(r, SETTLE_GAP_MS));
        return evmRaw(m, p);
      });
      this.settleGate = run.catch(() => {});
      return run;
    };
    this.wallet = new Wallet(env.PROVIDER_KEY);
    this.meter = createMeter({
      chainId: Number(env.CHAIN_ID), sessionContract: env.SESSION_CONTRACT, settlement: env.SETTLEMENT,
      registry: { kind: 'ink', address: env.REGISTRY }, endpointId: Number(env.ENDPOINT_ID), wallet: this.wallet,
      token: env.TOKEN, tokenSymbol: env.TOKEN_SYMBOL, decimals: Number(env.DECIMALS), ledger: this.ledger,
      readSession: sessionReader(async ({ to, data }) => this.evm('eth_call', [{ to, data }, 'latest']), env.SESSION_CONTRACT),
      minDeposit: MIN_DEPOSIT, maxUnsettled: MAX_UNSETTLED, log: (...a) => console.log(...a),
    });
    this.readForSettle = sessionReader(async ({ to, data }) => this.settleRpc('eth_call', [{ to, data }, 'latest']), env.SESSION_CONTRACT);
  }

  /** Serialise upstream calls with a gap between them, and refuse rather than queue without limit. */
  throttled(fn) {
    if (this.queued >= MAX_UPSTREAM_QUEUE) return Promise.reject(new Error('upstream queue is full'));
    this.queued += 1;
    const run = this.gate.then(async () => {
      await new Promise(r => setTimeout(r, UPSTREAM_GAP_MS));
      return fn();
    }).finally(() => { this.queued -= 1; });
    this.gate = run.catch(() => {});
    return run;
  }

  allow(key, limit) {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.windowStart >= LIMITS.windowSec) {
      this.hits.clear();
      this.windowStart = now;
    }
    if (!this.hits.has(key) && this.hits.size >= LIMITS.maxKeys) return false; // full: refuse, never wave through
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    return n <= limit;
  }

  /** Answers and failures alike are kept for a while: a failing lookup is free, so it must not be free to repeat. */
  async cached(key, produce) {
    const now = Date.now() / 1000;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_SEC) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    if (this.cache.size > 500) this.cache.clear();
    try {
      const value = await produce();
      this.cache.set(key, { at: now, value });
      return value;
    } catch (e) {
      this.cache.set(key, { at: now, error: e });
      throw e;
    }
  }

  async meta() {
    return (await this.ctx.storage.get('meta')) ?? { lastSettledAt: 0, batches: 0, requests: 0, lastError: null };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const ip = clientKey(request.headers.get('x-client-ip') || 'unknown');
    const path = url.pathname;

    if (path === '/internal/tick') return json(200, await this.tick(false));
    if (path === '/internal/settle') return json(200, await this.tick(true));

    if (path === '/health') {
      if (!this.allow(`health:${ip}`, LIMITS.health)) return json(429, { error: 'too many requests' }, { 'retry-after': '60' });
      const [meta, states] = [await this.meta(), await this.ledger.pending()];
      const waiting = pendingSessions(states).reduce((n, s) => n + s.count - (s.redeemedCount ?? 0), 0);
      return json(200, { ok: !meta.lastError && !meta.stuck, sessionsWaiting: states.length, requestsWaitingForSettlement: waiting, batches: meta.batches, requestsSettled: meta.requests, lastSettledAt: meta.lastSettledAt, stuckSessions: meta.stuck ?? 0, lastError: meta.lastError });
    }

    if (path === '/v1/batches') {
      if (!this.allow(`free:${ip}`, LIMITS.free)) return json(429, { error: 'too many requests' }, { 'retry-after': '60' });
      const m = await this.ctx.storage.list({ prefix: 'b:', reverse: true, limit: 50 });
      return json(200, { batches: [...m.values()] });
    }

    const sess = /^\/v1\/session\/(0x[0-9a-fA-F]{64})(\/log)?$/.exec(path);
    if (sess) {
      if (!this.allow(`free:${ip}`, LIMITS.free)) return json(429, { error: 'too many requests' }, { 'retry-after': '60' });
      const id = sess[1].toLowerCase();
      try {
        if (!sess[2]) return json(200, await this.meter.sessionView(id));
        const from = Math.max(1, Math.min(Number(url.searchParams.get('from')) || 1, 2 ** 31));
        return json(200, { session: id, rows: await this.ledger.log(id, { from }) });
      } catch (e) {
        return json(e.status || 502, { error: e.status ? e.message : 'chain read failed' });
      }
    }

    const asset = /^\/v1\/asset\/([^/]{1,16})$/.exec(path);
    const account = /^\/v1\/account\/([^/]{1,64})$/.exec(path);
    if (!asset && !account) return json(404, { error: 'no such endpoint', catalog: '/.well-known/portal-meter' });
    const paying = request.headers.has(HEADER_VOUCHER);
    let input;
    try {
      input = decodeURIComponent((asset || account)[1]);
      if (asset) assetId(input);
      else parseAddress(input);
    } catch (e) {
      return json(400, { error: e.publicMessage || 'bad input' }); // free: nobody pays for a request that cannot be answered
    }
    if (!this.allow(`${paying ? 'paid' : 'quote'}:${ip}`, paying ? LIMITS.paid : LIMITS.quote)) return json(429, { error: 'too many requests' }, { 'retry-after': '60' });
    const io = { sub: this.sub, evm: this.evm };
    return withCors(await this.meter.charge(request, { price: this.env.PRICE }, () => {
      if (!this.allow('paid:all', LIMITS.globalPaid)) throw new Busy(); // counted after the signature: junk vouchers cannot use it up
      return this.cached(path, () => (asset ? assetView(io, input) : accountView(io, input)));
    }));
  }

  /** Settle when the rule says so (cron), or now (owner). Never throws: an error is kept for /health. */
  async tick(force) {
    const meta = await this.meta();
    const now = Math.floor(Date.now() / 1000);
    const states = await this.ledger.pending();
    if (!force && !shouldSettle(states, { now, lastSettledAt: meta.lastSettledAt, minValue: MIN_FORCED_VALUE })) return { settled: false };
    try {
      const bal = BigInt(await this.settleRpc('eth_getBalance', [this.wallet.address, 'latest']));
      if (bal < MIN_PROVIDER_TPOT) throw new Error('provider balance too low to settle');
      const usable = [];
      let stuck = meta.stuck ?? 0;
      for (const s of pendingSessions(states).slice(0, MAX_SESSIONS_IN_A_BATCH)) {
        // the chain is the truth: an earlier batch may have landed although its receipt never reached us
        const on = await this.readForSettle(s.session);
        if (on) await this.ledger.put(s.session, { ...(await this.ledger.get(s.session)), redeemedCount: on.count, redeemedCum: on.redeemed.toString() });
        if (!on || s.lastVoucher.count <= on.count) continue;
        const v = s.lastVoucher;
        try {
          await this.settleRpc('eth_call', [{ from: this.wallet.address, to: this.env.SESSION_CONTRACT, data: redeemCalldata(v.session, v.cumulative, v.count, v.head, v.signature) }, 'latest']);
          usable.push({ ...s, redeemedCount: on.count, redeemedCum: on.redeemed.toString() });
        } catch (e) {
          if (!(e instanceof RpcError) || !e.reverted) throw e; // a network problem says nothing about the session: try again next tick
          const row = await this.ledger.get(s.session);
          await this.ledger.put(s.session, { ...row, stuck: String(e.data || e.message).slice(0, 120) });
          stuck += 1;
        }
      }
      if (usable.length === 0) {
        await this.ctx.storage.put('meta', { ...meta, stuck });
        return { settled: false, reason: 'no session can be redeemed' };
      }
      const r = await settleSessions(usable, {
        rpc: this.settleRpc, wallet: this.wallet, chainId: Number(this.env.CHAIN_ID), calls: CALLS_SPEC_3002, sessionContract: this.env.SESSION_CONTRACT,
        registryAccountId: this.env.REGISTRY_ACCOUNT, endpointId: Number(this.env.ENDPOINT_ID), send: { polls: 16, pollMs: 3000 },
      });
      for (const b of r.batch) {
        const st = await this.ledger.get(b.session); // the freshest row: requests may have been served while this ran
        await this.ledger.put(b.session, { ...st, redeemedCount: b.count, redeemedCum: b.cumulative });
      }
      const n = (meta.batches ?? 0) + 1;
      const requests = r.batch.reduce((x, b) => x + b.requests, 0);
      await this.ctx.storage.put(`b:${String(n).padStart(8, '0')}`, { n, tx: r.tx, block: r.block, at: now, requests, sessions: r.batch });
      await this.ctx.storage.put('meta', { ...meta, lastSettledAt: now, batches: n, requests: (meta.requests ?? 0) + requests, stuck, lastError: null });
      return { settled: true, tx: r.tx, block: r.block, requests };
    } catch (e) {
      const lastError = String(e.message).slice(0, 200);
      await this.ctx.storage.put('meta', { ...meta, lastError, lastErrorAt: now });
      return { settled: false, error: lastError };
    }
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const stub = env.LEDGER.get(env.LEDGER.idFromName(LEDGER_NAME));
    if (url.pathname === '/admin/settle') {
      const auth = request.headers.get('authorization') || '';
      if (request.method !== 'POST' || !env.ADMIN_TOKEN || !timingSafeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) return json(404, { error: 'no such endpoint' });
      return stub.fetch(new Request(new URL('/internal/settle', url), { method: 'POST' }));
    }
    if (request.method !== 'GET') return json(405, { error: 'only GET is supported' }, { allow: 'GET, OPTIONS' });
    if (url.pathname === '/' || url.pathname === '/.well-known/portal-meter') {
      return json(200, {
        service: 'Portal Meter hosted seller', network: `eip155:${env.CHAIN_ID}`, sessionContract: env.SESSION_CONTRACT, settlement: env.SETTLEMENT, registry: env.REGISTRY,
        endpointId: Number(env.ENDPOINT_ID), token: env.TOKEN, tokenSymbol: env.TOKEN_SYMBOL, decimals: Number(env.DECIMALS), price: env.PRICE,
        endpoints: ['/v1/asset/{id}', '/v1/account/{ss58-or-0x-address}'], free: ['/v1/session/{id}', '/v1/session/{id}/log', '/v1/batches', '/health'],
        source: 'https://github.com/swiftbotlab/portal-meter', testnet: 'test tokens only',
      });
    }
    if (url.pathname.startsWith('/internal/')) return json(404, { error: 'no such endpoint' });
    if (url.pathname.length > 200 || url.search.length > 200) return json(414, { error: 'URL too long' });
    const headers = new Headers(request.headers);
    headers.set('x-client-ip', request.headers.get('cf-connecting-ip') || 'unknown');
    return stub.fetch(new Request(request.url, { method: 'GET', headers }));
  },
  async scheduled(_event, env, ctx) {
    const stub = env.LEDGER.get(env.LEDGER.idFromName(LEDGER_NAME));
    ctx.waitUntil(stub.fetch('https://internal/internal/tick', { method: 'POST' }));
  },
};
