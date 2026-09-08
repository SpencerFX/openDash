"use strict";

const { QSession } = require("./qSession");

// Candlestick-pattern hits for the EQ > Candles page, read off the
// `candlePattern` table (schemas/schema_candlepattern.q) served by
// candlePattern_hdb (cfg_proc/modules/candlePattern/hdb.json, port 5095,
// hdbroot C:/data/db1/ta). That table is produced in daily batches by
// modules/analytics/candle/run.q - one row per (sym, timeframe, pattern)
// where a pattern actually fired, across 10 timeframes (1m..1d) and the
// full 32-pattern library. Read-only; openQ writes it via run.q's own EOD
// path, never a live feed, so it only advances one date per daily run.
//
//   meta()                          -> the pattern universe: every
//        pattern name + its direction category (bullish/bearish/both/
//        neutral) + hit count, the timeframes present, and the scanned
//        date range. Feeds the page's pattern <select>.
//   signals({sym,tf,pattern,dir,days}) -> that symbol's fired rows for one
//        timeframe over the last `days` scanned dates: { t, pattern,
//        direction, signal }. `dir` (long|short|both) filters on the
//        sign of `signal` (+100 bullish instance / -100 bearish /
//        +1 for a direction-less pattern like doji). `pattern` "all" or
//        omitted = every pattern.
//
// candlePattern_hdb is not always up - start it from System > Control or
// `scripts/startStop/startupAllByModule.sh candlePattern`. Every call
// fails soft with a 503 when it's down.

// Yahoo tickers: digits + letters + '.' + '-' (0005.HK, 7203.T, BRK-B).
const SYM_RE = /^[0-9A-Za-z.\-]{1,14}$/;
const TF_RE = /^(1m|5m|10m|15m|30m|1h|2h|4h|8h|1d)$/;
// candle.q pattern names are plain lowerCamel identifiers
const PAT_RE = /^[A-Za-z]{2,40}$/;

const META_TTL_MS = 5 * 60 * 1000;
const SIG_TTL_MS = 15 * 1000;

const toMs = (v) => (v instanceof Date ? v.getTime() : v == null ? null : Date.parse(v));
// q date -> "YYYY-MM-DD" (comes back as a JS Date from the wire)
const dstr = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10);

class CandlePatternReader {
  constructor(opts) {
    this.maxDays = opts.maxDays || 30;
    this.session = new QSession({
      host: opts.host,
      port: opts.port,
      timeoutMs: opts.timeoutMs || 15000,
      reconnectMs: 2000,
      label: "candlepattern-hdb",
    });
    this._meta = { at: 0, data: null };
    this._sig = new Map(); // key -> { at, data }
    this.session.on("connect", () => { this.meta().catch(() => {}); });
  }

  start() { this.session.start(); return this; }
  async stop() { await this.session.stop(); }
  get connected() { return this.session.connected; }

  status() {
    return {
      enabled: true,
      target: this.session.target,
      connected: this.session.connected,
      patterns: this._meta.data ? this._meta.data.patterns.length : null,
    };
  }

  _requireUp() {
    if (!this.session.connected) {
      const e = new Error(
        `candlePattern_hdb not reachable at ${this.session.target} - start the "candlePattern" module ` +
          `(scripts/startStop/startupAllByModule.sh candlePattern)`
      );
      e.statusCode = 503;
      throw e;
    }
  }

