"use strict";

const { QGateway } = require("./qGateway");

// Minute-bar OHLCV for the EQ Charts page, read through openQ's own
// rdb+hdb-federating gateway for this ingest module (eq_m1_yfinance_gw,
// default 127.0.0.1:5119 - cfg_proc/modules/yfinance/eq_m1_yfinance/gw.json,
// routing to eq_m1_yfinance_rdb :5061 + eq_m1_yfinance_hdb :5063, hdbroot
// C:/data/db1/eq). One table: `eq_m1_yfinance` (1-minute bars for Asian
// equities - HKEX + Tokyo/Nikkei). Read-only; the tables are loaded by a
// separate ingest pipeline, openQ never writes them.
//
// This used to connect straight to the read-only eq_hdb (:5090, HDB-only -
// no rdb component), which meant the Charts page was blind to today's live
// intraday bars until the next EOD promote. Routing through the module's
// own gw fixes that for free: .oq.gw.query/.oq.gw.symRoster (openQ
// core/gw.q) pick rdb, hdb, or both per the requested time range (see
// .oq.gw.chooseServers) and join the results, so "today so far" now shows
// up immediately. It also means this reader's query activity is visible in
// System > Query Mon (config.js wires eq_m1_yfinance_gw/fx_m1_yfinance_gw
// in as extra queryMon targets) instead of being invisible direct IPC.
//
// Also drives the eFX Charts page in the exact same shape: same reader
// class, pointed at fx_m1_yfinance_gw (cfg_proc/modules/yfinance/
// fx_m1_yfinance/gw.json, default 127.0.0.1:5123) for the `fx_m1_yfinance`
// table (1-minute spot bars, 28 G10 pairs from yfinance). Only the
// target/table and a couple of error-message strings differ - see
// opts.hdbName / opts.startHint.
//
// Two calls:
//   syms()          -> the symbol universe + its exchange, from the
//                      newest partition (cached, symbol picker feeds off it)
//   bars(sym, days) -> that symbol's minute bars over roughly the last
//                      `days` trading days plus everything so far today,
//                      shaped { t, o, h, l, c, v } for the dashboard's
//                      <LwCandles> (same shape as /api/ohlc)
//
// The gw is not always running - start it with
// `scripts/startStop/startupAllByModule.sh eq_m1_yfinance` (eq) or
// `... fx_m1_yfinance` (fx), which bring up that module's whole tp/rdb/hdb/
// idb/gw/housekeeping stack. Every call fails soft with a 503 when it's down.

// Yahoo tickers: digits + letters + '.' + '-' (e.g. 0005.HK, 7203.T,
// BRK-B) - qlit.symbolLit's bare-backtick-token rules reject the leading
// digit / dot / hyphen, so gateway.query() passes `sym` as `yahooSym`,
// which qlit.buildGwQuery renders via yahooSymbolLit's `$"<sym>"` cast form
// instead. This regex is what actually guards against injection either way.
const SYM_RE = /^[0-9A-Za-z.\-]{1,14}$/;
// Short TTL so a newly-loaded exchange / partition shows up in the symbol
// picker within a minute rather than up to 5 - the query is one grouped
// scan of a single partition, cheap to re-run.
const SYM_TTL_MS = 60 * 1000;

const toMs = (v) => (v instanceof Date ? v.getTime() : v == null ? null : Date.parse(v));

class EqOhlcReader {
  constructor(opts) {
    this.table = opts.table || "eq_m1_yfinance";
    this.maxDays = opts.maxDays || 21;
    this.hdbName = opts.hdbName || "eq_m1_yfinance_gw";
    this.startHint = opts.startHint || 'the "eq_m1_yfinance" module from System > Control';
    this.timeoutMs = opts.timeoutMs || 15000;
    this.gateway = new QGateway({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      poolSize: Math.max(1, opts.poolSize || 2),
      queryTimeoutMs: this.timeoutMs,
      useBigInt: opts.useBigInt,
    });
    this._syms = { at: 0, data: null };
  }

  start() {
    this.gateway.start().then(({ connected }) => {
      // warm the symbol cache once a slot is up, so /health symCount and the
      // per-bars exchange lookup are populated without waiting for the first
      // /api/eq/syms hit; harmless no-op if it's still down (connected=0).
      if (connected) this.syms().catch(() => {});
    });
    return this;
  }
  async stop() { await this.gateway.stop(); }

  get connected() { return this.gateway.readyCount() > 0; }

