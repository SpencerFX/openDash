"use strict";

const { CepReader } = require("./cepReader");

// Reads the spread module's live build-up attribution off its CEP
// (modules/spread/cep.q -> analytics/spread.q). All state is the keyed
// snapshot `.spread.snap` (latest composed quote per
// sym/aggression/marketStatus); everything below is a read-only aggregate
// over `.spread.latest[]` (its unkeyed form). Spread values are raw price
// fractions; the endpoint multiplies by 1e4 for bps.

const COMPONENTS = [
  "refSprd", "baseSprd", "clientSprd", "volSprd", "smoothSprd", "fallbackSprd", "alphaSprd",
];

const QUERIES = {
  summary:
    "{[] l:.spread.latest[]; `keys`syms`meanTotal`widestTotal!(" +
    "count .spread.snap; count distinct exec sym from l; " +
    "$[count l; avg exec totalSprd from l; 0n]; $[count l; max exec totalSprd from l; 0n])}[]",

  // overall build-up: one weighted row, melted to one row per component
  attribution: "0!.spread.decompose .spread.wavgBy[.spread.latest[]; `$()]",
  bySym: "0!.spread.wavgBy[.spread.latest[]; enlist `sym]",
  byRegime: "0!.spread.wavgBy[.spread.latest[]; `aggression`marketStatus]",
  widest:
    "10 sublist `totalSprd xdesc 0!select sym,aggression,marketStatus,totalSprd," +
    "ageSec:`float$(.z.p-time)%1e9 from .spread.compose .spread.latest[]",
  pctl: "0!.spread.pctlBy[.spread.latest[]; enlist `sym; 0.5 0.9 0.99]",
};

const X4 = (v) => (v == null || Number.isNaN(v) ? null : v * 1e4);

class SpreadReader extends CepReader {
  constructor(opts) {
    super(opts, QUERIES);
  }

  async read() {
    const r = await this._run();
    const s = r.summary.value || {};

    return {
      connected: this.connected,
      target: this.target,
      components: COMPONENTS,
      summary: {
        keys: Number(s.keys) || 0,
        syms: Number(s.syms) || 0,
        meanBps: X4(s.meanTotal),
        widestBps: X4(s.widestTotal),
      },
      attribution: (r.attribution.rows || []).map((row) => ({
        component: row.component,
        valueBps: X4(row.componentValue),
        pctOfTotal: row.pctOfTotal == null ? null : Number(row.pctOfTotal),
      })),
      bySym: (r.bySym.rows || [])
        .map((row) => ({
          sym: row.sym,
          weight: Number(row.weight),
          totalBps: X4(row.totalSprd),
          components: Object.fromEntries(COMPONENTS.map((c) => [c, X4(row[c])])),
        }))
        .sort((a, b) => (b.totalBps || 0) - (a.totalBps || 0)),
      byRegime: (r.byRegime.rows || []).map((row) => ({
        aggression: row.aggression,
        marketStatus: row.marketStatus,
        totalBps: X4(row.totalSprd),
      })),
      widest: (r.widest.rows || []).map((row) => ({
        sym: row.sym,
        aggression: row.aggression,
        marketStatus: row.marketStatus,
        totalBps: X4(row.totalSprd),
        ageSec: row.ageSec == null ? null : Number(row.ageSec),
      })),
      pctl: (r.pctl.rows || []).map((row) => ({
        sym: row.sym,
        p50Bps: X4(row.p50),
        p90Bps: X4(row.p90),
        p99Bps: X4(row.p99),
      })),
    };
  }
}

module.exports = { SpreadReader, COMPONENTS };
