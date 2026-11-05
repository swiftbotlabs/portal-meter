// The data being sold: account transfer history from Portaldot's public explorer indexer for the V3 testnet.
// A plain RPC node cannot answer "which transfers touched this account?" without scanning every block; an indexer can,
// which is exactly the kind of read an indexer operator would charge for.
//
// The host is fixed, so nothing a buyer sends can point it anywhere else. Calls are spaced out (under 4 per second,
// below the 5 per second the Portaldot team asks for on its public endpoints), the queue is bounded, and every answer is
// capped in time and size before it is parsed.

export const EXPLORER_API = 'https://scanner-testnet-v3-api.portaldot.dev';
const NATIVE_DECIMALS = 14; // tPOT on the Substrate side
const MAX_ITEMS = 50;
const SS58 = /^[1-9A-HJ-NP-Za-km-z]{46,48}$/;

/** A failure the meter turns into an answer without a charge: `httpStatus` and `publicMessage` shape it. */
export class UpstreamError extends Error {
  constructor(msg, status = 502) {
    super(msg);
    this.httpStatus = status;
    this.publicMessage = msg;
  }
}

/** "2500000000000000" -> "25" (tPOT has 14 decimals on the Substrate side). */
export function formatNative(raw) {
  const v = BigInt(raw);
  const unit = 10n ** BigInt(NATIVE_DECIMALS);
  const frac = (v % unit).toString().padStart(NATIVE_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${v / unit}.${frac}` : `${v / unit}`;
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new UpstreamError('the explorer answer is too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError('the explorer answer is too large');
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const part of parts) {
    all.set(part, o);
    o += part.length;
  }
  return new TextDecoder().decode(all);
}

/** The explorer sends an amount either as a decimal string or as a 0x-prefixed big-endian u128. Null if neither. */
export function amountOf(v) {
  const s = String(v);
  if (/^[0-9]{1,39}$/.test(s) || /^0x[0-9a-fA-F]{1,32}$/.test(s)) return BigInt(s);
  return null;
}

/** Keep only well-formed rows, in a shape that does not depend on the explorer's internals. */
export function normaliseTransfers(account, j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.items)) throw new UpstreamError('unexpected answer from the explorer');
  const transfers = [];
  let skipped = 0;
  for (const i of j.items.slice(0, MAX_ITEMS)) {
    const ix = i && i.indexer;
    const ok = ix && Number.isInteger(ix.blockHeight) && Number.isFinite(ix.blockTime) && typeof i.from === 'string' && SS58.test(i.from)
      && typeof i.to === 'string' && SS58.test(i.to) && amountOf(i.balance) !== null;
    if (!ok) {
      skipped += 1;
      continue;
    }
    const native = i.isNativeAsset === true;
    const raw = amountOf(i.balance).toString();
    transfers.push({
      block: ix.blockHeight,
      time: new Date(ix.blockTime).toISOString(),
      direction: i.to === account ? 'in' : i.from === account ? 'out' : 'other',
      from: i.from,
      to: i.to,
      amount: native ? formatNative(raw) : null,
      unit: native ? 'tPOT' : 'asset base units',
      raw,
      native,
    });
  }
  return { account, network: 'PortaldotV3 testnet', total: Number.isInteger(j.total) ? j.total : transfers.length, transfers, skipped };
}

/**
 * @param o.base       explorer API (default: Portaldot's public testnet indexer)
 * @param o.fetchImpl  fetch, for tests
 * @param o.timeoutMs, o.maxBytes, o.minGapMs, o.maxQueue
 */
export function explorerUpstream({ base = EXPLORER_API, fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 8000, maxBytes = 256 * 1024, minGapMs = 260, maxQueue = 20 } = {}) {
  let gate = Promise.resolve();
  let queued = 0;
  let calls = 0;

  function spaced(fn) {
    if (queued >= maxQueue) return Promise.reject(new UpstreamError('busy, try again in a moment', 503));
    queued += 1;
    const run = gate.then(async () => {
      await new Promise(r => setTimeout(r, minGapMs));
      return fn();
    }).finally(() => { queued -= 1; });
    gate = run.catch(() => {});
    return run;
  }

  async function getJson(path) {
    return spaced(async () => {
      calls += 1;
      let res;
      try {
        res = await fetchImpl(base + path, {
          headers: { accept: 'application/json', 'user-agent': 'portal-meter-example/0.1' },
          // 'manual', not 'error': Cloudflare Workers accept only follow or manual; a redirect is refused below
          redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new UpstreamError('the explorer did not answer');
      }
      if (res.status >= 300 && res.status < 400) throw new UpstreamError('the explorer redirected, not followed');
      if (!res.ok) throw new UpstreamError(`the explorer answered HTTP ${res.status}`);
      const text = await readCapped(res, maxBytes);
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError('the explorer did not send JSON');
      }
    });
  }

  return {
    source: base,
    calls: () => calls,
    /** `account` must already be a checked SS58 address (see app.mjs). */
    async transfers(account) {
      if (!SS58.test(account)) throw new UpstreamError('bad account', 400);
      const j = await getJson(`/accounts/${encodeURIComponent(account)}/transfers`);
      return { ...normaliseTransfers(account, j), source: `Portaldot explorer indexer, ${base}` };
    },
  };
}
