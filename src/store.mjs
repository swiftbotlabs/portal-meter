// Seller state: issued quotes (by nonce) and request outcomes (by request id). Served-once is enforced here:
// claim() is an atomic check-and-set inside one process, and the file is rewritten atomically (tmp + rename)
// so a crash never leaves a half-written state. Sizes are capped; expired quotes are evicted.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_QUOTES = 10_000;
const MAX_REQUESTS = 100_000;

export class Store {
  constructor(path = null, now = () => Math.floor(Date.now() / 1000)) {
    this.path = path;
    this.now = now;
    this.quotes = new Map();
    this.requests = new Map();
    if (path && existsSync(path)) {
      const d = JSON.parse(readFileSync(path, 'utf8'));
      for (const [k, v] of d.quotes || []) this.quotes.set(k, v);
      for (const [k, v] of d.requests || []) this.requests.set(k, v);
      // anything that was mid-flight when the process stopped needs a human look, never a silent re-serve
      for (const v of this.requests.values()) if (v.state === 'serving') v.state = 'interrupted';
    }
  }

  #save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ quotes: [...this.quotes], requests: [...this.requests] }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  #evict() {
    const t = this.now();
    for (const [k, q] of this.quotes) if (q.expiresAt + 3600 < t || q.used) this.quotes.delete(k);
    while (this.quotes.size > MAX_QUOTES) this.quotes.delete(this.quotes.keys().next().value);
    while (this.requests.size > MAX_REQUESTS) this.requests.delete(this.requests.keys().next().value);
  }

  addQuote(q) {
    this.#evict();
    this.quotes.set(q.nonce.toLowerCase(), { ...q, used: false });
    this.#save();
  }

  getQuote(nonce) {
    return this.quotes.get(String(nonce).toLowerCase()) || null;
  }

  /** Mark request id as being served. Returns false if it was ever claimed before (served once). */
  claim(requestId, info) {
    const k = requestId.toLowerCase();
    if (this.requests.has(k)) return false;
    this.requests.set(k, { ...info, state: 'serving', at: this.now() });
    const q = this.quotes.get(String(info.nonce).toLowerCase());
    if (q) q.used = true;
    this.#save();
    return true;
  }

  finish(requestId, patch) {
    const k = requestId.toLowerCase();
    const r = this.requests.get(k);
    if (!r) throw new Error('finish() on unknown request');
    Object.assign(r, patch);
    this.#save();
  }

  request(requestId) {
    return this.requests.get(requestId.toLowerCase()) || null;
  }
}
