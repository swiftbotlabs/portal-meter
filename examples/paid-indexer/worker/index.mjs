// The paid indexer, hosted: the same app as server.mjs, on Cloudflare Workers. One Durable Object is the single writer
// for all sessions (the meter's ledger) and settles by itself on an alarm, so there is no server, no database and no cron.
// Built on the package's public entry points only, like the rest of this example.
//
//   npm install && npx wrangler@4.151.1 deploy -c worker/wrangler.toml
//   npx wrangler@4.151.1 secret put PROVIDER_KEY -c worker/wrangler.toml     (the endpoint's testnet provider key, from stdin)
import { DurableObject } from 'cloudflare:workers';
import { Wallet } from 'ethers';
import { createMeter } from 'portal-meter';
import { sessionReader } from 'portal-meter/chain';
import { createSettler, pendingSessions } from 'portal-meter/settle';
import dep from 'portal-meter/deployments/sessions.json' with { type: 'json' };
import { createApp } from '../app.mjs';
import { explorerUpstream } from '../upstream.mjs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'payment-voucher, accept',
  'access-control-expose-headers': 'payment-required, payment-response',
};
const LIMITS = { quote: 60, paid: 30, free: 240, windowSec: 60, globalPaid: 120, maxKeys: 20_000 };
const SETTLE_CHECK_MS = 10 * 60_000;
const FIRST_CHECK_MS = 5 * 60_000;
const MIN_PROVIDER_WEI = 8n * 10n ** 18n; // keep enough for one more ink! anchor deposit (about 3.7 tPOT)
const RPC_GAP_MS = 260; // under 4 requests per second to the public Portaldot nodes

function json(status, obj) {
  return new Response(JSON.stringify(obj, null, 2) + '\n', {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...CORS },
  });
}
const withCors = r => {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
};

/** The meter's ledger interface over Durable Object storage, with an index of sessions that wait for settlement. */
class DoLedger {
  constructor(storage) {
    this.s = storage;
  }
  async get(id) {
    return (await this.s.get(`s:${id}`)) ?? null;
  }
  async put(id, st) {
    await this.s.put(`s:${id}`, st);
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

export class IndexerLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.ledger = new DoLedger(ctx.storage);
    this.hits = new Map();
    this.windowStart = 0;
    this.gate = Promise.resolve();
    if (!env.PROVIDER_KEY) return;
    const endpointId = Number(env.ENDPOINT_ID);
    const rpc = (method, params) => this.spaced(async () => {
      const r = await fetch(env.EVM_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { code: j.error.code, data: j.error.data });
      return j.result;
    });
    this.wallet = new Wallet(env.PROVIDER_KEY);
    this.meter = createMeter({
      chainId: dep.chainId, sessionContract: dep.sessionContract, settlement: dep.settlement, registry: { kind: 'ink', address: dep.registry },
      endpointId, wallet: this.wallet, token: dep.token.precompile, tokenSymbol: dep.token.symbol, decimals: dep.token.decimals, ledger: this.ledger,
      readSession: sessionReader(({ to, data }) => rpc('eth_call', [{ to, data }, 'latest']), dep.sessionContract),
      minDeposit: 50_000n, maxUnsettled: 1_000_000n, log: (...a) => console.log(...a),
    });
    this.settler = createSettler({
      ledger: this.ledger, wallet: this.wallet, rpc: env.EVM_RPC, chainId: dep.chainId, sessionContract: dep.sessionContract, endpointId,
      registryAccountId: dep.registryAccountId, minBalance: MIN_PROVIDER_WEI, send: { polls: 16, pollMs: 3000 },
      policy: { minRequests: 5, maxWaitSec: 3600, minGapSec: 1800, minValue: 20_000n },
      state: { get: () => ctx.storage.get('settle-meta'), put: v => ctx.storage.put('settle-meta', v) },
    });
    this.app = createApp({
      meter: this.meter, upstream: explorerUpstream(), price: BigInt(env.PRICE),
      catalog: { network: `eip155:${dep.chainId}`, endpointId, token: dep.token.precompile, tokenSymbol: dep.token.symbol, sessionContract: dep.sessionContract, registry: dep.registry, source: 'https://github.com/swiftbotlabs/portal-meter/tree/main/examples/paid-indexer' },
    });
  }

  /** Chain reads one at a time with a gap, so a burst of buyers stays under the public nodes' rate. */
  spaced(fn) {
    const run = this.gate.then(async () => {
      await new Promise(r => setTimeout(r, RPC_GAP_MS));
      return fn();
    });
    this.gate = run.catch(() => {});
    return run;
  }

  allow(key, limit) {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.windowStart >= LIMITS.windowSec) {
      this.hits.clear();
      this.windowStart = now;
    }
    if (!this.hits.has(key) && this.hits.size >= LIMITS.maxKeys) return false;
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    return n <= limit;
  }

  async health() {
    const meta = (await this.ctx.storage.get('settle-meta')) ?? {};
    const watch = (await this.ctx.storage.get('watch')) ?? { failures: 0 };
    const waiting = pendingSessions(await this.ledger.pending()).reduce((n, s) => n + s.count - (s.redeemedCount ?? 0), 0);
    return { ok: !!this.settler && watch.failures < 5, configured: !!this.settler, requestsWaitingForSettlement: waiting, batches: meta.batches ?? 0, requestsSettled: meta.requests ?? 0, lastSettledAt: meta.lastSettledAt ?? 0, lastCheck: watch.at ?? null, lastResult: watch.result ?? null, consecutiveFailures: watch.failures };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const ip = request.headers.get('x-client-ip') || 'unknown';
    if (url.pathname === '/health') return json(200, await this.health());
    if (!this.app) return json(503, { error: 'seller not configured' });
    const paid = /^\/v1\/transfers\//.test(url.pathname);
    const paying = request.headers.has('payment-voucher');
    const bucket = !paid ? 'free' : paying ? 'paid' : 'quote';
    if (!this.allow(`${bucket}:${ip}`, LIMITS[bucket]) || (paying && !this.allow('paid:all', LIMITS.globalPaid))) {
      return json(429, { error: 'too many requests', retryAfter: 60 });
    }
    const r = await this.app.fetch(request);
    if (paying && r.status === 200 && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + FIRST_CHECK_MS);
    return withCors(r);
  }

  /** One settlement check: one log line; keeps checking while anything waits. Failures are counted for /health. */
  async alarm() {
    if (!this.settler) return;
    const r = await this.settler.tick();
    const watch = (await this.ctx.storage.get('watch')) ?? { failures: 0 };
    const failures = r.error ? watch.failures + 1 : 0;
    const result = r.settled ? { settled: true, tx: r.tx, block: r.block, requests: r.requests } : { settled: false, reason: r.reason ?? null, error: r.error ?? null };
    await this.ctx.storage.put('watch', { at: Math.floor(Date.now() / 1000), failures, result });
    console.log(JSON.stringify({ check: 'settle', failures, ...result }));
    if ((await this.ledger.pending()).length > 0) await this.ctx.storage.setAlarm(Date.now() + SETTLE_CHECK_MS);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json(405, { error: 'only GET is supported' });
    const url = new URL(request.url);
    if (url.pathname.length > 200 || url.search.length > 200) return json(414, { error: 'URL too long' });
    const headers = new Headers(request.headers);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    headers.set('x-client-ip', ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip);
    const stub = env.LEDGER.get(env.LEDGER.idFromName('indexer-1'));
    return stub.fetch(new Request(request.url, { method: 'GET', headers }));
  },
};
