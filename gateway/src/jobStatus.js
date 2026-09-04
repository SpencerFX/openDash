"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// System > Job Status: the mon module's `jobStatus` table
// (schemas/schema_mon.q), fed by modules/mon/jobStatus.q's
// .mon.job.start / .mon.job.end - two rows per job run (RUNNING at start,
// SUCCESS / FAILED at end), each carrying jobName, the publishing
// process's -name (sym), start/end/duration.
//
// "Realtime" = the mon RDB pair (cfg_proc/modules/mon/rdb.json,
// -port1 5021 / -port2 5101; mon_idb pivots which is subscribed every
// ~2 min, so query BOTH and union). "Historical" = the mon HDB
// (127.0.0.1:5023) - older partitions of the same table. The mon HDB
// root C:/data/db1/mon is shared with the table-health archive, so
// `jobStatus` may be absent from older partitions; the query is guarded
// (skip if the table isn't registered) and anchors "latest date" on
// `exec max date from select date from jobStatus` (real rows only), not
// `max date` (which after core/hdb.q's .Q.chk can land on an empty stub).
//
// jobStatus is a tiny table (a couple of rows per job run per day), so
// an unbounded RDB select and an N-day HDB select are both cheap - no
// need for the aggregation gymnastics /api/pidstats does.

const COLS = "timestamp,sym,jobName,startTime,endTime,duration,status";
const EMPTY_T =
  "0#([]timestamp:`timestamp$();sym:`symbol$();jobName:`symbol$();" +
  "startTime:`timestamp$();endTime:`timestamp$();duration:`timespan$();status:`symbol$())";

// modules/mon/jobStatus.q's .mon.job.* only ever emits RUNNING (start) or
// SUCCESS / FAILED (end). Any other status is not a real job row - most
// often the schema-blind generator (modules/utils/generator/generator.q,
// left on by a startupAllWithGen run) publishing random `symbol$ values
// into every schema_mon.q table, jobStatus included. Whitelisting the
// three real statuses drops that noise wherever it lands (RDB, or an EOD
// that promoted staged generator rows into an HDB partition) and can
// never hide a genuine run. The HDB "latest date" anchor is over real
// rows too, so a noise-only partition doesn't pull the lookback window.
const REAL = "status in `RUNNING`SUCCESS`FAILED";

const RDB_Q = `0!select ${COLS} from jobStatus where ${REAL}`;
const histQ = (days) =>
  `{[n] $[not \`jobStatus in tables[]; ${EMPTY_T};` +
  ` [d0:@[{exec max date from select date from jobStatus where ${REAL}};\`;0Nd];` +
  `  $[null d0; ${EMPTY_T};` +
  `   0!select ${COLS} from jobStatus where date within (d0-n; d0), ${REAL}]]]}[${days}]`;

// The mon RDB retains jobStatus only until mon_idb's next pivot-and-harvest
// (~15 min), and mon_hdb doesn't get it until the daily mon EOD promote -
// so a job that ran this morning is invisible to both for most of the day.
// mon_idb stages every harvested segment as a numbered splay under
// .oq.idb.root; read the `jobStatus` splay out of each so an in-flight run
// (RUNNING now, or ended-but-not-yet-promoted) still shows. Guarded: no
// .oq.idb / no segments / no splay in a segment -> empty, never an error.
const IDB_Q =
  `$[not \`idb in key \`.oq; ${EMPTY_T};` +
  ` [root:.oq.idb.root; sd:string key root; segs:\`$sd where sd like "[0-9]*";` +
  `  $[0=count segs; ${EMPTY_T};` +
  `   0!raze {[root;s] p:.Q.dd[.Q.dd[root;s];\`jobStatus];` +
  `     $[count key p;` +
  `       @[{select ${COLS} from (get x) where ${REAL}};p;{[e] ${EMPTY_T}}];` +
  `       ${EMPTY_T}]}[root] each segs]]]`;

const toMs = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};
// q timespan → ms. qshape's jsonSafe turns a bigint into a decimal STRING of
// nanoseconds; it may also arrive as a number (ns) or a Date-ish string.
// `endTime - startTime` (both unambiguous ISO timestamps) is preferred in
// read() where available - this only has to cover the odd RUNNING-row or a
// row with no endTime.
const spanMs = (v) => {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v) / 1e6;
  if (typeof v === "number") return Number.isFinite(v) ? v / 1e6 : null; // ns
  if (typeof v === "string") {
    if (/^-?\d+$/.test(v)) return Number(v) / 1e6; // ns integer string
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  return null;
};

class JobStatusReader {
  constructor(opts) {
    this.histDays = Math.max(1, Math.min(120, opts.histDays || 14));
    const eps =
      opts.endpoints && opts.endpoints.length ? opts.endpoints : [{ host: opts.host || "127.0.0.1", port: opts.port || 5021 }];
    this.rdb = eps.map(
      (e, i) =>
        new QSession({ host: e.host, port: e.port, timeoutMs: opts.timeoutMs || 8000, reconnectMs: 2000, label: `jobstatus-rdb${i + 1}` })
    );
    this.hdb = opts.hdb
      ? new QSession({ host: opts.hdb.host, port: opts.hdb.port, timeoutMs: opts.timeoutMs || 15000, reconnectMs: 3000, label: "jobstatus-hdb" })
      : null;
    this.idb = opts.idb
      ? new QSession({ host: opts.idb.host, port: opts.idb.port, timeoutMs: opts.timeoutMs || 8000, reconnectMs: 3000, label: "jobstatus-idb" })
      : null;
  }

