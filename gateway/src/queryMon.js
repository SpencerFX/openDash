"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// Query-behaviour monitor. openQ's core/utils/gateway.q keeps every query it
// ever routed in `.util.gw.queue` (a keyed in-memory table - finished rows
// keep `returned`/`took`/`error`/`discard`), plus per-backend-handle counters
// in `.util.gw.servers`. This reader pulls a snapshot + rollups off each
// configured gateway process (gw0, mon_gw) and the System > Query Mon page
// renders it. Read-only: one select, no state touched.

// nRecent newest queries, nSlow slowest completed, winMin latency window,
// histMin per-minute history depth.
const SNAP = (nRecent, nSlow, winMin, histMin) => `
{[nRecent;nSlow;winMin;histMin]
  if[not \`queue in key \`.util.gw; :\`hasGw\`err!(0b;"no .util.gw.queue on this process")];
  now:.z.p;
  span:{\`timespan$1000000000*60*x};
  qq:0!.util.gw.queue;
  qq:update qtable:{$[1<count x; $[-11h=type x 1; x 1; \`?]; \`?]} each query from qq;
  done:select from qq where not null returned;
  win:select from done where returned > now - span winMin;
  tk:asc \`float\$(exec took from \$[count win; win; (neg 200) sublist done])%1000000;
  prc:{[v;p] \$[count v; v[(count[v]-1) & floor p*count v]; 0n]};
  recent:select queryID, sinceSec:\`float\$(now-time)%1000000000, serverType,
      qtable, tookMs:\`float\$took%1000000, error, discard, pending:null returned
    from nRecent sublist \`time xdesc qq;
  slowest:select queryID, sinceSec:\`float\$(now-time)%1000000000, serverType,
      qtable, tookMs:\`float\$took%1000000, error, discard, pending:0b
    from nSlow sublist \`took xdesc done;
  byType:0!select n:count i, avgMs:\`float\$avg took%1000000, maxMs:\`float\$max took%1000000,
      errs:sum error by serverType from done;
  servers:0!select serverType, inuse, active, querycount,
      lastAgoSec:\`float\$(now-lastquery)%1000000000, usageMs:\`float\$usage%1000000
    from .util.gw.servers;
  series:0!select n:count i, avgMs:\`float\$avg took%1000000, errs:sum error
      by minute:(\`long\$0D00:01) xbar returned from done where returned > now - span histMin;
  (\`hasGw\`totalQueries\`queued\`doneCnt\`errCnt\`discardCnt\`winCnt\`winMin\`histMin,
   \`p50Ms\`p95Ms\`p99Ms\`maxMs\`avgMs\`byType\`servers\`recent\`slowest\`series) ! (
    1b;
    .util.gw.ID;
    count select from qq where null returned, not discard;
    count done;
    \`long\$sum done\`error;
    \`long\$sum qq\`discard;
    count win;
    winMin; histMin;
    prc[tk;0.5]; prc[tk;0.95]; prc[tk;0.99];
    \$[count tk; last tk; 0n]; \$[count tk; avg tk; 0n];
    byType; servers; recent; slowest; series)
 }[${nRecent};${nSlow};${winMin};${histMin}]`;

const num = (v) => (v == null || Number.isNaN(v) ? null : Number(v));
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

class QueryMonReader {
  constructor(cfg) {
    this.enabled = cfg.enabled !== false;
    this.recent = cfg.recent || 40;
    this.slow = cfg.slow || 15;
    this.winMin = cfg.winMin || 5;
    this.histMin = cfg.histMin || 30;
    this.timeoutMs = Math.max(2000, cfg.timeoutMs || 6000);
    // one reconnecting session per gateway target (main = gw0, mon = mon_gw)
    this.targets = Object.entries(cfg.targets || {}).map(([name, t]) => ({
      name,
      session: new QSession({
        host: t.host, port: t.port, user: t.user, password: t.password,
        timeoutMs: this.timeoutMs, reconnectMs: 2000, label: `querymon:${name}`,
      }),
    }));
  }

  start() { for (const t of this.targets) t.session.start(); return this; }
  async stop() { await Promise.all(this.targets.map((t) => t.session.stop())); }

  status() {
    return {
      enabled: this.enabled,
      targets: this.targets.map((t) => ({ name: t.name, target: t.session.target, connected: t.session.connected })),
    };
  }

  _shapeRows(tbl) {
    const rows = (toRows(tbl).rows || []).map((r) => {
      const o = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v;
      }
      return o;
    });
    return rows;
  }

  async _one(t) {
    const base = { name: t.name, target: t.session.target };
    if (!t.session.connected) return { ...base, connected: false, hasGw: false, error: "not connected" };
    let d;
    try {
      d = await t.session.sync(SNAP(this.recent, this.slow, this.winMin, this.histMin), { timeoutMs: this.timeoutMs });
    } catch (e) {
      return { ...base, connected: true, hasGw: false, error: e.message || String(e) };
    }
    if (!d || d.hasGw === false || !d.hasGw) {
      return { ...base, connected: true, hasGw: false, error: (d && d.err) || "no .util.gw.queue" };
    }
    return {
      ...base,
      connected: true,
      hasGw: true,
      totalQueries: num(d.totalQueries),
      queued: num(d.queued),
      doneCnt: num(d.doneCnt),
      errCnt: num(d.errCnt),
      discardCnt: num(d.discardCnt),
      winCnt: num(d.winCnt),
      winMin: num(d.winMin),
      histMin: num(d.histMin),
      latencyMs: {
        p50: num(d.p50Ms), p95: num(d.p95Ms), p99: num(d.p99Ms),
        max: num(d.maxMs), avg: num(d.avgMs),
      },
      qpsWindow: d.winCnt != null && d.winMin ? Number(d.winCnt) / (Number(d.winMin) * 60) : null,
      errRateWindow: d.winCnt ? Number(d.errCnt || 0) / Number(d.winCnt) : 0,
      byType: this._shapeRows(d.byType),
      servers: this._shapeRows(d.servers),
      recent: this._shapeRows(d.recent),
      slowest: this._shapeRows(d.slowest),
      series: this._shapeRows(d.series).map((r) => ({ minute: iso(r.minute), n: num(r.n), avgMs: num(r.avgMs), errs: num(r.errs) })),
    };
  }

  async read() {
    return { enabled: this.enabled, targets: await Promise.all(this.targets.map((t) => this._one(t))) };
  }
}

module.exports = { QueryMonReader };
