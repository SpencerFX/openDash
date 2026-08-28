"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// Surveys a set of openQ processes (one RDB per pipeline by default) for
// their in-memory table inventory: row/column counts, serialized size, and
// the newest `timestamp` value per table. One persistent QSession per
// source; /api/tables fans the survey query across all of them in parallel.

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
    this.sources = sources.map((s) => ({
      name: s.name,
      session: new QSession({
        host: s.host,
        port: s.port,
        timeoutMs,
        reconnectMs: 1500,
        label: `tables:${s.name}`,
      }),
    }));
  }

  start() {
    for (const s of this.sources) s.session.start();
  }

  async _surveyOne(src) {
    const base = { name: src.name, target: src.session.target };
    try {
      const [procName, procType, tbl] = await src.session.sync(SURVEY);
      return {
        ...base,
        connected: true,
        process: procName,
        role: procType,
        tables: (toRows(tbl).rows || []).map((r) => ({
          table: r.table,
          rows: Number(r.rows),
          columns: Number(r.ncols),
          bytes: Number(r.bytes),
          lastTs: r.lastTs || null,
        })),
      };
    } catch (err) {
      return { ...base, connected: src.session.connected, error: err.message, tables: [] };
    }
  }

  async readAll() {
    const sources = await Promise.all(this.sources.map((s) => this._surveyOne(s)));
    let tables = 0, rows = 0, bytes = 0, online = 0;
    for (const s of sources) {
      if (s.connected) online += 1;
      for (const t of s.tables) {
        tables += 1;
        rows += t.rows || 0;
        bytes += t.bytes || 0;
      }
    }
    return { sources, totals: { sources: sources.length, online, tables, rows, bytes } };
  }

  status() {
    return {
      enabled: true,
      sources: this.sources.map((s) => ({ name: s.name, ...s.session.status() })),
    };
  }

  async stop() {
    await Promise.all(this.sources.map((s) => s.session.stop()));
  }
}

module.exports = { TablesReader };
