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
    "{[] l:select available:last available, feeBp:last feeBp, recallRisk:last recallRisk," +
    " cpRisk:last counterpartyRisk by sym,lender from `timestamp xasc .prime.inventory;" +
    "0!`available xdesc select available:sum available, feeBp:available wavg feeBp," +
    " recallRisk:available wavg recallRisk, lenders:count i by sym from l}[]",
  borrows: "0!select qty:sum qty, feeBp:qty wavg feeBp, n:count i by sym from .prime.borrows",
  recalls: "0!select qty:sum qty, n:count i by severity from .prime.recalls",
  buyins: "0!select qty:sum qty, n:count i by status from .prime.buyins",
  alerts:
    "15 sublist `timestamp xdesc 0!select timestamp,severity,kind,client,sym,qty,message from .prime.alerts",

  // Borrow-fee calibration (feeBp vs. realized-vol/ADV percentile), position
  // mark-to-market (real latest close), and short-interest concentration
  // (aggregate shortQty vs. real ADV, across every client) - all three
  // sourced from eq_d1_yfinance by modules/analytics/primeFinance/cep.q's
  // .primeMod.market.refresh (one shared HDB round trip feeds all three).
  // Optional - a module CEP started before this was added, or one whose
  // market-data refresh hasn't run yet (or can't reach eq_hdb), just has
  // these empty, not missing globals.
  calibration: "0!.prime.calibration",
  positionRisk: "0!.prime.positionRisk",
  crowding: "0!.prime.crowding",
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

class PrimeReader extends CepReader {
  constructor(opts) {
    super(opts, QUERIES);
  }

