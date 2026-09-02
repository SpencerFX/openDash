"use strict";

const { CepReader } = require("./cepReader");
const { toRows } = require("./qshape");

// Reads the two on-disk table-health archives that
// examples/scripts/05_table_health_scan.q writes under -monroot
// (C:/data/db1/mon): `tableHealth` (bar-level tables) and `tableHealthTick`
// (tick-level tables). Both have the identical .oq.hk.tableHealth shape -
// one row per (tab, date), with that table's whole-history summary repeated
// on every row:
//   date timestamp sym tab role rowCountToday rowCountTotal firstTime
//   lastTime ageSec bytesMem bytesDisk partitionCnt oldestDate newestDate
//   status(`HEALTHY|`EMPTY)
// Served off the running mon_hdb (OPENQ_HDBHEALTH, default 127.0.0.1:5023),
// which loads that same C:/data/db1/mon archive.
//
// The queries are whole-archive scans (~6k partitions) and the archive only
// changes when the scan is re-run, so read() is served from a short TTL
// cache and refreshed in the background.

// month rollup, mn = YYYYMM int. One full-archive scan per table; the
// per-table archive totals (bytes / scanned-day / empty-day counts) are
// summed from this in read() rather than a second scan.
const MONTHLY = (t) =>
  `0!select rows:sum rowCountToday, bytes:sum bytesDisk, days:count i, emptyDays:sum status=\`EMPTY ` +
  `by tab, mn:(100*\`year$date)+\`mm$date from ${t}`;

// Newest date that actually HAS rows in this archive - not `max date` (the
// virtual partition column), which spans the whole shared C:/data/db1/mon
// root: since core/hdb.q's .Q.chk backfills an empty `tableHealth` splay
// into the mon module's own newer partitions (which only carry logs/
// pidstats), `max date` points at an empty stub and `where date=max date`
// comes back blank. `select date from t` only yields real rows, so its max
// is the last genuine health scan.
const ANCHOR = (t) => `(exec max date from select date from ${t})`;

// newest-scan row per table + the repeated whole-history summary cols
const LATEST = (t) =>
  `0!select role:first role, status:first status, rowsToday:first rowCountToday, rowsTotal:first rowCountTotal, ` +
  `bytesToday:first bytesDisk, partitionCnt:first partitionCnt, oldestDate:first oldestDate, newestDate:first newestDate, ` +
  `firstTime:first firstTime, lastTime:first lastTime, ageSec:first ageSec, scanTs:last timestamp ` +
  `by tab from ${t} where date=${ANCHOR(t)}`;

// daily granularity for the recent window (touches ~180 partitions only)
const RECENT = (t) =>
  `0!select rowsToday:first rowCountToday, bytesDisk:first bytesDisk, status:first status ` +
  `by date, tab from ${t} where date>=${ANCHOR(t)}-180`;

const QUERIES = {
  latestBar: LATEST("tableHealth"),
  monthlyBar: MONTHLY("tableHealth"),
  recentBar: RECENT("tableHealth"),
  latestTick: LATEST("tableHealthTick"),
  monthlyTick: MONTHLY("tableHealthTick"),
  recentTick: RECENT("tableHealthTick"),
};

const TTL_MS = 60000;
const DAY_MS = 86400000;
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const day = (v) => (v == null ? null : iso(v).slice(0, 10));
const n = (v) => (v == null || Number.isNaN(v) ? null : Number(v));
const mnLabel = (mn) => `${String(mn).slice(0, 4)}-${String(mn).slice(4)}`;

class HdbHealthReader extends CepReader {
  constructor(opts) {
    super(opts, QUERIES);
    this._cache = { at: 0, data: null };
    this._inflight = null;
  }

  start() {
    super.start();
    // warm the cache so the first dashboard hit isn't a cold full scan
    this.read().catch(() => {});
  }

  _emptyResult(err) {
    return {
      connected: this.connected,
      target: this.target,
      error: err ? String(err.message || err) : "archive scan unavailable",
      scanTs: null,
      cachedAt: null,
      tables: [],
      monthly: [],
      recent: [],
      totals: { tables: 0 },
    };
  }

