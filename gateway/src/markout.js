"use strict";

const { CepReader } = require("./cepReader");

// Reads the markout module's live analytics state off its CEP
// (modules/markout/cep.q -> analytics/markOutImpact.q). Its results live in
// in-memory keyed tables that aren't published downstream:
//   .markout.completed  ([tradeID;offsetIdx] offsetSec; mid; markoutVal; matchedTime)
//   .impact.completed   ([orderID;offsetIdx] offsetSec; mid; impact;    matchedTime)
//
//   markoutVal = mid - tradeRate            ->  tradeRate = mid - markoutVal
//   impact     = dirSign*(mid - orderRate)      (positive = adverse)

const QUERIES = {
  // windowed to the recent past so the curves track "now" rather than being
  // diluted by an ever-growing history (.markout/.impact.completed has no TTL).
  markoutCurve:
    "0!select markoutBps:1e4*avg markoutVal%(mid-markoutVal), samples:count i, " +
    "trades:count distinct tradeID by offsetSec from .markout.completed " +
    "where matchedTime > .z.p - 0D00:10",

  impactCurve:
    "0!select impactBps:1e4*avg impact%mid, samples:count i, " +
    "orders:count distinct orderID by offsetSec from .impact.completed " +
    "where matchedTime > .z.p - 0D00:05",

  // per-symbol impact curve (mean per offset, so it isn't outlier-blown).
  // `.impact.completed` carries no sym, but `.impact.pending` still holds one
  // per recently-active order (grid runs to +60s) - i.e. current order flow.
  impactBySym:
    "o2s:exec first sym by orderID from .impact.pending;" +
    "c:select offsetSec, r:impact%mid, orderID, sym:o2s[orderID] from .impact.completed " +
    " where orderID in key o2s, matchedTime > .z.p - 0D00:05;" +
    "0!`sym`offsetSec xasc select impactBps:1e4*avg r, orders:count distinct orderID " +
    " by sym,offsetSec from c",

  summary:
    "`mkTrades`mkSamples`mkPending`imOrders`imSamples`imPending!(" +
    "count distinct exec tradeID from .markout.completed; count .markout.completed; count .markout.pending; " +
    "count distinct exec orderID from .impact.completed; count .impact.completed; count .impact.pending)",
};

class MarkoutReader extends CepReader {
  constructor(opts) {
    super(opts, QUERIES);
  }

  async read() {
    const r = await this._run({ optional: ["impactBySym"] });
    const mkCurve = r.markoutCurve.rows || [];
    const imCurve = r.impactCurve.rows || [];

    // sort by offset and drop non-finite bps (0/0 before data lands)
    const clean = (rows, key) =>
      rows
        .map((row) => ({ ...row, [key]: Number.isFinite(row[key]) ? row[key] : null }))
        .sort((a, b) => a.offsetSec - b.offsetSec);

    const imAfter = imCurve.filter((row) => row.offsetSec > 0 && Number.isFinite(row.impactBps));
    const peak = imAfter
      .filter((row) => row.offsetSec <= 10)
      .reduce((m, row) => Math.max(m, row.impactBps), 0);
    const permRows = imAfter.filter((row) => row.offsetSec >= 30);
    const perm = permRows.length
      ? permRows.reduce((s, row) => s + row.impactBps, 0) / permRows.length
      : null;

    return {
      connected: this.connected,
      target: this.target,
      summary: r.summary.value || {},
      markout: { curve: clean(mkCurve, "markoutBps") },
      impact: {
        curve: clean(imCurve, "impactBps"),
        peakBps: Number.isFinite(peak) ? peak : null,
        permanentBps: perm,
        bySym: perSymImpact(r.impactBySym.rows || []),
      },
    };
  }
}

// rows: per-(sym, offsetSec) mean impact. Fold each sym's curve into a
// temporary (peak of the mean, 0-10s) and permanent (mean of the mean, >=30s)
// component - same method as the overall curve, so no single outlier order
// blows the number up.
function perSymImpact(rows) {
  const bySym = new Map();
  for (const row of rows) {
    if (!bySym.has(row.sym)) bySym.set(row.sym, []);
    bySym.get(row.sym).push(row);
  }
  const out = [];
  for (const [sym, curve] of bySym) {
    const pos = curve.filter((row) => row.offsetSec > 0 && Number.isFinite(row.impactBps));
    const peak = pos
      .filter((row) => row.offsetSec <= 10)
      .reduce((m, row) => Math.max(m, row.impactBps), 0);
    const tail = pos.filter((row) => row.offsetSec >= 30);
    const perm = tail.length ? tail.reduce((s, row) => s + row.impactBps, 0) / tail.length : null;
    out.push({
      sym,
      peakBps: Number.isFinite(peak) ? peak : null,
      permanentBps: perm,
      orders: Math.max(0, ...curve.map((row) => Number(row.orders) || 0)),
      offsets: curve.length,
    });
  }
  return out.sort((a, b) => (b.peakBps || 0) - (a.peakBps || 0));
}

module.exports = { MarkoutReader };