  async read() {
    const r = await this._run({ optional: ["calibration", "positionRisk", "crowding"] });
    const s = r.summary.value || {};
    const covRows = r.coverage.rows || [];

    // Real market data (eq_d1_yfinance, via .primeMod.market.refresh) is
    // per-sym even though .prime.calibration carries a row per (sym,lender) -
    // vol/adv/percentiles are identical across a sym's lenders, so any one
    // row gives the sym-level real reading. Built once and reused below to
    // ground BOTH the inventory table and the HTB score in real data
    // instead of just this book's own internal, synthetic-only numbers.
    const calBySym = new Map();
    for (const row of r.calibration.rows || []) {
      if (!calBySym.has(row.sym)) {
        calBySym.set(row.sym, {
          vol: row.vol == null ? null : Number(row.vol),
          adv: row.adv == null ? null : Number(row.adv),
          volPctile: row.volPctile == null ? null : Number(row.volPctile),
          advPctile: row.advPctile == null ? null : Number(row.advPctile),
        });
      }
    }

    const invRows = (r.inventory.rows || []).map((row) => {
      const cal = calBySym.get(row.sym);
      return {
        sym: row.sym,
        available: Number(row.available) || 0,
        feeBp: Number(row.feeBp),
        recallRisk: Number(row.recallRisk),
        lenders: Number(row.lenders) || 0,
        vol: cal ? cal.vol : null,
        adv: cal ? cal.adv : null,
        volPctile: cal ? cal.volPctile : null,
        advPctile: cal ? cal.advPctile : null,
      };
    });

    // hard-to-borrow score per sym: fee + scarcity, blended with REAL
    // realized-vol/ADV percentile (same market data .prime.calibration
    // already computes) when available for that sym - falls back to the
    // old internal-only recallRisk-based blend only when it isn't (e.g.
    // eq_hdb unreachable, or the market-data refresh hasn't run yet), so
    // the page never goes blank for want of real data, but prefers it.
    const maxAvail = Math.max(1, ...invRows.map((row) => row.available));
    const htb = invRows
      .map((row) => {
        const haveReal = row.volPctile != null && row.advPctile != null;
        const score = haveReal
          ? 0.30 * clamp01(row.feeBp / 500) +
            0.20 * (1 - row.available / maxAvail) +
            0.30 * row.volPctile +
            0.20 * (1 - row.advPctile)
          : 0.45 * clamp01(row.feeBp / 500) +
            0.35 * (1 - row.available / maxAvail) +
            0.20 * clamp01(row.recallRisk);
        return {
          sym: row.sym,
          feeBp: row.feeBp,
          available: row.available,
          recallRisk: row.recallRisk,
          volPctile: row.volPctile,
          advPctile: row.advPctile,
          realData: haveReal,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    // Real $ short value per (client,sym), from .prime.positionRisk's real
    // mark-to-market (real latest close) - joined into `coverage` below so
    // the locate-coverage table shows real dollars, not just share counts.
    // Carries ccy through too: this book now has real HKD (HKEX)/JPY
    // (Nikkei) positions alongside USD ones, and this repo has no real
    // FX-rate feed to convert them with - every $ total below is either
    // USD-only or kept broken out per ccy, never silently blended.
    const riskByKey = new Map();
    for (const row of r.positionRisk.rows || []) {
      riskByKey.set(`${row.client}|${row.sym}`, {
        ccy: row.ccy,
        marketValue: row.marketValue == null ? null : Number(row.marketValue),
        unrealizedPnl: row.unrealizedPnl == null ? null : Number(row.unrealizedPnl),
      });
    }

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
        // Real $ short exposure (real latest close × qty, from
        // .prime.positionRisk) - USD-only (no real FX feed to convert the
        // book's real HKD/JPY positions with, so they're excluded from
        // this headline figure rather than silently blended into it - see
        // those positions individually, in their own currency, in the
        // Position Risk / Crowding pages). A partial sum over whichever USD
        // positions already have a real mark; null only when none do.
        shortValue: (r.positionRisk.rows || []).some((row) => row.ccy === "USD" && row.marketValue != null)
          ? (r.positionRisk.rows || [])
              .filter((row) => row.qty < 0 && row.ccy === "USD" && row.marketValue != null)
              .reduce((a, row) => a + Math.abs(Number(row.marketValue)), 0)
          : null,
        availQty: Number(s.availQty) || 0,
        coveragePct: totShort > 0 ? (totLocated / totShort) * 100 : null,
        openLocates: locRows
          .filter((row) => ["LOCATED", "PARTIAL"].includes(row.status))
          .reduce((a, row) => a + (Number(row.n) || 0), 0),
        openBuyins: Number(s.buyinsOpen) || 0,
        alerts: Number(s.alerts) || 0,
        locateFillPct: totReq > 0 ? (totAlloc / totReq) * 100 : null,
      },
      coverage: covRows.map((row) => {
        const risk = riskByKey.get(`${row.client}|${row.sym}`);
        return {
          client: row.client,
          sym: row.sym,
          shortQty: Number(row.shortQty) || 0,
          locatedQty: Number(row.locatedQty) || 0,
          coverage: row.coverage == null ? 0 : Number(row.coverage),
          bucket: row.bucket,
          ccy: risk ? risk.ccy : null,
          shortValue: risk ? risk.marketValue : null,
          unrealizedPnl: risk ? risk.unrealizedPnl : null,
        };
      }),
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
      calibration: (r.calibration.rows || []).map((row) => ({
        sym: row.sym,
        lender: row.lender,
        ccy: row.ccy,
        feeBp: Number(row.feeBp),
        vol: row.vol == null ? null : Number(row.vol),
        adv: row.adv == null ? null : Number(row.adv),
        volPctile: row.volPctile == null ? null : Number(row.volPctile),
        advPctile: row.advPctile == null ? null : Number(row.advPctile),
        expectedFeeBp: Number(row.expectedFeeBp),
        richCheapBp: Number(row.richCheapBp),
        flag: row.flag,
      })),
      positionRisk: (r.positionRisk.rows || []).map((row) => ({
        client: row.client,
        sym: row.sym,
        ccy: row.ccy,
        qty: Number(row.qty) || 0,
        avgPx: row.avgPx == null ? null : Number(row.avgPx),
        currentPx: row.currentPx == null ? null : Number(row.currentPx),
        marketValue: row.marketValue == null ? null : Number(row.marketValue),
        unrealizedPnl: row.unrealizedPnl == null ? null : Number(row.unrealizedPnl),
        pnlPct: row.pnlPct == null ? null : Number(row.pnlPct),
        side: row.side,
      })),
      crowding: (r.crowding.rows || []).map((row) => ({
        sym: row.sym,
        ccy: row.ccy,
        shortQty: Number(row.shortQty) || 0,
        numClients: Number(row.numClients) || 0,
        close: row.close == null ? null : Number(row.close),
        adv: row.adv == null ? null : Number(row.adv),
        shortValue: row.shortValue == null ? null : Number(row.shortValue),
        daysToCover: row.daysToCover == null ? null : Number(row.daysToCover),
        bucket: row.bucket,
      })),
    };
  }
}

module.exports = { PrimeReader };