  // jkdb serialises concurrent syncs on one socket, so a Promise.all would
  // make the later whole-archive queries time out waiting in the queue.
  // Run them one at a time. Any query may come back empty - a slow/absent
  // partition scan or an older -monroot that was only scanned bar-level -
  // and read() shapes whatever arrived (partial > nothing).
  async _seq() {
    const out = {};
    let ok = 0;
    for (const name of Object.keys(QUERIES)) {
      try {
        out[name] = toRows(await this.session.sync(QUERIES[name]));
        ok += 1;
      } catch (e) {
        // Don't retry here - a client-side timeout leaves the query still
        // running on the hdb; hammering it just piles on more. Skip this
        // one, let the TTL refresh pick it up once the hdb catches up.
        this._lastErr = e;
        out[name] = { rows: [] };
      }
    }
    if (!ok) throw this._lastErr || new Error("all health queries failed");
    return out;
  }

  async read() {
    if (this._cache.data && Date.now() - this._cache.at < TTL_MS) return this._cache.data;

    if (!this._inflight) {
      // This promise must NEVER reject: read() may return the stale cache
      // synchronously and leave this reference un-awaited, so an unhandled
      // rejection here would crash the process. A failed scan keeps the
      // last good cache and is retried on the next call.
      this._inflight = this._compute()
        .then((data) => {
          // a partial scan (some query timed out) is cached only briefly so
          // it's retried soon; a complete one gets the full TTL
          const kinds = new Set(data.tables.map((t) => t.kind));
          const monthlyKinds = new Set(data.monthly.map((m) => m.kind));
          const partial =
            !data.tables.length ||
            !data.monthly.length ||
            [...kinds].some((k) => !monthlyKinds.has(k));
          this._cache = { at: partial ? Date.now() - (TTL_MS - 10000) : Date.now(), data };
          return data;
        })
        .catch((e) => {
          this._lastErr = e;
          return this._cache.data || null;
        })
        .finally(() => {
          this._inflight = null;
        });
    }

    if (this._cache.data) return this._cache.data; // serve stale, refresh in bg
    return (await this._inflight) || this._emptyResult(this._lastErr);
  }

  async _compute() {
    const r = await this._seq();

    const monthlyOf = (rows, kind) =>
      (rows || []).map((x) => ({
        kind,
        tab: x.tab,
        mn: n(x.mn),
        month: mnLabel(x.mn),
        rows: n(x.rows) || 0,
        bytes: n(x.bytes) || 0,
        days: n(x.days) || 0,
        emptyDays: n(x.emptyDays) || 0,
      }));

    const monthly = [
      ...monthlyOf(r.monthlyBar.rows, "bar"),
      ...monthlyOf(r.monthlyTick.rows, "tick"),
    ].sort((a, b) => a.mn - b.mn);

    // per-tab archive totals, summed from the month rollup
    const arch = new Map();
    for (const m of monthly) {
      const a = arch.get(m.tab) || { bytesArchive: 0, scannedDays: 0, emptyDays: 0 };
      a.bytesArchive += m.bytes;
      a.scannedDays += m.days;
      a.emptyDays += m.emptyDays;
      arch.set(m.tab, a);
    }

    const latestOf = (rows, kind) =>
      (rows || []).map((x) => {
        const a = arch.get(x.tab) || { bytesArchive: null, scannedDays: 0, emptyDays: 0 };
        const oldest = day(x.oldestDate);
        const newest = day(x.newestDate);
        const spanDays =
          oldest && newest ? Math.round((Date.parse(newest) - Date.parse(oldest)) / DAY_MS) + 1 : null;
        const partitionCnt = n(x.partitionCnt) || 0;
        const healthyDays = Math.max(0, a.scannedDays - a.emptyDays);
        return {
          tab: x.tab,
          kind, // "bar" | "tick"
          role: x.role || null,
          status: x.status || null,
          rowsTotal: n(x.rowsTotal),
          rowsToday: n(x.rowsToday),
          bytesArchive: a.bytesArchive,
          bytesToday: n(x.bytesToday),
          partitionCnt,
          scannedDays: a.scannedDays,
          emptyDays: a.emptyDays,
          healthyDays,
          missingDays: spanDays != null ? Math.max(0, spanDays - partitionCnt) : null,
          coveragePct: a.scannedDays ? (healthyDays / a.scannedDays) * 100 : null,
          oldestDate: oldest,
          newestDate: newest,
          spanDays,
          firstTime: iso(x.firstTime),
          lastTime: iso(x.lastTime),
          ageSec: n(x.ageSec),
          scanTs: iso(x.scanTs),
        };
      });

    const tables = [
      ...latestOf(r.latestBar.rows, "bar"),
      ...latestOf(r.latestTick.rows, "tick"),
    ].sort((a, b) => (b.rowsTotal || 0) - (a.rowsTotal || 0));

    const recentOf = (rows, kind) =>
      (rows || []).map((x) => ({
        kind,
        tab: x.tab,
        date: day(x.date),
        rowsToday: n(x.rowsToday) || 0,
        bytesDisk: n(x.bytesDisk) || 0,
        status: x.status || null,
      }));

    const recent = [
      ...recentOf(r.recentBar.rows, "bar"),
      ...recentOf(r.recentTick.rows, "tick"),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));

