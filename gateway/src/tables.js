"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// Surveys a set of openQ processes for their in-memory table inventory:
// row/column counts, serialized size, and the newest `timestamp` value per
// table. /api/tables fans the survey query across all of them in parallel.
//
// A pipeline RDB is an active/standby PAIR (cfg_proc/.../rdb.json -port1 /
// -port2): the module's idb pivots which instance is subscribed every ~2
// minutes and flushes the one it just harvested, so at any moment one holds
// the live working set and the other is ~empty. A source can therefore
// carry several endpoints (`endpoints: [{host,port}, ...]`, or the legacy
// single `{host,port}`); every endpoint is surveyed and, per table, the row
// from whichever instance reports the most rows (the active one) is kept -
// otherwise `mon` (and every other RDB-pair source) would read as 0 for the
// half of each cycle its `-port1` instance sits standby.

// Per-source introspection. `cols` is a q keyword so the column is `ncols`.
// Handles both in-memory (RDB) tables and partitioned HDB tables: `value`,
// `-22!` and direct column access all `'par` on a partitioned table, so for
// anything in `.Q.pt` we count rows via `select count i by date` (the only
// per-partition count that doesn't hit `'nyi` on this build), take `cols`
// straight off the name, skip serialized size, and use the newest partition
// date as the "last update".
// For an HDB process (anything with partitioned tables) we list ONLY `.Q.pt`
// - a shared HDB root can pick up scratch in-memory tables left by ad-hoc
//   screening scripts, which aren't part of the archive.
const SURVEY =
  "{pt:.Q.pt; tt:$[count pt; pt; tables[]];" +
  " f:{[pt;t]$[t in pt;" +
  "   (sum exec cnt from select cnt:count i by date from t; count cols t; 0Nj; `timestamp$last .Q.pv);" +
  "   [v:value t; (count v; count cols v; -22!v;" +
  "     $[(`timestamp in cols v) and 0<count v; last v`timestamp; 0Np])]]}[pt;];" +
  " rr:f each tt;" +
  " (string .util.start.CLP[`name][`val];" +
  "  string .util.start.CLP[`procType][`val];" +
  "  ([] table:string tt;" +
  "      rows:$[count rr; rr[;0]; `long$()];" +
  "      ncols:$[count rr; rr[;1]; `long$()];" +
  "      bytes:$[count rr; rr[;2]; `long$()];" +
  "      lastTs:$[count rr; rr[;3]; `timestamp$()]))}[]";

// IDB (pivot-and-harvest) sources: the idb's own in-memory tables are
// transient - it pulls the active rdb over IPC, writes a numbered segment
// to -idbroot, then deletes the local copy, all inside one timer tick. So
// a live `count` almost always sees 0. Instead report the rows it has
// STAGED to -idbroot since the last EOD: sum the row count of every
// numbered segment dir under `.oq.idb.root`, per schema table (counting a
// splay's `sym` column file, which every segment/table has). That's "how
// much the real-time pipeline has durably captured today, pending EOD
// promote to the HDB".
const IDB_SURVEY =
  "{root:.oq.idb.root;" +
  " sd:string key root; sd:sd where sd like \"[0-9]*\"; segs:`$sd;" +
  " tabs:.oq.schema.tables[];" +
  " cnt:{[root;segs;t]$[0=count segs;0;" +
  "   sum {[root;t;s] @[{count get x};.Q.dd[.Q.dd[.Q.dd[root;s];t];`sym];0]}[root;t] each segs]}[root;segs];" +
  " rr:cnt each tabs;" +
  " (string .util.start.CLP[`name][`val];" +
  "  string .util.start.CLP[`procType][`val];" +
  "  ([] table:string tabs;" +
  "      rows:`long$rr;" +
  "      ncols:count[tabs]#0N;" +
  "      bytes:count[tabs]#0Nj;" +
  "      lastTs:count[tabs]#0Np))}[]";

const queryFor = (kind) => (kind === "idb" ? IDB_SURVEY : SURVEY);

const endpointsOf = (s) =>
  s.endpoints && s.endpoints.length ? s.endpoints : [{ host: s.host, port: s.port }];

class TablesReader {
  constructor(sources, timeoutMs = 4000) {
    this.sources = sources.map((s) => ({
      name: s.name,
      kind: s.kind || "rdb",
      sessions: endpointsOf(s).map(
        (e, i) =>
          new QSession({
            host: e.host,
            port: e.port,
            timeoutMs,
            reconnectMs: 1500,
            label: `tables:${s.name}${endpointsOf(s).length > 1 ? `#${i + 1}` : ""}`,
          })
      ),
    }));
  }

  start() {
    for (const s of this.sources) for (const sess of s.sessions) sess.start();
  }

  async _surveyEndpoint(sess, query) {
    try {
      const [procName, procType, tbl] = await sess.sync(query);
      return {
        ok: true,
        target: sess.target,
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
      return { ok: false, target: sess.target, connected: sess.connected, error: err.message, tables: [] };
    }
  }

  async _surveyOne(src) {
    const query = queryFor(src.kind);
    const results = await Promise.all(src.sessions.map((sess) => this._surveyEndpoint(sess, query)));
    const ok = results.filter((r) => r.ok);
    const connected = src.sessions.some((sess) => sess.connected);
    const target = results.map((r) => r.target).join(", ");

    if (!ok.length) {
      return {
        name: src.name,
        target,
        connected,
        error: (results.find((r) => r.error) || {}).error || "no endpoint responded",
        tables: [],
      };
    }

    // per table name, keep the row from the endpoint reporting the most
    // rows (the active RDB instance; a just-harvested standby reports ~0)
    const best = new Map();
    for (const r of ok) {
      for (const t of r.tables) {
        const cur = best.get(t.table);
        if (!cur || (t.rows || 0) > (cur.rows || 0)) best.set(t.table, t);
      }
    }
    // identity comes from whichever endpoint carried the most total rows
    const primary =
      ok.slice().sort((a, b) => tot(b.tables) - tot(a.tables))[0] || ok[0];

    return {
      name: src.name,
      target,
      connected: true,
      process: primary.process,
      role: primary.role,
      tables: [...best.values()].sort((a, b) => String(a.table).localeCompare(String(b.table))),
    };
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
      sources: this.sources.map((s) => ({
        name: s.name,
        kind: s.kind,
        endpoints: s.sessions.map((sess) => sess.status()),
      })),
    };
  }

  async stop() {
    await Promise.all(this.sources.flatMap((s) => s.sessions.map((sess) => sess.stop())));
  }
}

const tot = (rows) => (rows || []).reduce((a, t) => a + (t.rows || 0), 0);

module.exports = { TablesReader };