  // One grouped scan of the newest partition + a cheap distinct-date pass.
  async meta() {
    if (this._meta.data && Date.now() - this._meta.at < META_TTL_MS) return this._meta.data;
    this._requireUp();
    const q =
      "{ lp:last .Q.pv;" +
      "  pats:0!`pattern xasc select n:count i, direction:first direction by pattern from candlePattern where date=lp;" +
      "  tfs:exec distinct timeframe from select timeframe from candlePattern where date=lp;" +
      "  dr:exec distinct date from select date from candlePattern;" +
      "  `patterns`timeframes`dfrom`dto!(pats; tfs; min dr; max dr) }[]";
    const r = await this.session.sync(q, { timeoutMs: 30000 });
    const p = r && r.patterns ? r.patterns : {};
    const patterns = Array.isArray(p.pattern)
      ? p.pattern.map((name, i) => ({
          pattern: String(name),
          direction: p.direction ? String(p.direction[i]) : null,
          count: p.n ? Number(p.n[i]) : 0,
        }))
      : [];
    const data = {
      connected: true,
      patterns,
      timeframes: Array.isArray(r && r.timeframes) ? r.timeframes.map(String) : [],
      dateFrom: r ? dstr(r.dfrom) : null,
      dateTo: r ? dstr(r.dto) : null,
      scannedThrough: r ? dstr(r.dto) : null,
    };
    this._meta = { at: Date.now(), data };
    return data;
  }

  async signals({ sym, tf, pattern, dir, days }) {
    const symC = String(sym || "").trim();
    if (!SYM_RE.test(symC)) {
      const e = new Error(`bad sym: ${sym}`);
      e.statusCode = 400;
      throw e;
    }
    const tfC = String(tf || "").trim();
    if (!TF_RE.test(tfC)) {
      const e = new Error(`bad timeframe: ${tf} (expected one of 1m 5m 10m 15m 30m 1h 2h 4h 8h 1d)`);
      e.statusCode = 400;
      throw e;
    }
    const patC = pattern && pattern !== "all" ? String(pattern).trim() : null;
    if (patC && !PAT_RE.test(patC)) {
      const e = new Error(`bad pattern: ${pattern}`);
      e.statusCode = 400;
      throw e;
    }
    const dirC = dir === "long" || dir === "short" ? dir : "both";
    const daysC = Math.max(1, Math.min(this.maxDays, Math.trunc(Number(days) || 5)));

    const key = `${symC}|${tfC}|${patC || "all"}|${dirC}|${daysC}`;
    const cached = this._sig.get(key);
    if (cached && Date.now() - cached.at < SIG_TTL_MS) return cached.data;

    this._requireUp();

    // the table holds only FIRED rows (signal != 0), so "both" adds no
    // predicate; long / short split on the sign of signal.
    const sigPred = dirC === "long" ? ", signal>0" : dirC === "short" ? ", signal<0" : "";
    const patPred = patC ? `, pattern=\`${patC}` : "";
    const q =
      `{[s;n] pv:asc exec distinct date from select date from candlePattern; ` +
      `d0:pv (0 | (count pv) - n); ` +
      `\`timestamp xasc select timestamp, pattern, direction, signal from candlePattern ` +
      `where date>=d0, sym=s, timeframe=\`${tfC}${patPred}${sigPred}}[\`$"${symC}"; ${daysC}]`;

    const res = await this.session.sync(q, { timeoutMs: this.session.timeoutMs });
    const ts = (res && res.timestamp) || [];
    const rows = new Array(ts.length);
    for (let i = 0; i < ts.length; i++) {
      rows[i] = {
        t: toMs(ts[i]),
        pattern: res.pattern ? String(res.pattern[i]) : null,
        direction: res.direction ? String(res.direction[i]) : null,
        signal: res.signal != null ? Number(res.signal[i]) : null,
      };
    }
    rows.sort((a, b) => a.t - b.t);

    const byPattern = {};
    for (const r of rows) byPattern[r.pattern] = (byPattern[r.pattern] || 0) + 1;

    const data = {
      sym: symC,
      timeframe: tfC,
      pattern: patC || "all",
      dir: dirC,
      days: daysC,
      count: rows.length,
      byPattern: Object.entries(byPattern)
        .map(([pattern, n]) => ({ pattern, count: n }))
        .sort((a, b) => b.count - a.count),
      signals: rows,
    };
    this._sig.set(key, { at: Date.now(), data });
    // keep the per-request cache from growing unbounded
    if (this._sig.size > 64) {
      const oldest = [...this._sig.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this._sig.delete(oldest[0]);
    }
    return data;
  }
}

module.exports = { CandlePatternReader };