    const oldest = tables.map((t) => t.oldestDate).filter(Boolean).sort()[0] || null;
    const newest = tables.map((t) => t.newestDate).filter(Boolean).sort().slice(-1)[0] || null;
    const scanTs = tables.map((t) => t.scanTs).filter(Boolean).sort().slice(-1)[0] || null;

    return {
      connected: this.connected,
      target: this.target,
      scanTs,
      cachedAt: new Date().toISOString(),
      tables,
      monthly,
      recent,
      totals: {
        tables: tables.length,
        bar: tables.filter((t) => t.kind === "bar").length,
        tick: tables.filter((t) => t.kind === "tick").length,
        rowsTotal: tables.reduce((a, t) => a + (t.rowsTotal || 0), 0),
        bytesArchive: tables.reduce((a, t) => a + (t.bytesArchive || 0), 0),
        emptyLatest: tables.filter((t) => t.status === "EMPTY").length,
        healthyLatest: tables.filter((t) => t.status === "HEALTHY").length,
        oldestDate: oldest,
        newestDate: newest,
        spanDays:
          oldest && newest ? Math.round((Date.parse(newest) - Date.parse(oldest)) / DAY_MS) + 1 : null,
      },
    };
  }

  status() {
    return { ...super.status(), cachedAt: this._cache.data ? this._cache.data.cachedAt : null };
  }
}

// --- live scan of a running HDB's own partitioned tables ------------------
//
// Not the pre-computed `tableHealth` archive - this walks the HDB process's
// own `.Q.pt` right now: per table, partition count (with data), total rows
// (`.Q.pn`), rows in the newest partition, oldest/newest date, the newest
// `timestamp` value (staleness), and missing calendar days in range. No
// monthly / coverage / recent history (that needs per-day archive rows).
const LIVE_SCAN =
  "{[now]" +
  " f:{[now;t]" +
  "  bc:0!select n:count i by date from t;" +
  "  real:select from bc where n>0; pc:count real;" +
  "  od:$[pc;first real`date;0Nd]; nd:$[pc;last real`date;0Nd];" +
  "  rt:sum bc`n; rToday:$[pc;last real`n;0j];" +
  "  lastTs:$[pc and `timestamp in cols t; last exec timestamp from (select timestamp from t where date=nd); 0Np];" +
  "  span:$[pc;1+`long$nd-od;0N];" +
  "  (`tab`partitionCnt`rowsTotal`rowsToday`oldestDate`newestDate`spanDays`missingDays`lastTs`ageSec`status)!" +
  "   (t;pc;rt;rToday;od;nd;span;$[null span;0N;0|span-pc];lastTs;" +
  "    $[null lastTs;0n;`float$(now-lastTs)%1e9];$[rToday>0;`HEALTHY;`EMPTY]) }[now];" +
  " 0!raze {[f;x] enlist f x}[f] each .Q.pt }[.z.p]";

