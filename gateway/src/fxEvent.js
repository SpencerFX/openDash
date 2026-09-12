"use strict";

const { QSession } = require("./qSession");

// Chart data for the eFX > Economic Calendar page's "click a past event"
// drill-down: the underlying currency pair's price around the release,
// +/- windowHours. Reads two on-disk tables that already share fx_hdb's
// root (C:/data/db1/efx, cfg_proc/modules/fx/hdb.json, same process as
// /api/fx/{syms,bars} in eqOhlc.js):
//   fx_m1_massive    2009-09-25 -> 2025-12-31, symbols lowercase base_quote
//                    (`eur_usd) - the pre-existing vendor archive, covers
//                    almost the entire econCal history.
//   fx_m1_yfinance   2026-08-09 -> (rolling), symbols uppercase no-separator
//                    (`EURUSD) - the same live table eFX > Charts reads.
// There is a real gap between them (~2026-01-01..2026-08-08, after the
// vendor backfill ends and before the yfinance pipeline's first day) where
// neither has data; chart() reports that as a 404 rather than guessing.
//
// A currency (econCal's `currency` column, e.g. "USD") maps to one
// representative pair via CCY_PAIR below, using standard FX market
// convention (EUR/GBP/AUD/NZD quoted as the base; everything else quoted
// against USD as the base). If the mapped symbol turns up zero rows, the
// reverse (base<->quote swapped) is tried once, in case that convention
// is backwards for some exotic cross - cheap insurance against a wrong
// guess rather than a real expectation of ever needing it for majors.
// LTL/LVL (Lithuanian litas / Latvian lats) are retired pre-euro
// currencies with no modern FX pair and are deliberately left unmapped.

const CCY_PAIR = {
  EUR: "EURUSD", GBP: "GBPUSD", AUD: "AUDUSD", NZD: "NZDUSD",
  USD: "EURUSD", // no USDUSD - EURUSD is the standard "dollar" proxy chart
  JPY: "USDJPY", CHF: "USDCHF", CAD: "USDCAD",
  CNY: "USDCNH", HKD: "USDHKD", SGD: "USDSGD", INR: "USDINR",
  ZAR: "USDZAR", BRL: "USDBRL", MXN: "USDMXN", TRY: "USDTRY", RUB: "USDRUB",
  KRW: "USDKRW", THB: "USDTHB", ILS: "USDILS", SAR: "USDSAR", AED: "USDAED",
  SEK: "USDSEK", NOK: "USDNOK", DKK: "USDDKK", PLN: "USDPLN", HUF: "USDHUF",
  CZK: "USDCZK", RON: "USDRON", ISK: "USDISK", TWD: "USDTWD", IDR: "USDIDR",
  CLP: "USDCLP", EGP: "USDEGP", PEN: "USDPEN", COP: "USDCOP", QAR: "USDQAR",
  PHP: "USDPHP", MYR: "USDMYR", KWD: "USDKWD", VND: "USDVND", UAH: "USDUAH",
  BHD: "USDBHD", ARS: "USDARS",
};

const PAIR_RE = /^[A-Z]{6}$/;
const massiveSym = (pair) => `${pair.slice(0, 3)}_${pair.slice(3)}`.toLowerCase();
const swapPair = (pair) => pair.slice(3) + pair.slice(0, 3);
const toMs = (v) => (v instanceof Date ? v.getTime() : v == null ? null : Date.parse(v));

const BOUNDS_TTL_MS = 5 * 60 * 1000;

class FxEventChartReader {
  constructor(opts) {
    this.windowHours = Math.max(1, opts.windowHours || 6);
    this.timeoutMs = Math.max(3000, opts.timeoutMs || 15000);
    this.session = new QSession({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      timeoutMs: this.timeoutMs,
      reconnectMs: 2000,
      label: "fx-event-chart",
    });
    this._bounds = new Map(); // table -> { at, minDate, maxDate }
  }

  start() { this.session.start(); return this; }
  async stop() { await this.session.stop(); }
  get connected() { return this.session.connected; }

  status() {
    return { enabled: true, target: this.session.target, connected: this.session.connected };
  }

  _requireUp() {
    if (!this.session.connected) {
      const e = new Error(`fx_hdb not reachable at ${this.session.target}`);
      e.statusCode = 503;
      throw e;
    }
  }

