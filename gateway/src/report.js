"use strict";

const { CepReader } = require("./cepReader");

// Reads the report module's cross-desk "Desk Risk & TCA" table off its CEP
// (modules/report/cep.q -> analytics/deskRisk.q). That CEP recomputes
// `.report.latest` on a 60s timer by pulling spread / markout / primefinance
// state and combining it per symbol:
//   sym, spreadCostBp, markoutBp, impactBp, financingFeeBp,
//   shortQty, locatedQty, coverage, bucket
// One row per symbol seen in any domain; a symbol absent from a domain has
// nulls there (left join), so not every row is fully populated.

const QUERIES = { latest: "0!.report.latest" };

const num = (v) => (v == null || Number.isNaN(v) ? null : Number(v));

class ReportReader extends CepReader {
  constructor(opts) {
    super(opts, QUERIES);
  }

  async read() {
    const r = await this._run();

    // equities only: primefinance drives the borrow/coverage side, so a
    // security-financed name always has a coverage `bucket`; the FX pairs
    // that only carry spread/markout/impact have bucket = "" and are dropped.
    const rows = (r.latest.rows || []).filter((x) => x.bucket).map((x) => {
      const spreadCostBp = num(x.spreadCostBp);
      const markoutBp = num(x.markoutBp);
      const impactBp = num(x.impactBp);
      const financingFeeBp = num(x.financingFeeBp);
      const parts = [spreadCostBp, markoutBp, impactBp, financingFeeBp];
      // all-in round-trip cost estimate (bps): what the desk pays to trade
      // and finance the name - spread + adverse markout + impact + fee
      const allInBp = parts.some((p) => p != null)
        ? parts.reduce((a, p) => a + (p || 0), 0)
        : null;
      return {
        sym: x.sym,
        spreadCostBp,
        markoutBp,
        impactBp,
        financingFeeBp,
        allInBp,
        shortQty: num(x.shortQty),
        locatedQty: num(x.locatedQty),
        coverage: num(x.coverage),
        bucket: x.bucket || null,
      };
    });

    const byBucketMap = new Map();
    for (const row of rows) {
      const b = row.bucket || "n/a";
      const acc = byBucketMap.get(b) || { bucket: b, syms: 0, shortQty: 0, locatedQty: 0 };
      acc.syms += 1;
      acc.shortQty += row.shortQty || 0;
      acc.locatedQty += row.locatedQty || 0;
      byBucketMap.set(b, acc);
    }

    const withCost = rows.filter((row) => row.allInBp != null);
    return {
      connected: this.connected,
      target: this.target,
      rows: rows.sort((a, b) => (b.allInBp || 0) - (a.allInBp || 0)),
      byBucket: [...byBucketMap.values()],
      totals: {
        syms: rows.length,
        shortQty: rows.reduce((a, row) => a + (row.shortQty || 0), 0),
        locatedQty: rows.reduce((a, row) => a + (row.locatedQty || 0), 0),
        avgAllInBp: withCost.length
          ? withCost.reduce((a, row) => a + row.allInBp, 0) / withCost.length
          : null,
        maxAllInBp: withCost.length ? Math.max(...withCost.map((row) => row.allInBp)) : null,
        atRisk: rows.filter((row) => ["AT_RISK", "UNLOCATED"].includes(row.bucket)).length,
      },
    };
  }
}

module.exports = { ReportReader };
