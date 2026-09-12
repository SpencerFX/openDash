"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// Query-behaviour monitor. openQ's core/utils/gateway.q keeps every query it
// ever routed in `.util.gw.queue` (a keyed in-memory table - finished rows
// keep `returned`/`took`/`error`/`errType`/`discard`), plus per-backend-handle
// counters in `.util.gw.servers` and the live per-query fan-out slots in
// `.util.gw.results`. This reader pulls a snapshot + rollups off each configured
// gateway process (gw0, mon_gw) and the System > Query Mon page renders it.
// Read-only: one select, no state touched.
//
// Signals beyond the raw counts:
//   - queue wait time (submitted-time): time a query sat queued before dispatch
//     - the backpressure metric, distinct from took (submitted->returned = exec)
//   - waiting vs dispatched: count .util.gw.results is exactly the set mid-fan-out
//   - error breakdown by class: .util.gw.queue.errType (timeout/backend/sizecap/
//     join/disconnect). Against a gateway still on the pre-errType gateway.q the
//     column is absent - fall back to a timeout-vs-execution split from timing.
//   - per-backend windowed utilisation: querycount/usage are since-start totals;
//     the reader diffs successive snapshots (asOf) into q/s + busy% per handle.
//   - active vs registered per serverType: srvSummary (removeServer flips active).
//   - backlog time series: open-query depth reconstructed per minute over histMin.
//   - per-client load + single- vs fan-out-target split.