  status() {
    return {
      enabled: true,
      target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
      connected: this.connected,
      table: this.table,
      symCount: this._syms.data ? this._syms.data.count : null,
      gw: this.gateway.status(),
    };
  }

  _requireUp() {
    if (!this.connected) {
      const e = new Error(`${this.hdbName} not reachable at ${this.gateway.opts.host}:${this.gateway.opts.port} - start ${this.startHint}`);
      e.statusCode = 503;
      throw e;
    }
  }

  // ~6.4k rows: one { sym, exchange } per symbol present in the newest
  // partition THAT ACTUALLY HAS ROWS - not `max date`, which after
  // core/hdb.q's .Q.chk can be an empty `eq_m1_yfinance` stub in a
  // partition that only really holds `eq_d1_yfinance`. That gap-safe
  // max-date lookup plus the by-sym aggregation now lives server-side in
  // .oq.query.symRoster (openQ core/query.q), called through the gw via
  // .oq.gw.symRoster - see qGateway.js. Cached SYM_TTL_MS.
  async syms() {
    if (this._syms.data && Date.now() - this._syms.at < SYM_TTL_MS) return this._syms.data;
    this._requireUp();
    const { data: res } = await this.gateway.symRoster(this.table);
    const syms = [];
    const byExch = {};
    if (res && Array.isArray(res.sym)) {
      for (let i = 0; i < res.sym.length; i++) {
        const sym = String(res.sym[i]);
        const exchange = res.exchange ? String(res.exchange[i]) : null;
        syms.push({ sym, exchange });
        if (exchange) byExch[exchange] = (byExch[exchange] || 0) + 1;
      }
    }
    const data = {
      count: syms.length,
      exchanges: Object.entries(byExch).map(([exchange, n]) => ({ exchange, count: n })).sort((a, b) => b.count - a.count),
      syms,
    };
    this._syms = { at: Date.now(), data };
    return data;
  }

  _exchangeOf(sym) {
    const hit = this._syms.data && this._syms.data.syms.find((s) => s.sym === sym);
    return hit ? hit.exchange : null;
  }

  async bars(symRaw, daysRaw) {
    const sym = String(symRaw || "").trim();
    if (!SYM_RE.test(sym)) {
      const e = new Error(`bad sym: ${symRaw}`);
      e.statusCode = 400;
      throw e;
    }
    const days = Math.max(1, Math.min(this.maxDays, Math.trunc(Number(daysRaw) || 3)));
    this._requireUp();
    if (!this._syms.data) await this.syms().catch(() => {});
    // .oq.gw.query takes a plain calendar sTime/eTime bound, not "the last N
    // POPULATED dates" (what this reader used to compute itself against a
    // direct IPC connection - core/query.q's .oq.query.root has no such
    // concept). Pad the window ~1.6x + 2 days so weekends/holidays inside it
    // still leave at least `days` real trading days in view; `end` is left
    // unset so qlit.js materialises it as an always-future edge timestamp,
    // which .oq.gw.chooseServers reads as "reaches into today" - so the rdb
    // leg is queried too and today's bars-so-far show up immediately.
    const calDays = Math.ceil(days * 1.6) + 2;
    const start = new Date(Date.now() - calDays * 86400000);
    const { data: res } = await this.gateway.query({
      table: this.table,
      columns: ["barTime", "open", "high", "low", "close", "volume"],
      start,
      yahooSym: sym,
    });
    const bt = (res && res.barTime) || [];
    const bars = new Array(bt.length);
    for (let i = 0; i < bt.length; i++) {
      // same bar shape as /api/ohlc so the dashboard's <LwCandles> (which
      // reads b.open/high/low/close) renders it unchanged
      bars[i] = {
        t: toMs(bt[i]),
        open: Number(res.open[i]),
        high: Number(res.high[i]),
        low: Number(res.low[i]),
        close: Number(res.close[i]),
        volume: Number(res.volume[i]),
      };
    }
    bars.sort((a, b) => a.t - b.t);
    const last = bars.length ? bars[bars.length - 1].close : null;
    const first = bars.length ? bars[0].open : null;
    return {
      sym,
      exchange: this._exchangeOf(sym),
      days,
      count: bars.length,
      bars,
      last,
      hi: bars.length ? Math.max(...bars.map((b) => b.high)) : null,
      lo: bars.length ? Math.min(...bars.map((b) => b.low)) : null,
      vol: bars.reduce((a, b) => a + (b.volume || 0), 0),
      changePct: first && last ? (last / first - 1) * 100 : null,
    };
  }
}

module.exports = { EqOhlcReader };
