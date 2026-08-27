"use strict";

const { QConnection } = require("jkdb");
const { toRows } = require("./qshape");

// Surveys a set of openQ processes (one RDB per pipeline by default) for
// their in-memory table inventory: row/column counts, serialized size, and
// the newest `timestamp` value per table. One persistent reconnecting
// connection per source; /api/tables fans a sync query across all of them.

// Per-source introspection. `cols` is a q keyword so the column is `ncols`.
const SURVEY =
  "{tt:tables[]; vv:value each tt;" +
  " (string .util.start.CLP[`name][`val];" +
  "  string .util.start.CLP[`procType][`val];" +
  "  ([] table:string tt;" +
  "      rows:count each vv;" +
  "      ncols:count each cols each vv;" +
  "      bytes:(-22!) each vv;" +
  "      lastTs:{$[(`timestamp in cols x) and 0<count x; last x`timestamp; 0Np]} each vv))}[]";

class TablesReader {
  constructor(sources, timeoutMs = 4000) {
    this.timeoutMs = timeoutMs;
    this.conns = sources.map((s) => ({
      name: s.name,
      host: s.host,
      port: s.port,
      q: null,
      connected: false,
      stopped: false,
    }));
  }

  start() {
    for (const c of this.conns) this._connect(c);
  }

  _connect(c) {
    if (c.stopped) return;
    const q = new QConnection({ host: c.host, port: c.port, socketNoDelay: true });
    c.q = q;
    const gone = () => {
      if (c.q !== q) return;
      c.connected = false;
      if (!c.stopped) setTimeout(() => this._connect(c), 1500);
    };
    q.on("close", gone);
    q.on("end", gone);
    q.on("error", () => {});
    q.connect((err) => {
      if (c.q !== q) return;
      if (err) return setTimeout(() => this._connect(c), 1500);
      c.connected = true;
    });
  }

  _surveyOne(c) {
    const base = { name: c.name, target: `${c.host}:${c.port}` };
    if (!c.connected || !c.q) {
      return Promise.resolve({ ...base, connected: false, tables: [] });
    }
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ...base, connected: false, error: "timeout", tables: [] });
      }, this.timeoutMs);
      c.q.sync(SURVEY, (err, res) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (err) return resolve({ ...base, connected: true, error: err.message, tables: [] });
        const [procName, procType, tbl] = res;
        const shaped = toRows(tbl);
        resolve({
          ...base,
          connected: true,
          process: procName,
          role: procType,
          tables: (shaped.rows || []).map((r) => ({
            table: r.table,
            rows: Number(r.rows),
            columns: Number(r.ncols),
            bytes: Number(r.bytes),
            lastTs: r.lastTs || null,
          })),
        });
      });
    });
  }

  async readAll() {
    const sources = await Promise.all(this.conns.map((c) => this._surveyOne(c)));
    let tables = 0, rows = 0, bytes = 0, online = 0;
    for (const s of sources) {
      if (s.connected) online += 1;
      for (const t of s.tables) {
        tables += 1;
        rows += t.rows || 0;
        bytes += t.bytes || 0;
      }
    }
    return {
      sources,
      totals: { sources: sources.length, online, tables, rows, bytes },
    };
  }

  status() {
    return {
      enabled: true,
      sources: this.conns.map((c) => ({ name: c.name, target: `${c.host}:${c.port}`, connected: c.connected })),
    };
  }

  async stop() {
    await Promise.all(
      this.conns.map(
        (c) =>
          new Promise((res) => {
            c.stopped = true;
            try {
              c.q ? c.q.close(() => res()) : res();
            } catch {
              res();
            }
          })
      )
    );
  }
}

module.exports = { TablesReader };