// nRecent newest queries, nSlow slowest completed, winMin latency window,
// histMin per-minute history depth.
const SNAP = (nRecent, nSlow, winMin, histMin) => `
{[nRecent;nSlow;winMin;histMin]
  if[not \`queue in key \`.util.gw; :\`hasGw\`err!(0b;"no .util.gw.queue on this process")];
  now:.z.p;
  span:{\`timespan\$1000000000*60*x};
  hasET:\`errType in cols .util.gw.queue;
  qq:0!.util.gw.queue;
  qq:update qtable:{\$[1<count x; \$[-11h=type x 1; x 1; \`?]; \`?]} each query from qq;
  done:select from qq where not null returned;
  win:select from done where returned > now - span winMin;
  wsrc:\$[count win; win; (neg 200) sublist done];
  tk:asc \`float\$(exec took from wsrc)%1000000;
  wt:asc \`float\$(exec (submitted-time) from wsrc where not null submitted)%1000000;
  prc:{[v;p] \$[count v; v[(count[v]-1) & floor p*count v]; 0n]};
  recent:select queryID, sinceSec:\`float\$(now-time)%1000000000, serverType,
      qtable, tookMs:\`float\$took%1000000, error, discard, pending:null returned
    from nRecent sublist \`time xdesc qq;
  slowest:select queryID, sinceSec:\`float\$(now-time)%1000000000, serverType,
      qtable, tookMs:\`float\$took%1000000, error, discard, pending:0b
    from nSlow sublist \`took xdesc done;
  byType:0!select n:count i, avgMs:\`float\$avg took%1000000, maxMs:\`float\$max took%1000000,
      errs:sum error by serverType from done;
  servers:0!select handle, serverType, inuse, active, querycount,
      lastAgoSec:\`float\$(now-lastquery)%1000000000, usageMs:\`float\$usage%1000000
    from .util.gw.servers;
  srvSummary:0!select regd:count i, active:\`long\$sum active, inuse:\`long\$sum inuse
    by serverType from .util.gw.servers;
  series:0!select n:count i, avgMs:\`float\$avg took%1000000, errs:sum error
      by minute:(\`long\$0D00:01) xbar returned from done where returned > now - span histMin;
  edges:((\`long\$0D00:01) xbar now - span histMin) + span each 1+til histMin;
  qcand:select time, returned from qq where (null returned) | returned > now - span histMin;
  backlog:([] minute:edges;
    depth:\`long\$\{[q;m] count select from q where time<=m,(null returned)|returned>m\}[qcand] each edges);
  errRows:select from done where error;
  errRows:\$[hasET; errRows;
    update errType:?[(not timeout=0Wn) & (returned-time) >= timeout; \`timeout; \`execution] from errRows];
  errByClass:0!select cnt:count i by errType from errRows;
  byClient:10 sublist \`n xdesc 0!select n:count i, inflight:\`long\$sum null returned,
      errs:\`long\$sum error, avgMs:\`float\$avg took%1000000,
      lastAgoSec:\`float\$(now-max time)%1000000000 by clientH from qq;
  fanoutSplit:0!select n:count i, avgMs:\`float\$avg took%1000000, maxMs:\`float\$max took%1000000,
      errs:\`long\$sum error by fanout:1<count each serverType from done;
  (\`hasGw\`totalQueries\`queued\`waitingCnt\`dispatchedCnt\`doneCnt\`errCnt\`discardCnt\`winCnt\`winMin\`histMin,
   \`p50Ms\`p95Ms\`p99Ms\`maxMs\`avgMs\`samplesMs,
   \`waitP50Ms\`waitP95Ms\`waitP99Ms\`waitMaxMs\`waitAvgMs\`waitSamplesMs,
   \`byType\`servers\`srvSummary\`recent\`slowest\`series\`backlog\`errByClass\`byClient\`fanoutSplit\`asOf\`hasErrType) ! (
    1b;
    .util.gw.ID;
    count select from qq where null returned, not discard;
    count select from qq where null submitted, null returned, not discard;
    count .util.gw.results;
    count done;
    \`long\$sum done\`error;
    \`long\$sum qq\`discard;
    count win;
    winMin; histMin;
    prc[tk;0.5]; prc[tk;0.95]; prc[tk;0.99];
    \$[count tk; last tk; 0n]; \$[count tk; avg tk; 0n];
    tk;
    prc[wt;0.5]; prc[wt;0.95]; prc[wt;0.99];
    \$[count wt; last wt; 0n]; \$[count wt; avg wt; 0n];
    wt;
    byType; servers; srvSummary; recent; slowest; series; backlog; errByClass; byClient; fanoutSplit;
    now; hasET)
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
    // previous servers snapshot per target: querycount / usage are since-start
    // cumulative totals, so per-backend q/s + busy% need diffing two snapshots.
    // name -> { asOfMs, byHandle: Map(handle -> { querycount, usageMs }) }
    this._prevServers = new Map();
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

    // per-backend windowed utilisation: diff this servers snapshot against the
    // previous one for this target. First poll (or after a reconnect / handle
    // set change) has no baseline -> qpsWin / busyPct come back null.
    const asOfMs = d.asOf instanceof Date ? d.asOf.getTime() : Date.parse(iso(d.asOf)) || null;
    const prev = this._prevServers.get(t.name);
    const servers = this._shapeRows(d.servers).map((s) => {
      const p = prev && prev.byHandle.get(s.handle);
      let qpsWin = null, busyPct = null;
      if (p && asOfMs && prev.asOfMs && asOfMs > prev.asOfMs) {
        const dtSec = (asOfMs - prev.asOfMs) / 1000;
        const dq = Number(s.querycount) - p.querycount;
        const du = Number(s.usageMs) - p.usageMs;
        if (dtSec > 0) {
          if (dq >= 0) qpsWin = dq / dtSec;
          if (du >= 0) busyPct = Math.min(1, du / (dtSec * 1000));
        }
      }
      return { ...s, qpsWin, busyPct };
    });
    if (asOfMs) {
      const byHandle = new Map();
      for (const s of servers) byHandle.set(s.handle, { querycount: Number(s.querycount) || 0, usageMs: Number(s.usageMs) || 0 });
      this._prevServers.set(t.name, { asOfMs, byHandle });
    }

    return {
      ...base,
      connected: true,
      hasGw: true,
      totalQueries: num(d.totalQueries),
      queued: num(d.queued),
      waitingCnt: num(d.waitingCnt),
      dispatchedCnt: num(d.dispatchedCnt),
      doneCnt: num(d.doneCnt),
      errCnt: num(d.errCnt),
      discardCnt: num(d.discardCnt),
      winCnt: num(d.winCnt),
      winMin: num(d.winMin),
      histMin: num(d.histMin),
      hasErrType: !!d.hasErrType,
      latencyMs: {
        p50: num(d.p50Ms), p95: num(d.p95Ms), p99: num(d.p99Ms),
        max: num(d.maxMs), avg: num(d.avgMs),
      },
      // queue wait = submitted - time: how long a query sat queued before it
      // was dispatched to a backend. The backpressure metric (took is exec).
      waitMs: {
        p50: num(d.waitP50Ms), p95: num(d.waitP95Ms), p99: num(d.waitP99Ms),
        max: num(d.waitMaxMs), avg: num(d.waitAvgMs),
      },
      // sorted latency sample vector (<=200 most-recent completed, ms) - lets
      // the "all" view pool real percentiles across gateways instead of
      // averaging per-gateway pXX
      samplesMs: Array.from(d.samplesMs || []).map(Number).filter((x) => Number.isFinite(x)),
      waitSamplesMs: Array.from(d.waitSamplesMs || []).map(Number).filter((x) => Number.isFinite(x)),
      qpsWindow: d.winCnt != null && d.winMin ? Number(d.winCnt) / (Number(d.winMin) * 60) : null,
      errRateWindow: d.winCnt ? Number(d.errCnt || 0) / Number(d.winCnt) : 0,
      byType: this._shapeRows(d.byType),
      servers,
      srvSummary: this._shapeRows(d.srvSummary),
      recent: this._shapeRows(d.recent),
      slowest: this._shapeRows(d.slowest),
      series: this._shapeRows(d.series).map((r) => ({ minute: iso(r.minute), n: num(r.n), avgMs: num(r.avgMs), errs: num(r.errs) })),
      backlog: this._shapeRows(d.backlog).map((r) => ({ minute: iso(r.minute), depth: num(r.depth) })),
      errByClass: this._shapeRows(d.errByClass).map((r) => ({ errType: String(r.errType ?? "?"), cnt: num(r.cnt) })),
      byClient: this._shapeRows(d.byClient),
      fanoutSplit: this._shapeRows(d.fanoutSplit).map((r) => ({
        fanout: !!r.fanout, n: num(r.n), avgMs: num(r.avgMs), maxMs: num(r.maxMs), errs: num(r.errs),
      })),
    };
  }

  async read() {
    return { enabled: this.enabled, targets: await Promise.all(this.targets.map((t) => this._one(t))) };
  }
}

module.exports = { QueryMonReader };