  // one row per partition off the virtual `date` column (see calendar.js /
  // eqOhlc.js for the same trick) - cheap enough to just cache briefly.
  async _boundsOf(table) {
    const cached = this._bounds.get(table);
    if (cached && Date.now() - cached.at < BOUNDS_TTL_MS) return cached;
    const d = await this.session.sync(
      `select minDate:min date, maxDate:max date from select date from ${table}`,
      { timeoutMs: this.timeoutMs }
    );
    const iso = (v) => (v == null ? null : toMs(v) != null ? new Date(toMs(v)).toISOString().slice(0, 10) : null);
    const rec = {
      at: Date.now(),
      minDate: d.minDate ? iso(d.minDate[0]) : null,
      maxDate: d.maxDate ? iso(d.maxDate[0]) : null,
    };
    this._bounds.set(table, rec);
    return rec;
  }

  async _barsFrom(table, symLit, timeCol, d0, d1, loQ, hiQ) {
    const q =
      `select t:${timeCol}, open, high, low, close from ${table} ` +
      `where date within (${d0};${d1}), sym=${symLit}, ${timeCol} within (${loQ};${hiQ})`;
    const r = await this.session.sync(q, { timeoutMs: this.timeoutMs });
    const n = (r && r.t && r.t.length) || 0;
    const bars = new Array(n);
    for (let i = 0; i < n; i++) {
      bars[i] = {
        t: toMs(r.t[i]),
        o: Number(r.open[i]),
        h: Number(r.high[i]),
        l: Number(r.low[i]),
        c: Number(r.close[i]),
      };
    }
    bars.sort((a, b) => a.t - b.t);
    return bars.filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c));
  }

  async chart(query = {}) {
    this._requireUp();

    const date = String(query.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const e = new Error(`bad date: ${query.date}`);
      e.statusCode = 400;
      throw e;
    }
    const timeRaw = String(query.time || "00:00:00").trim();
    const time = /^\d{2}:\d{2}(:\d{2})?$/.test(timeRaw) ? timeRaw : "00:00:00";
    const evtMs = Date.parse(`${date}T${time}Z`);
    if (!Number.isFinite(evtMs)) {
      const e = new Error(`bad time: ${query.time}`);
      e.statusCode = 400;
      throw e;
    }

    const pairRaw = String(query.pair || "").toUpperCase().trim();
    const currency = String(query.currency || "").toUpperCase().trim();
    const pair = PAIR_RE.test(pairRaw) ? pairRaw : CCY_PAIR[currency];
    if (!pair) {
      const e = new Error(`no default chart pair for currency "${currency || query.pair || ""}"`);
      e.statusCode = 400;
      throw e;
    }

    const winMs = this.windowHours * 3600 * 1000;
    const loMs = evtMs - winMs;
    const hiMs = evtMs + winMs;
    const qdate = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, ".");
    const qts = (ms) => {
      const iso = new Date(ms).toISOString(); // 2025-06-02T08:00:00.000Z
      const [d, t] = iso.replace("Z", "").split("T");
      return `${d.replace(/-/g, ".")}D${t}000000`; // -> 2025.06.02D08:00:00.000000000
    };
    const d0 = qdate(loMs), d1 = qdate(hiMs), loQ = qts(loMs), hiQ = qts(hiMs);

    const [massive, yfin] = await Promise.all([
      this._boundsOf("fx_m1_massive"),
      this._boundsOf("fx_m1_yfinance"),
    ]);
    let source = null;
    if (massive.minDate && massive.maxDate && date >= massive.minDate && date <= massive.maxDate) source = "massive";
    else if (yfin.minDate && yfin.maxDate && date >= yfin.minDate && date <= yfin.maxDate) source = "yfinance";

    if (!source) {
      const e = new Error(
        `no intraday FX history for ${date} (archives cover ${massive.minDate || "?"}..${massive.maxDate || "?"} ` +
          `and ${yfin.minDate || "?"}..${yfin.maxDate || "?"})`
      );
      e.statusCode = 404;
      throw e;
    }

    const table = source === "massive" ? "fx_m1_massive" : "fx_m1_yfinance";
    const timeCol = source === "massive" ? "timestamp" : "barTime";
    const symOf = source === "massive" ? massiveSym : (p) => p;

    let usedPair = pair;
    let bars = await this._barsFrom(table, `\`${symOf(pair)}`, timeCol, d0, d1, loQ, hiQ);
    if (!bars.length) {
      const swapped = swapPair(pair);
      const swappedBars = await this._barsFrom(table, `\`${symOf(swapped)}`, timeCol, d0, d1, loQ, hiQ);
      if (swappedBars.length) {
        bars = swappedBars;
        usedPair = swapped;
      }
    }

    return {
      pair: usedPair,
      source,
      currency: currency || null,
      event: { date, time, ts: new Date(evtMs).toISOString() },
      window: { start: new Date(loMs).toISOString(), end: new Date(hiMs).toISOString(), hours: this.windowHours },
      bars,
    };
  }
}

module.exports = { FxEventChartReader };
