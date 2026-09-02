"use strict";

const { QSession } = require("./qSession");
const { symbolLit } = require("./qlit");
const { toRows } = require("./qshape");

// Rolling OHLC store for a live price feed. Subscribes (.u.sub) to one table
// on a tp/rdb (markout's `rate` by default - timestamp,sym,mid), keeps a
// capped ring of raw ticks per symbol, and buckets them into candles on
// demand at any requested interval. Self-contained: gateway-side history so
// the chart doesn't depend on how much the module's RDB happens to be
// holding at query time.

class OhlcStore {
  // opts: { host, port, table?, priceCol?, retentionMs?, maxTicks?, timeoutMs?, syms? }
  constructor(opts) {
    this.table = opts.table || "rate";
    this.priceCol = opts.priceCol || "mid";
    this.retentionMs = opts.retentionMs || 45 * 60 * 1000;
    this.maxTicks = opts.maxTicks || 8000;
    // This store feeds the dashboard's eFX > Charts page, so it must only
    // ever surface currency pairs. `syms` (OPENQ_OHLC_SYMS) is an explicit
    // allow-list; with none set, fall back to the "six upper-case letters"
    // FX-pair shape, which rejects equity tickers (AAPL, GME, ...).
    this.allow = Array.isArray(opts.syms) && opts.syms.length ? new Set(opts.syms) : null;
    this.allowRe = /^[A-Z]{6}$/;
    this.ticks = new Map(); // sym -> [[ms, price], ...] ascending
    this.session = new QSession({ ...opts, label: "ohlc" });
    this.session.on("upd", (msg) => this._onUpd(msg));
    this.session.on("connect", () => this._subscribe());
  }

  start() {
    this.session.start();
  }
  async stop() {
    await this.session.stop();
  }
  get connected() {
    return this.session.connected;
  }

  _subscribe() {
    this.session
      .sync(`.u.sub[${symbolLit(this.table)};\`]`)
      .catch(() => {});
  }

  _accept(sym) {
    if (!sym) return false;
    return this.allow ? this.allow.has(sym) : this.allowRe.test(sym);
  }

  _onUpd(msg) {
    if (msg[1] !== this.table) return;
    const shaped = toRows(msg[2]);
    if (!shaped.rows) return;
    const cutoff = Date.now() - this.retentionMs;
    for (const row of shaped.rows) {
      const sym = row.sym;
      const ms = Date.parse(row.timestamp);
      const px = Number(row[this.priceCol]);
      if (!this._accept(sym) || !Number.isFinite(ms) || !Number.isFinite(px)) continue;
      let arr = this.ticks.get(sym);
      if (!arr) {
        arr = [];
        this.ticks.set(sym, arr);
      }
      arr.push([ms, px]);
      if (arr.length > this.maxTicks || arr[0][0] < cutoff) {
        let i = 0;
        while (i < arr.length && (arr[i][0] < cutoff || arr.length - i > this.maxTicks)) i += 1;
        if (i) arr.splice(0, i);
      }
    }
  }

  syms() {
    return [...this.ticks.keys()].filter((s) => this._accept(s)).sort();
  }

  bars(sym, bucketSec, count) {
    const arr = this.ticks.get(sym) || [];
    const bucketMs = Math.max(1, bucketSec) * 1000;
    const map = new Map();
    for (const [ms, px] of arr) {
      const t = Math.floor(ms / bucketMs) * bucketMs;
      let bar = map.get(t);
      if (!bar) {
        bar = { t, open: px, high: px, low: px, close: px, ticks: 0 };
        map.set(t, bar);
      }
      if (px > bar.high) bar.high = px;
      if (px < bar.low) bar.low = px;
      bar.close = px;
      bar.ticks += 1;
    }
    const bars = [...map.values()].sort((a, b) => a.t - b.t);
    return count ? bars.slice(-count) : bars;
  }

  status() {
    return {
      enabled: true,
      target: this.session.target,
      connected: this.session.connected,
      table: this.table,
      syms: this.syms(),
      ticks: [...this.ticks.values()].reduce((a, x) => a + x.length, 0),
    };
  }
}

module.exports = { OhlcStore };
