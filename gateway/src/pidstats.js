"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// Live per-process CPU / memory samples for the System > Processes page.
//
// Read straight off the mon module's RDB pair with a plain select - NOT
// through mon_gw. mon_gw fans to mon_hdb, whose root C:/data/db1/mon is
// shared with the table-health archive and carries ~1.1M `pidstats` rows in
// its most recent daily partition; an unbounded scan there is far too heavy
// for a 3s poll, and openQ's .oq.gw.query can't express "just the latest
// samples". "Current process stats" is inherently RDB territory anyway.
//
// mon's RDB is an active/standby pair (cfg_proc/modules/mon/rdb.json,
// -port1 5021 / -port2 5101); mon_idb pivots which one is subscribed every
// ~2 minutes, so the live rows are on whichever is active *now* and the one
// just harvested sits near-empty. So we query BOTH and union - dedup on
// (host, pid, timestamp), same key the Processes page uses client-side.
// Each endpoint fails soft: one being down/mid-pivot still yields the other.

const COLS =
  "timestamp,sym,host,pid,uid,procType,port,userPct,sysPct,cpuPct,cpuId," +
  "minflt,majflt,vsz,rss,memPct,threads,fdnr,pidstatTime,command";

class PidstatsReader {
  constructor(opts) {
    this.table = opts.table || "pidstats";
    const eps = (opts.endpoints && opts.endpoints.length
      ? opts.endpoints
      : [{ host: opts.host, port: opts.port }]);
    this.sessions = eps.map((e, i) =>
      new QSession({
        host: e.host,
        port: e.port,
        timeoutMs: opts.timeoutMs || 8000,
        reconnectMs: 2000,
        label: `pidstats-rdb${i + 1}`,
      })
    );
  }

  start() {
    for (const s of this.sessions) s.start();
    return this;
  }
  async stop() {
    await Promise.all(this.sessions.map((s) => s.stop()));
  }
  get connected() {
    return this.sessions.some((s) => s.connected);
  }

  status() {
    return {
      enabled: true,
      table: this.table,
      connected: this.connected,
      endpoints: this.sessions.map((s) => ({ target: s.target, connected: s.connected })),
    };
  }

  async read() {
    if (!this.connected) {
      const e = new Error(
        `no mon RDB reachable (${this.sessions.map((s) => s.target).join(", ")}) - start the "mon" module`
      );
      e.statusCode = 503;
      throw e;
    }
    // `0!` guards against a keyed/attributed result; each RDB instance holds
    // today's rows only (no `date` column), so a plain select IS its set.
    const q = `0!select ${COLS} from ${this.table}`;
    const parts = await Promise.all(
      this.sessions.map((s) =>
        s.connected
          ? s.sync(q, { timeoutMs: s.timeoutMs }).then(
              (r) => toRows(r).rows || [],
              () => []
            )
          : Promise.resolve([])
      )
    );

    const seen = new Set();
    const rows = [];
    let columns = null;
    for (const part of parts) {
      for (const r of part) {
        const k = `${r.host}/${r.pid}/${r.timestamp}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push(r);
        if (!columns) columns = Object.keys(r);
      }
    }
    return {
      connected: true,
      endpoints: this.sessions.map((s) => ({ target: s.target, connected: s.connected })),
      columns,
      count: rows.length,
      rows,
    };
  }
}

module.exports = { PidstatsReader };
