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
// straight off the name, skip serialized size, and use this table's own
// newest partition that actually holds rows as the "last update" (NOT
// `last .Q.pv` - a shared root like efx spans partitions far past a table
// that stopped loading days ago, e.g. fx_m1_yfinance).
// For an HDB process (anything with partitioned tables) we list ONLY `.Q.pt`
// - a shared HDB root can pick up scratch in-memory tables left by ad-hoc
//   screening scripts, which aren't part of the archive.
// `only` (whitelist of table names) is spliced into the query as a `tt inter`
// BEFORE `f each tt`, so a pinned source never runs the per-partition count
// scan over tables it isn't asking about - the point of pinning fx_hdb, whose
// efx root also holds multi-billion-row *_massive tables (~90s to scan).
//
// `boundDays` (>0) restricts the per-partition `count i by date` to the last
// N partition-dates instead of the whole history: an HDB root with thousands
// of partitions (efx ~5456, mon ~6191 - most of them empty `.Q.chk` stubs)
// is otherwise minutes to survey even for a trivially small table, because
// the cost is the per-partition query dispatch, not the data. `rows` then
// means "rows in the last N days" (the client labels it); `lastTs` /
// column count / non-partitioned tables are unaffected.
const surveyQuery = (only, boundDays) => {
  const safe = (only || []).filter((t) => /^[A-Za-z0-9_]+$/.test(t));
  const interClause = safe.length ? ` tt:tt inter (),${safe.map((t) => "`" + t).join("")};` : "";
  const bd = Number.isFinite(boundDays) && boundDays > 0 ? Math.floor(boundDays) : 0;
  // bounded: partition-prune to the last N days. `.Q.pv` empty => `last` is
  // 0Nd, the comparison is all-false, cbd empty (rows 0 / lastTs null) - fine
  // for an empty root, no guard needed.
  const cbd = bd
    ? `select cnt:count i by date from t where date > (last .Q.pv) - ${bd}`
    : "select cnt:count i by date from t";
  return (
    "{pt:.Q.pt; tt:$[count pt; pt; tables[]];" +
    interClause +
    " f:{[pt;t]$[t in pt;" +
    `   [cbd:${cbd};` +
    "    (sum exec cnt from cbd; count cols t; 0Nj;" +
    "     $[count d:exec date from cbd where cnt>0; `timestamp$last d; 0Np])];" +
    "   [v:value t; (count v; count cols v; -22!v;" +
    "     $[(`timestamp in cols v) and 0<count v; last v`timestamp; 0Np])]]}[pt;];" +
    " rr:f each tt;" +
    " (string .util.start.CLP[`name][`val];" +
    "  string .util.start.CLP[`procType][`val];" +
    "  ([] table:string tt;" +
    "      rows:$[count rr; rr[;0]; `long$()];" +
    "      ncols:$[count rr; rr[;1]; `long$()];" +
    "      bytes:$[count rr; rr[;2]; `long$()];" +
    "      lastTs:$[count rr; rr[;3]; `timestamp$()]))}[]"
  );
};

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

const queryFor = (kind, only, boundDays) =>
  kind === "idb" ? IDB_SURVEY : surveyQuery(only, boundDays);

const endpointsOf = (s) =>
  s.endpoints && s.endpoints.length ? s.endpoints : [{ host: s.host, port: s.port }];

class TablesReader {
  constructor(sources, timeoutMs = 4000) {
    this._srcCache = new Map(); // name -> { at, value, pending }
    this.sources = sources.map((s) => ({
      name: s.name,
      kind: s.kind || "rdb",
      // optional whitelist: survey reports ONLY these tables for this source
      // (see config.js tableSources `only` - keeps a shared HDB root's huge
      // unrelated tables, and a pipeline RDB's phantom schema tables, off
      // the dashboard). Also spliced into the survey query so a pinned HDB
      // never scans the tables it excludes.
      only: s.only && s.only.length ? s.only.slice() : null,
      // hdb only: cap the per-partition row count to the last N days (see
      // surveyQuery) so a thousands-of-partitions root (efx, mon) is
      // surveyable. `rows` then means "last N days"; flagged per row.
      boundDays: Number.isFinite(s.boundDays) && s.boundDays > 0 ? Math.floor(s.boundDays) : 0,
      sessions: endpointsOf(s).map(
        (e, i) =>
          new QSession({
            host: e.host,
            port: e.port,
            // a bounded hdb survey still walks N partitions per table - give
            // it more room than the default before the session gives up
            timeoutMs: (s.boundDays || (s.kind === "hdb" && !s.only)) ? Math.max(timeoutMs, 20000) : timeoutMs,
            reconnectMs: 1500,
            label: `tables:${s.name}${endpointsOf(s).length > 1 ? `#${i + 1}` : ""}`,
          })
      ),
    }));
  }

  start() {
    for (const s of this.sources) for (const sess of s.sessions) sess.start();
  }

  async _surveyEndpoint(sess, query, boundDays) {
    try {
      const [procName, procType, tbl] = await sess.sync(query, { timeoutMs: sess.timeoutMs });
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
          ...(boundDays ? { boundDays } : {}),
        })),
      };
    } catch (err) {
      return { ok: false, target: sess.target, connected: sess.connected, error: err.message, tables: [] };
    }
  }

  // Per-source: never more than one survey in flight, and reuse a result
  // for a few seconds. Without this, a client polling /api/tables every 3s
  // stacks surveys on any source slower than that - and a QSession timeout
  // only gives up client-side, the HDB keeps grinding the abandoned
  // `count i by date`, so a big root (efx, mon) saturates within a minute.
  _surveyOneCached(src) {
    const now = Date.now();
    const c = this._srcCache.get(src.name);
    if (c && c.pending) return c.pending;
    if (c && c.at && now - c.at < 2500) return Promise.resolve(c.value);
    const p = this._surveyOne(src)
      .then((v) => {
        this._srcCache.set(src.name, { at: Date.now(), value: v, pending: null });
        return v;
      })
      .catch((e) => {
        this._srcCache.set(src.name, { at: Date.now(), value: { name: src.name, connected: false, error: e.message, tables: [] }, pending: null });
        return this._srcCache.get(src.name).value;
      });
    this._srcCache.set(src.name, { ...(c || {}), pending: p });
    return p;
  }

  async _surveyOne(src) {
    const query = queryFor(src.kind, src.only, src.boundDays);
    const results = await Promise.all(src.sessions.map((sess) => this._surveyEndpoint(sess, query, src.boundDays)));
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
        if (src.only && !src.only.includes(t.table)) continue;
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
    const sources = await Promise.all(this.sources.map((s) => this._surveyOneCached(s)));
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
