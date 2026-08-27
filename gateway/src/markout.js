"use strict";

const { QConnection } = require("jkdb");
const { toRows } = require("./qshape");

// Reads the markout module's live analytics state.
//
// openQ's `markout` CEP (modules/markout/cep.q) loads analytics/markOutImpact.q
// and keeps its results in in-memory keyed tables that are NOT published
// downstream:
//   .markout.completed  ([tradeID;offsetIdx] offsetSec; mid; markoutVal; matchedTime)
//   .impact.completed   ([orderID;offsetIdx] offsetSec; mid; impact;    matchedTime)
// so we read them straight off the CEP over a plain jkdb sync connection
// (the CEP's .z.pg is `value`, no gateway involved). Read-only aggregate
// selects only.
//
//   markoutVal = mid - tradeRate   ->  tradeRate = mid - markoutVal
//   impact     = dirSign*(mid - orderRate)   (positive = adverse)

const CURVE_MARKOUT =
  "0!select markoutBps:1e4*avg markoutVal%(mid-markoutVal), samples:count i, " +
  "trades:count distinct tradeID by offsetSec from .markout.completed";

const CURVE_IMPACT =
  "0!select impactBps:1e4*avg impact%mid, samples:count i, " +
  "orders:count distinct orderID by offsetSec from .impact.completed";

const SUMMARY =
  "`mkTrades`mkSamples`mkPending`imOrders`imSamples`imPending!(" +
  "count distinct exec tradeID from .markout.completed; count .markout.completed; count .markout.pending; " +
  "count distinct exec orderID from .impact.completed; count .impact.completed; count .impact.pending)";

class MarkoutReader {
  constructor(opts) {
    this.opts = opts; // { host, port, user, password }
    this.q = null;
    this.connected = false;
    this.stopped = false;
  }

  start() {
    this._connect();
  }

  _connect() {
    if (this.stopped) return;
    const q = new QConnection({
      host: this.opts.host,
      port: this.opts.port,
      user: this.opts.user || undefined,
      password: this.opts.password || undefined,
      socketNoDelay: true,
    });
    this.q = q;
    const gone = () => {
      if (this.q !== q) return;
      this.connected = false;
      if (!this.stopped) setTimeout(() => this._connect(), 1000);
    };
    q.on("close", gone);
    q.on("end", gone);
    q.on("error", () => {});
    q.connect((err) => {
      if (this.q !== q) return;
      if (err) return setTimeout(() => this._connect(), 1000);
      this.connected = true;
    });
  }

  _sync(expr) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.q) return reject(new Error("markout CEP not connected"));
      this.q.sync(expr, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  async read() {
    const [mk, im, sum] = await Promise.all([
      this._sync(CURVE_MARKOUT),
      this._sync(CURVE_IMPACT),
      this._sync(SUMMARY),
    ]);
    const mkCurve = toRows(mk).rows || [];
    const imCurve = toRows(im).rows || [];

    // sort by offset and drop non-finite bps (0/0 before data lands)
    const clean = (rows, key) =>
      rows
        .map((r) => ({ ...r, [key]: Number.isFinite(r[key]) ? r[key] : null }))
        .sort((a, b) => a.offsetSec - b.offsetSec);

    const imAfter = imCurve.filter((r) => r.offsetSec > 0 && Number.isFinite(r.impactBps));
    const peak = imAfter
      .filter((r) => r.offsetSec <= 10)
      .reduce((m, r) => Math.max(m, r.impactBps), 0);
    const permRows = imAfter.filter((r) => r.offsetSec >= 30);
    const perm = permRows.length
      ? permRows.reduce((s, r) => s + r.impactBps, 0) / permRows.length
      : null;

    return {
      connected: this.connected,
      target: `${this.opts.host}:${this.opts.port}`,
      summary: toRows(sum).value || {},
      markout: { curve: clean(mkCurve, "markoutBps") },
      impact: {
        curve: clean(imCurve, "impactBps"),
        peakBps: Number.isFinite(peak) ? peak : null,
        permanentBps: perm,
      },
    };
  }

  status() {
    return { enabled: true, target: `${this.opts.host}:${this.opts.port}`, connected: this.connected };
  }

  async stop() {
    this.stopped = true;
    await new Promise((res) => {
      try {
        this.q ? this.q.close(() => res()) : res();
      } catch {
        res();
      }
    });
  }
}

module.exports = { MarkoutReader };
