"use strict";

const { CepReader } = require("./cepReader");

// Reads openQ's prime-finance analytics state off the primefinance module
// CEP (modules/primefinance/cep.q -> analytics/primeFinance.q). The CEP
// keeps everything in .prime.* tables (inventory / locates / positions /
// borrows / recalls / reservations / buyins / alerts) and exposes
// .prime.positionCoverage for the locate-coverage view. Read-only.

const QUERIES = {
  summary:
    "`invRows`locRows`posRows`borRows`recRows`resRows`buyinsOpen`alerts`shortQty`availQty!(" +
    "count .prime.inventory; count .prime.locates; count .prime.positions;" +
    "count .prime.borrows; count .prime.recalls; count .prime.reservations;" +
    "count select from .prime.buyins where status=`OPEN; count .prime.alerts;" +
    "0^neg sum exec qty from .prime.positions where qty<0;" +
    "0^sum exec last available by sym,lender from `timestamp xasc .prime.inventory)",

  coverage: "0!.prime.positionCoverage[.prime.positions;.prime.locates;.z.p]",
  coverageRollup:
    "0!select shortQty:sum shortQty, locatedQty:sum locatedQty, pairs:count i " +
    "by bucket from .prime.positionCoverage[.prime.positions;.prime.locates;.z.p]",
  locateStatus:
    "0!select requested:sum requested, allocated:sum allocated, n:count i by status from .prime.locates",
  inventory:
    "l:select available:last available, feeBp:last feeBp, recallRisk:last recallRisk," +
    " cpRisk:last counterpartyRisk by sym,lender from `timestamp xasc .prime.inventory;" +
    "0!`available xdesc select available:sum available, feeBp:available wavg feeBp," +
    " recallRisk:available wavg recallRisk, lenders:count i by sym from l",
  borrows: "0!select qty:sum qty, feeBp:qty wavg feeBp, n:count i by sym from .prime.borrows",
  recalls: "0!select qty:sum qty, n:count i by severity from .prime.recalls",
  buyins: "0!select qty:sum qty, n:count i by status from .prime.buyins",
  alerts:
    "15 sublist `timestamp xdesc 0!select timestamp,severity,kind,client,sym,qty,message from .prime.alerts",
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

class PrimeReader extends CepReader {
  constructor(opts) {
    super(opts, QUERIES);
  }

  async read() {
    const r = await this._run();
    const s = r.summary.value || {};
    const covRows = r.coverage.rows || [];
    const invRows = (r.inventory.rows || []).map((row) => ({
      sym: row.sym,
      available: Number(row.available) || 0,
      feeBp: Number(row.feeBp),
      recallRisk: Number(row.recallRisk),
      lenders: Number(row.lenders) || 0,
    }));

    // hard-to-borrow score per sym: fee + scarcity + recall risk
    const maxAvail = Math.max(1, ...invRows.map((row) => row.available));
    const htb = invRows
      .map((row) => ({
        sym: row.sym,
        feeBp: row.feeBp,
        available: row.available,
        recallRisk: row.recallRisk,
        score:
          0.45 * clamp01(row.feeBp / 500) +
          0.35 * (1 - row.available / maxAvail) +
          0.20 * clamp01(row.recallRisk),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const locRows = r.locateStatus.rows || [];
    const totReq = locRows.reduce((a, row) => a + (Number(row.requested) || 0), 0);
    const totAlloc = locRows.reduce((a, row) => a + (Number(row.allocated) || 0), 0);
    const totShort = Number(s.shortQty) || 0;
    const totLocated = covRows.reduce((a, row) => a + (Number(row.locatedQty) || 0), 0);

    return {
      connected: this.connected,
      target: this.target,
      summary: {
        shortQty: totShort,
        availQty: Number(s.availQty) || 0,
        coveragePct: totShort > 0 ? (totLocated / totShort) * 100 : null,
        openLocates: locRows
          .filter((row) => ["LOCATED", "PARTIAL"].includes(row.status))
          .reduce((a, row) => a + (Number(row.n) || 0), 0),
        openBuyins: Number(s.buyinsOpen) || 0,
        alerts: Number(s.alerts) || 0,
        locateFillPct: totReq > 0 ? (totAlloc / totReq) * 100 : null,
      },
      coverage: covRows.map((row) => ({
        client: row.client,
        sym: row.sym,
        shortQty: Number(row.shortQty) || 0,
        locatedQty: Number(row.locatedQty) || 0,
        coverage: row.coverage == null ? 0 : Number(row.coverage),
        bucket: row.bucket,
      })),
      coverageByBucket: (r.coverageRollup.rows || []).map((row) => ({
        bucket: row.bucket,
        shortQty: Number(row.shortQty) || 0,
        locatedQty: Number(row.locatedQty) || 0,
        pairs: Number(row.pairs) || 0,
      })),
      locateStatus: locRows.map((row) => ({
        status: row.status,
        requested: Number(row.requested) || 0,
        allocated: Number(row.allocated) || 0,
        n: Number(row.n) || 0,
      })),
      inventory: invRows,
      htb,
      borrows: (r.borrows.rows || []).map((row) => ({
        sym: row.sym,
        qty: Number(row.qty) || 0,
        feeBp: Number(row.feeBp),
        n: Number(row.n) || 0,
      })),
      recalls: (r.recalls.rows || []).map((row) => ({
        severity: row.severity,
        qty: Number(row.qty) || 0,
        n: Number(row.n) || 0,
      })),
      buyins: (r.buyins.rows || []).map((row) => ({
        status: row.status,
        qty: Number(row.qty) || 0,
        n: Number(row.n) || 0,
      })),
      alerts: r.alerts.rows || [],
    };
  }
}

module.exports = { PrimeReader };
