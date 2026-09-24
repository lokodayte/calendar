// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite, for tests.
// Implements the parts of the D1 API the Worker uses: prepare/bind/first/all/run and batch.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../../worker/migrations/", import.meta.url));

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) {
    for (const p of params) if (p === undefined) throw new Error("D1_TYPE_ERROR: undefined is not a valid bind value");
    return new Statement(this.db, this.sql, params);
  }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)|RETURNING/i.test(this.sql)) {
      const rows = st.all(...this.params).map((r) => ({ ...r }));
      return { results: rows, success: true, meta: { changes: /RETURNING/i.test(this.sql) ? rows.length : 0 } };
    }
    const r = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) {
    const row = this._exec().results[0];
    if (!row) return null;
    return col ? row[col] : row;
  }
  async all() { return this._exec(); }
  async run() { return this._exec(); }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(MIGRATIONS + f, "utf8"));
    }
  }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s._exec());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Direct synchronous query, for test assertions. */
  q(sql, ...params) { return this.db.prepare(sql).all(...params).map((r) => ({ ...r })); }
}
