"use strict";

const { QGateway } = require("./qGateway");
const { toRows } = require("./qshape");

// Query-behaviour monitor. openQ's core/utils/gateway.q keeps every query it
// ever routed in `.util.gw.queue` (a keyed in-memory table - finished rows
// keep `returned`/`took`/`error`/`errType`/`discard`), plus per-backend-handle
// counters in `.util.gw.servers` and the live per-query fan-out slots in
// `.util.gw.results`. This reader pulls a snapshot + rollups off each configured
// gateway process (gw0, mon_gw) and the System > Query Mon page renders it.
// Read-only: one select, no state touched.
//
// Routed through openQ's own .util.gw.mon (core/utils/gateway.q) rather than
// a plain sync IPC eval of a client-built q-string - the SNAP() template
// this file used to hold now lives server-side, and the poll itself goes
// over the same pooled async request/reply protocol (QGateway) every other
// gw-routed reader (eq/fx OHLC, econCal) uses. Two effects, both requested:
// this reader's own connections are visible/poolable like any other gw
// client, and each poll is itself logged into the polled process's
// .util.gw.queue (tagged serverType `self) - so Query Mon's own traffic
// finally shows up in its own numbers, same benchmarking/visibility
// rationale as the econCal migration. .util.gw.mon can't use
// .util.gw.asyncExec's backend fan-out the way .oq.gw.query/symRoster/
// econCal do (there's no backend for "this process's own local state" -
// see its own header in gateway.q), so it self-answers directly instead.
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
    // one pooled async QGateway per watched target (main = gw0, mon = mon_gw,
    // plus every module HDB/gw configured in queryMonTargets) - same wire
    // protocol as eqOhlc.js/calendar.js's readers, not a bespoke sync session.
    this.targets = Object.entries(cfg.targets || {}).map(([name, t]) => ({
      name,
      gateway: new QGateway({
        host: t.host, port: t.port, user: t.user, password: t.password,
        poolSize: Math.max(1, t.poolSize || 2),
        queryTimeoutMs: this.timeoutMs,
        useBigInt: t.useBigInt,
      }),
    }));
  }

  start() { for (const t of this.targets) t.gateway.start(); return this; }
  async stop() { await Promise.all(this.targets.map((t) => t.gateway.stop())); }

  status() {
    return {
      enabled: this.enabled,
      targets: this.targets.map((t) => ({
        name: t.name,
        target: `${t.gateway.opts.host}:${t.gateway.opts.port}`,
        connected: t.gateway.readyCount() > 0,
      })),
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
    const base = { name: t.name, target: `${t.gateway.opts.host}:${t.gateway.opts.port}` };
    if (t.gateway.readyCount() === 0) return { ...base, connected: false, hasGw: false, error: "not connected" };
    let d;
    try {
      ({ data: d } = await t.gateway.mon(this.recent, this.slow, this.winMin, this.histMin));
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
