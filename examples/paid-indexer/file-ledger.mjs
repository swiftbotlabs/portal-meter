// A ledger that survives a restart. The meter only needs get, put, append, log and all; this keeps them in one JSON
// file, written atomically (temp file, then rename) with mode 0600. One process writes it, which is what the meter
// expects anyway (one writer per session). Signed vouchers are in here: without them the provider cannot get paid.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_ROWS_PER_SESSION = 100_000;

export class FileLedger {
  constructor(path) {
    this.path = path;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sessions: {}, logs: {} };
  }

  #save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  async get(id) {
    const s = this.data.sessions[id];
    return s ? structuredClone(s) : null;
  }

  async put(id, state) {
    this.data.sessions[id] = structuredClone(state);
    this.#save();
  }

  async append(id, row) {
    const rows = (this.data.logs[id] ??= []);
    if (rows.length >= MAX_ROWS_PER_SESSION) throw new Error('session log is full');
    rows.push(row);
    this.#save();
  }

  async log(id, { from = 1, limit = 1000 } = {}) {
    return (this.data.logs[id] ?? []).filter(r => r.n >= from).slice(0, limit);
  }

  async all() {
    return Object.values(this.data.sessions).map(s => structuredClone(s));
  }
}
