"use strict";

const { QSession } = require("./qSession");

// Minute-bar OHLCV for the EQ Charts page, read straight off the equities
// HDB (eq_hdb, default 127.0.0.1:5090 - cfg_proc/modules/eq/hdb.json,
// hdbroot C:/data/db1/eq). One table: `eq_m1_yfinance` (1-minute bars for
// Asian equities - HKEX + Tokyo/Nikkei). Read-only; the HDB is loaded by a
// separate loader, openQ never writes it.
//
// Two calls:
//   syms()          -> the ~6.4k symbol universe + its exchange, from the
//                      newest partition (cached, symbol picker feeds off it)
//   bars(sym, days) -> that symbol's minute bars over the last `days`
//                      partitions, shaped { t, o, h, l, c, v } for the
//                      dashboard's <LwCandles> (same shape as /api/ohlc)
//
// eq_hdb is not always running - start it from System > Control (the `eq`
// module) or `scripts/startupAllByModule.sh eq`. Every call fails soft with
// a 503 when it's down.

// Yahoo tickers: digits + letters + '.' + '-' (e.g. 0005.HK, 7203.T,
// BRK-B). qlit.symbolLit rejects the dot / leading digit, so the query
// uses `$"<sym>" and this regex is the whole guard against injection.
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
    this.session = new QSession({
      host: opts.host,
      port: opts.port,
      timeoutMs: opts.timeoutMs || 15000,
      reconnectMs: 2000,
      label: "eq-hdb",
    });
    this._syms = { at: 0, data: null };
    // warm the symbol cache on (re)connect so /health symCount and the
    // per-bars exchange lookup are populated without waiting for /api/eq/syms
    this.session.on("connect", () => { this.syms().catch(() => {}); });
  }

  start() { this.session.start(); return this; }
  async stop() { await this.session.stop(); }

  get connected() { return this.session.connected; }

  status() {
    return {
      enabled: true,
      target: this.session.target,
      connected: this.session.connected,
      table: this.table,
      symCount: this._syms.data ? this._syms.data.count : null,
    };
  }

  _requireUp() {
    if (!this.session.connected) {
      const e = new Error(`eq_hdb not reachable at ${this.session.target} - start the "eq" module from System > Control`);
      e.statusCode = 503;
      throw e;
    }
  }

  // ~6.4k rows: one { sym, exchange } per symbol present in the newest
  // partition THAT ACTUALLY HAS ROWS - not `max date`, which after
  // core/hdb.q's .Q.chk can be an empty `eq_m1_yfinance` stub in a
  // partition that only really holds `eq_d1_yfinance`. Cached SYM_TTL_MS.
  async syms() {
    if (this._syms.data && Date.now() - this._syms.at < SYM_TTL_MS) return this._syms.data;
    this._requireUp();
    const q =
      `0!\`sym xasc select exchange:last exchange by sym from ${this.table} ` +
      `where date=(exec max date from select date from ${this.table})`;
    const res = await this.session.sync(q, { timeoutMs: 20000 });
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
    // the last `days` dates that actually have rows for this table (not
    // .Q.pv, which can include an empty .Q.chk stub partition); d0 bracketed
    // so the index math can't parse as a subtraction.
    const q =
      `{[n;s] pv:asc exec distinct date from select date from ${this.table}; ` +
      `d0:pv (0|(count pv)-n); ` +
      `select barTime, open, high, low, close, volume from ${this.table} ` +
      `where date>=d0, sym=s}[${days};\`$"${sym}"]`;
    const res = await this.session.sync(q, { timeoutMs: this.session.timeoutMs });
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