  start() {
    for (const s of this.rdb) s.start();
    if (this.hdb) this.hdb.start();
    if (this.idb) this.idb.start();
    return this;
  }
  async stop() {
    await Promise.all([
      ...this.rdb.map((s) => s.stop()),
      this.hdb ? this.hdb.stop() : Promise.resolve(),
      this.idb ? this.idb.stop() : Promise.resolve(),
    ]);
  }
  get connected() {
    return this.rdb.some((s) => s.connected) || (this.hdb && this.hdb.connected) || (this.idb && this.idb.connected);
  }
  status() {
    return {
      enabled: true,
      rdb: this.rdb.map((s) => ({ target: s.target, connected: s.connected })),
      hdb: this.hdb ? { target: this.hdb.target, connected: this.hdb.connected } : null,
      idb: this.idb ? { target: this.idb.target, connected: this.idb.connected } : null,
      histDays: this.histDays,
    };
  }

  async read(daysRaw) {
    const days = Math.max(1, Math.min(120, Math.trunc(Number(daysRaw) || this.histDays)));
    if (!this.connected) {
      const e = new Error(
        `no mon process reachable (rdb ${this.rdb.map((s) => s.target).join(", ")}${this.hdb ? `, hdb ${this.hdb.target}` : ""}) - start the "mon" module`
      );
      e.statusCode = 503;
      throw e;
    }

    const jobs = [
      ...this.rdb.map((s) =>
        s.connected ? s.sync(RDB_Q, { timeoutMs: s.timeoutMs }).then((r) => toRows(r).rows || [], () => []) : Promise.resolve([])
      ),
      this.hdb && this.hdb.connected
        ? this.hdb.sync(histQ(days), { timeoutMs: this.hdb.timeoutMs }).then((r) => toRows(r).rows || [], () => [])
        : Promise.resolve([]),
      this.idb && this.idb.connected
        ? this.idb.sync(IDB_Q, { timeoutMs: this.idb.timeoutMs }).then((r) => toRows(r).rows || [], () => [])
        : Promise.resolve([]),
    ];
    const parts = await Promise.all(jobs);

    // union + dedup (a row can be on both an RDB instance and the HDB)
    const seen = new Set();
    let rows = [];
    for (const part of parts) {
      for (const r of part) {
        const k = `${r.sym}|${r.jobName}|${r.startTime}|${r.status}|${r.timestamp}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({
          timestamp: toMs(r.timestamp),
          sym: r.sym == null ? null : String(r.sym),
          jobName: r.jobName == null ? null : String(r.jobName),
          startTime: toMs(r.startTime),
          endTime: toMs(r.endTime),
          durationMs: spanMs(r.duration),
          status: r.status == null ? null : String(r.status),
        });
      }
    }
    rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // one record per run = (sym, jobName, startTime); the row with the
    // latest event timestamp is the authoritative state (an end row
    // supersedes its start row)
    const byRun = new Map();
    for (const r of rows) {
      const k = `${r.sym}|${r.jobName}|${r.startTime}`;
      const cur = byRun.get(k);
      if (!cur || (r.timestamp || 0) >= (cur.timestamp || 0)) {
        byRun.set(k, { ...(cur || {}), ...r, firstSeen: Math.min(cur?.firstSeen ?? Infinity, r.timestamp || Infinity) });
      }
    }
    const runs = [...byRun.values()]
      .map((r) => ({
        sym: r.sym,
        jobName: r.jobName,
        startTime: r.startTime,
        endTime: r.endTime,
        // prefer the timestamp delta (both unambiguous) over the raw
        // timespan column, which qshape may hand back as a ns string
        durationMs:
          r.endTime != null && r.startTime != null ? r.endTime - r.startTime : r.durationMs != null ? r.durationMs : null,
        status: r.status,
        live: r.status === "RUNNING",
      }))
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

    const running = runs
      .filter((r) => r.live)
      .map((r) => ({ ...r, elapsedMs: r.startTime ? Date.now() - r.startTime : null }));

    const done = runs.filter((r) => !r.live && (r.status === "SUCCESS" || r.status === "FAILED"));
    const dur = done.filter((r) => r.durationMs != null).map((r) => r.durationMs).sort((a, b) => a - b);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const last24 = runs.filter((r) => (r.startTime || 0) >= cutoff);

    const summary = {
      runs: runs.length,
      jobs: new Set(runs.map((r) => r.jobName)).size,
      procs: new Set(runs.map((r) => r.sym)).size,
      running: running.length,
      success: done.filter((r) => r.status === "SUCCESS").length,
      failed: done.filter((r) => r.status === "FAILED").length,
      successRate: done.length ? done.filter((r) => r.status === "SUCCESS").length / done.length : null,
      avgDurationMs: dur.length ? dur.reduce((a, b) => a + b, 0) / dur.length : null,
      p95DurationMs: dur.length ? dur[Math.min(dur.length - 1, Math.floor(dur.length * 0.95))] : null,
      maxDurationMs: dur.length ? dur[dur.length - 1] : null,
      last24h: {
        runs: last24.length,
        success: last24.filter((r) => r.status === "SUCCESS").length,
        failed: last24.filter((r) => r.status === "FAILED").length,
        running: last24.filter((r) => r.live).length,
      },
    };

    return {
      connected: true,
      days,
      rdbConnected: this.rdb.some((s) => s.connected),
      hdbConnected: !!(this.hdb && this.hdb.connected),
      idbConnected: !!(this.idb && this.idb.connected),
      endpoints: {
        rdb: this.rdb.map((s) => ({ target: s.target, connected: s.connected })),
        hdb: this.hdb ? { target: this.hdb.target, connected: this.hdb.connected } : null,
        idb: this.idb ? { target: this.idb.target, connected: this.idb.connected } : null,
      },
      count: rows.length,
      rows,
      runs,
      running,
      summary,
    };
  }
}

module.exports = { JobStatusReader };
