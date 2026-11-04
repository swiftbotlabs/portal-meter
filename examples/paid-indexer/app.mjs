// The example's HTTP API, framework-free: a Web standard Request in, a Response out. It uses only the package's public
// entry points, the same ones `npm i github:swiftbotlabs/portal-meter` gives any third party.
//
//   GET /                              what is for sale (free)
//   GET /v1/transfers/{ss58 or 0x}     transfer history of an account from Portaldot's explorer indexer (paid)
//   GET /v1/session/{id}               where a session stands, for a client that lost its place (free)
//   GET /v1/session/{id}/log           the public request log: anyone can replay the session's hash chain (free)
import { BadInput, parseAddress, ss58Encode } from 'portal-meter/address';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status, obj) => new Response(JSON.stringify(obj, null, 2) + '\n', { status, headers: HEADERS });

/** The account an input names, as the SS58 address the indexer keys on. An H160 becomes its pallet-revive twin. */
export function accountOf(segment) {
  let input;
  try {
    input = decodeURIComponent(segment);
  } catch {
    throw new BadInput('bad address encoding');
  }
  return ss58Encode(parseAddress(input).accountId);
}

/**
 * @param o.meter     createMeter(...) from 'portal-meter'
 * @param o.upstream  explorerUpstream() from ./upstream.mjs
 * @param o.price     token base units per paid request
 * @param o.catalog   extra public facts for GET / (endpoint id, token, contracts)
 */
export function createApp({ meter, upstream, price, catalog = {} }) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET') return json(405, { error: 'only GET is supported' });
      if (url.pathname.length > 200 || url.search.length > 200) return json(414, { error: 'URL too long' });

      if (url.pathname === '/') {
        return json(200, {
          service: 'Paid indexer: account transfer history on the Portaldot V3 testnet, per call',
          paid: ['/v1/transfers/{ss58-or-0x-address}'], free: ['/v1/session/{id}', '/v1/session/{id}/log'],
          price: String(price), upstream: upstream.source, ...catalog,
          note: 'example built by the Portal Meter authors; test tokens only',
        });
      }

      const t = /^\/v1\/transfers\/([^/]{1,96})$/.exec(url.pathname);
      if (t) {
        let account;
        try {
          account = accountOf(t[1]);
        } catch (e) {
          // free: nobody is quoted, let alone charged, for a request that cannot be answered
          return json(400, { error: e instanceof BadInput ? e.publicMessage : 'bad address', charged: false });
        }
        return meter.charge(request, { price }, () => upstream.transfers(account));
      }

      const s = /^\/v1\/session\/(0x[0-9a-fA-F]{64})(\/log)?$/.exec(url.pathname);
      if (s) {
        const id = s[1].toLowerCase();
        try {
          if (!s[2]) return json(200, await meter.sessionView(id));
          const from = Math.max(1, Math.min(Number(url.searchParams.get('from')) || 1, 2 ** 31));
          return json(200, { session: id, rows: await meter.ledger.log(id, { from, limit: 500 }) });
        } catch (e) {
          return json(e.status || 502, { error: e.status ? e.message : 'chain read failed' });
        }
      }
      return json(404, { error: 'no such endpoint' });
    },
  };
}