class LiveHdbReader extends CepReader {
  constructor(opts) {
    super(opts, { scan: LIVE_SCAN });
    this._cache = { at: 0, data: null };
  }

  async read() {
    if (this._cache.data && Date.now() - this._cache.at < TTL_MS) return this._cache.data;

    const raw = await this.session.sync(LIVE_SCAN, { timeoutMs: this.opts.timeoutMs });
    const rows = toRows(raw).rows || [];

    const tables = rows
      .map((x) => ({
        tab: x.tab,
        kind: "hdb",
        role: null,
        status: x.status || null,
        rowsTotal: n(x.rowsTotal),
        rowsToday: n(x.rowsToday),
        partitionCnt: n(x.partitionCnt) || 0,
        missingDays: n(x.missingDays),
        oldestDate: day(x.oldestDate),
        newestDate: day(x.newestDate),
        spanDays: n(x.spanDays),
        firstTime: null,
        lastTime: iso(x.lastTs),
        ageSec: n(x.ageSec),
        // archive-only columns the page also reads - null so it degrades cleanly
        bytesArchive: null,
        bytesToday: null,
        scannedDays: 0,
        emptyDays: 0,
        healthyDays: 0,
        coveragePct: null,
        scanTs: null,
      }))
      .sort((a, b) => (b.rowsTotal || 0) - (a.rowsTotal || 0));

    const oldest = tables.map((t) => t.oldestDate).filter(Boolean).sort()[0] || null;
    const newest = tables.map((t) => t.newestDate).filter(Boolean).sort().slice(-1)[0] || null;
    const now = new Date().toISOString();

    const data = {
      connected: this.connected,
      target: this.target,
      live: true,
      scanTs: now,
      cachedAt: now,
      tables,
      monthly: [],
      recent: [],
      totals: {
        tables: tables.length,
        bar: 0,
        tick: 0,
        rowsTotal: tables.reduce((a, t) => a + (t.rowsTotal || 0), 0),
        bytesArchive: null,
        emptyLatest: tables.filter((t) => t.status === "EMPTY").length,
        healthyLatest: tables.filter((t) => t.status === "HEALTHY").length,
        oldestDate: oldest,
        newestDate: newest,
        spanDays:
          oldest && newest ? Math.round((Date.parse(newest) - Date.parse(oldest)) / DAY_MS) + 1 : null,
      },
    };
    this._cache = { at: Date.now(), data };
    return data;
  }

  status() {
    return { ...super.status(), cachedAt: this._cache.data ? this._cache.data.cachedAt : null };
  }
}

// --- manager: one reader per configured source, dispatched by ?source= ----
class HdbHealthManager {
  constructor(cfg) {
    this.defaultSource = cfg.defaultSource;
    this.readers = new Map();
    this.meta = [];
    for (const s of cfg.sources) {
      const opts = { host: s.host, port: s.port, timeoutMs: cfg.timeoutMs };
      this.readers.set(s.name, s.kind === "archive" ? new HdbHealthReader(opts) : new LiveHdbReader(opts));
      this.meta.push({ name: s.name, kind: s.kind, target: `${s.host}:${s.port}` });
    }
  }

  start() {
    for (const r of this.readers.values()) r.start();
    // warm the default source so the first page hit isn't a cold scan
    const d = this.readers.get(this.defaultSource);
    if (d) d.read().catch(() => {});
  }

  async stop() {
    await Promise.all([...this.readers.values()].map((r) => r.stop()));
  }

  status() {
    return {
      enabled: true,
      defaultSource: this.defaultSource,
      sources: this.meta.map((m) => ({ ...m, connected: this.readers.get(m.name).connected })),
    };
  }

  async read(name) {
    const key = name && this.readers.has(name) ? name : this.defaultSource;
    const r = this.readers.get(key);
    if (!r) {
      const e = new Error(`unknown hdb health source: ${name} (have: ${[...this.readers.keys()].join(", ")})`);
      e.statusCode = 400;
      throw e;
    }
    const data = await r.read();
    return { ...data, source: key, sources: this.meta };
  }
}

module.exports = { HdbHealthReader, LiveHdbReader, HdbHealthManager };
