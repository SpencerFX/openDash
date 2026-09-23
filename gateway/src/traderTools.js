"use strict";

const { QGateway } = require("./qGateway");
const { toRows } = require("./qshape");

// Per-account trade analytics ("Trader Tools" page): one signalId in, its
// whole trade history profiled - equity curve, drawdown, holding-period/
// instrument mix, time-of-day/week pattern, martingale ratio, first-half
// vs second-half persistence. Routed through retailR_gw (same process/
// port as brokerTech - see config.js's traderToolsGwAddr) rather than
// connecting straight to retailR_hdb, same benchmarking/visibility
// rationale as brokerTech/econCal: a pure batch analytics HDB, no live
// feed, no RDB leg ever.
//
// Query logic lives server-side as .oq.tt.api.report/.oq.tt.api.roster
// (modules/analytics/traderTools/api.q, loaded on retailR_hdb only),
// dispatched through openQ's .oq.gw.tt* (core/gw.q) via QGateway below -
// same one-.oq.gw.*-per-server-function pattern as every brk* call.
//
// Two independent cache/in-flight maps (report keyed on signalId+
// lookbackDays, roster keyed on lookbackDays+minTrades+topN) - same
// per-page-own-cache convention as brokerTech.js's dozen methods.

const num = (v) => (v == null || Number.isNaN(v) ? null : Number(v));
const dstr = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10);

class TraderToolsReader {
  constructor(opts) {
    this.enabled = opts.enabled !== false;
    this.defaults = {
      lookbackDays: opts.lookbackDays || 365,
      minTrades: opts.minTrades || 10,
      topN: opts.topN || 200,
    };
    this.ttlMs = Math.max(5000, opts.ttlMs || 60000);
    this.timeoutMs = Math.max(5000, opts.timeoutMs || 45000);
    this.gateway = new QGateway({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      poolSize: Math.max(1, opts.poolSize || 2),
      queryTimeoutMs: this.timeoutMs,
      useBigInt: opts.useBigInt,
    });
    this._reportCache = new Map(); // key -> { at, data }
    this._reportInflight = new Map(); // key -> Promise
    this._rosterCache = new Map(); // key -> { at, data }
    this._rosterInflight = new Map(); // key -> Promise
  }

  start() {
    this.gateway.start();
    return this;
  }
  async stop() {
    await this.gateway.stop();
  }
  get connected() {
    return this.gateway.readyCount() > 0;
  }

  status() {
    return {
      enabled: this.enabled,
      target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
      connected: this.connected,
      gw: this.gateway.status(),
    };
  }

  _requireUp() {
    if (!this.connected) {
      const e = new Error(
        `retailR_gw not reachable at ${this.gateway.opts.host}:${this.gateway.opts.port} - start it ` +
          `(scripts/startStop/startupAllByModule.sh retailR) with modules/analytics/traderTools/` +
          `{traderTools,api}.q in its hdb.json libraries`
      );
      e.statusCode = 503;
      throw e;
    }
  }

  _clampReport(q) {
    const signalId = Math.trunc(Number(q.signalId));
    if (!Number.isFinite(signalId)) {
      const e = new Error("signalId is required and must be a number");
      e.statusCode = 400;
      throw e;
    }
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return { signalId, lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000) };
  }

  _clampRoster(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return {
      lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000),
      minTrades: i(q.minTrades, this.defaults.minTrades, 0, 10000),
      topN: i(q.top, this.defaults.topN, 5, 2000),
    };
  }

  _rows(tbl) {
    return (toRows(tbl).rows || []).map((r) => {
      const o = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v;
      }
      return o;
    });
  }

  // a q dict comes back as a plain object of scalars/arrays; normalise Dates/bigint
  _dict(d) {
    if (!d || typeof d !== "object") return {};
    const o = {};
    for (const k of Object.keys(d)) {
      const v = d[k];
      o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v;
    }
    return o;
  }

  // Single-account dashboard page (.oq.tt.api.report).
  async report(query = {}) {
    if (!this.enabled) {
      const e = new Error("traderTools disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampReport(query);
    const key = `${p.signalId}|${p.lookbackDays}`;

    const hit = this._reportCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._reportInflight.has(key)) return this._reportInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.ttReport(p.signalId, p.lookbackDays);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const dd = d.drawdown || {};

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          signalId: num(meta.signalId),
          platform: meta.platform == null ? null : String(meta.platform),
          acctId: num(meta.acctId),
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          lookbackDays: num(meta.lookbackDays),
          nTradeRows: num(meta.nTradeRows),
        },
        summary: this._dict(d.summary),
        equityCurve: this._rows(d.equityCurve),
        drawdown: {
          series: this._rows(dd.series),
          maxDrawdown: num(dd.maxDrawdown),
          currentDrawdown: num(dd.currentDrawdown),
        },
        styleBreakdown: this._rows(d.styleBreakdown).map((r) => ({
          ...r,
          style: r.style == null ? null : String(r.style),
        })),
        symbolBreakdown: this._rows(d.symbolBreakdown).map((r) => ({
          ...r,
          symbol: r.symbol == null ? null : String(r.symbol),
        })),
        hourOfDay: this._rows(d.hourOfDay),
        dayOfWeek: this._rows(d.dayOfWeek).map((r) => ({
          ...r,
          dow: r.dow == null ? null : String(r.dow),
        })),
        martingale: this._dict(d.martingale),
        persistence: this._dict(d.persistence),
      };

      this._reportCache.set(key, { at: Date.now(), data });
      if (this._reportCache.size > 64) {
        const oldest = [...this._reportCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._reportCache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._reportInflight.delete(key));

    this._reportInflight.set(key, job);
    return job;
  }

  // Account picker roster (.oq.tt.api.roster) - always the full unfiltered
  // population for the window, independent of which account is selected.
  async roster(query = {}) {
    if (!this.enabled) {
      const e = new Error("traderTools disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampRoster(query);
    const key = `${p.lookbackDays}|${p.minTrades}|${p.topN}`;

    const hit = this._rosterCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._rosterInflight.has(key)) return this._rosterInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.ttRoster(p.lookbackDays, p.minTrades, p.topN);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          lookbackDays: num(meta.lookbackDays),
          minTrades: num(meta.minTrades),
          nAccounts: num(meta.nAccounts),
        },
        accounts: this._rows(d.accounts).map((r) => ({
          ...r,
          platform: r.platform == null ? null : String(r.platform),
        })),
      };

      this._rosterCache.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => this._rosterInflight.delete(key));

    this._rosterInflight.set(key, job);
    return job;
  }
}

module.exports = { TraderToolsReader };
