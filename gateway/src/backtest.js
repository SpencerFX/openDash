"use strict";

const { QSession } = require("./qSession");
const { symbolLit, BadInput } = require("./qlit");

// Backtest dashboard - modules/backtest/service.q, the long-running
// counterpart to modules/backtest/run.q's one-shot CLI report (see that
// file's own header). Loads C:/data/db1/efx (schema_efx.q's
// fx_m1_massive) once at startup and exposes .bt.svc.run/.bt.svc.meta
// over IPC so a request here runs a fresh pipeline against
// already-mapped data instead of reloading the archive from disk.
//
//   meta()   -> symbols + their available date range, and every
//        strategy/portfolio/risk/execution name with its own param list
//        (mirrors .bt.svc.meta[] - see that file). Feeds the page's
//        pickers so this file's STRATEGIES/RISKS/EXECUTIONS table below
//        never drifts from the q side's own dispatch.
//   run({sym,sDate,eDate,strategy,strategyParams,portfolio,risk,
//        execution,costBp,lag,maxAbsPos,ddLimit,phaseIn,barsPerYear})
//            -> { stats, curve: [{t,close,direction,pos,netRet,equity},...] }
//
// Every dynamic value is rendered as a validated q literal (qlit.js) into
// one .bt.svc.run[...] call string - never a client string forwarded
// verbatim - the same discipline buildGwQuery uses for /api/query.
//
// The backtest service is not always up - start it with
// scripts/startStop/startupBacktest.sh. Every call fails soft with a 503
// when it's down.

const STRATEGIES = {
  sma: { fastN: "int", slowN: "int" },
  meanrev: { lookback: "int", zEntry: "float" },
  momentum: { lookback: "int" },
  candle: { pattern: "symbol" },
};
const PORTFOLIOS = ["direction", "confweighted"];
const RISKS = ["none", "maxpos", "maxdd"];
const EXECUTIONS = ["immediate", "twap"];

const PAT_RE = /^[A-Za-z]{2,40}$/; // candle.q pattern names are plain lowerCamel identifiers
const DATE_RE = /^\d{4}[-.]\d{2}[-.]\d{2}$/; // "YYYY-MM-DD" (<input type=date>) or "YYYY.MM.DD"

const toMs = (v) => (v instanceof Date ? v.getTime() : v == null ? null : Date.parse(v));
const dstr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));

function intLit(v, name) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new BadInput(`invalid ${name}: ${JSON.stringify(v)}`);
  return `${n}j`;
}
function floatLit(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadInput(`invalid ${name}: ${JSON.stringify(v)}`);
  return `${n}f`;
}
function dateLit(v, name) {
  const s = String(v || "");
  if (!DATE_RE.test(s)) throw new BadInput(`invalid ${name} (expected YYYY-MM-DD): ${JSON.stringify(v)}`);
  return s.replace(/-/g, ".");
}
function patternLit(v) {
  const s = String(v || "").trim();
  if (!PAT_RE.test(s)) throw new BadInput(`invalid pattern: ${JSON.stringify(v)}`);
  return "`" + s;
}
function enumLit(v, allowed, name) {
  const s = String(v || "");
  if (!allowed.includes(s)) throw new BadInput(`unknown ${name}: ${JSON.stringify(v)} (expected one of ${allowed.join(", ")})`);
  return "`" + s;
}
// one small dict as q literal text - `(enlist`k)!enlist v` for one entry
// (the convention modules/backtest/run.q's own statsCfg already uses),
// ``k1`k2!(v1;v2)`` for more than one.
function dictLit(pairs) {
  if (pairs.length === 0) return "()!()";
  if (pairs.length === 1) return `(enlist\`${pairs[0][0]})!enlist ${pairs[0][1]}`;
  return "`" + pairs.map(([k]) => k).join("`") + "!(" + pairs.map(([, v]) => v).join(";") + ")";
}

class BacktestReader {
  constructor(opts) {
    this.session = new QSession({
      host: opts.host,
      port: opts.port,
      timeoutMs: opts.timeoutMs || 30000,
      reconnectMs: 2000,
      label: "backtest",
    });
    this._meta = { at: 0, data: null };
  }

  start() {
    this.session.start();
    return this;
  }
  async stop() {
    await this.session.stop();
  }
  get connected() {
    return this.session.connected;
  }
  status() {
    return { enabled: true, target: this.session.target, connected: this.session.connected };
  }

  _requireUp() {
    if (!this.session.connected) {
      const e = new Error(
        `backtest service not reachable at ${this.session.target} - start it with scripts/startStop/startupBacktest.sh`
      );
      e.statusCode = 503;
      throw e;
    }
  }

  async meta() {
    if (this._meta.data && Date.now() - this._meta.at < 5 * 60 * 1000) return this._meta.data;
    this._requireUp();
    const r = await this.session.sync(".bt.svc.meta[]", { timeoutMs: 30000 });
    const s = (r && r.syms) || {};
    const symbols = Array.isArray(s.sym)
      ? s.sym.map((sym, i) => ({ sym: String(sym), sDate: dstr(s.sDate[i]), eDate: dstr(s.eDate[i]) }))
      : [];
    const data = {
      connected: true,
      symbols,
      strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, Object.keys(v)])),
      portfolios: PORTFOLIOS,
      risks: RISKS,
      executions: EXECUTIONS,
    };
    this._meta = { at: Date.now(), data };
    return data;
  }

  async run(req) {
    this._requireUp();

    const sym = symbolLit(String(req.sym || "").trim());
    const sDate = dateLit(req.sDate, "sDate");
    const eDate = dateLit(req.eDate, "eDate");

    const strategy = String(req.strategy || "");
    const strategyShape = STRATEGIES[strategy];
    if (!strategyShape) throw new BadInput(`unknown strategy: ${JSON.stringify(req.strategy)} (expected ${Object.keys(STRATEGIES).join(", ")})`);
    const sp = req.strategyParams || {};
    const spPairs = Object.entries(strategyShape).map(([name, kind]) => {
      const v = sp[name];
      if (kind === "int") return [name, intLit(v, name)];
      if (kind === "float") return [name, floatLit(v, name)];
      return [name, patternLit(v)]; // symbol
    });

    const portfolio = enumLit(req.portfolio, PORTFOLIOS, "portfolio");
    const risk = enumLit(req.risk, RISKS, "risk");
    const execution = enumLit(req.execution, EXECUTIONS, "execution");
    const pipelinePairs = [
      ["portfolio", portfolio],
      ["risk", risk],
      ["execution", execution],
    ];

    // always all six - a stage simply ignores keys it doesn't read, same
    // as .bt.run/.bt.stats' own contract (see backtest.q's header)
    const cfgPairs = [
      ["costBp", floatLit(req.costBp ?? 1, "costBp")],
      ["lag", intLit(req.lag ?? 1, "lag")],
      ["maxAbsPos", floatLit(req.maxAbsPos ?? 0.5, "maxAbsPos")],
      ["ddLimit", floatLit(req.ddLimit ?? 0.05, "ddLimit")],
      ["phaseIn", intLit(req.phaseIn ?? 5, "phaseIn")],
      ["barsPerYear", floatLit(req.barsPerYear ?? 132480, "barsPerYear")],
    ];

    const q =
      `.bt.svc.run[${sym};${sDate};${eDate};\`${strategy};` +
      `${dictLit(spPairs)};${dictLit(pipelinePairs)};${dictLit(cfgPairs)}]`;

    const r = await this.session.sync(q, { timeoutMs: this.session.timeoutMs });
    const stats = r && r.stats ? Object.fromEntries(Object.entries(r.stats).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])) : {};
    const c = (r && r.curve) || {};
    const n = Array.isArray(c.timestamp) ? c.timestamp.length : 0;
    const curve = new Array(n);
    for (let i = 0; i < n; i++) {
      curve[i] = {
        t: toMs(c.timestamp[i]),
        close: c.close ? Number(c.close[i]) : null,
        direction: c.direction ? Number(c.direction[i]) : null,
        pos: c.pos ? Number(c.pos[i]) : null,
        netRet: c.netRet ? Number(c.netRet[i]) : null,
        equity: c.equity ? Number(c.equity[i]) : null,
      };
    }

    return {
      sym: String(req.sym || "").trim(),
      sDate: sDate,
      eDate: eDate,
      strategy,
      portfolio: String(req.portfolio || ""),
      risk: String(req.risk || ""),
      execution: String(req.execution || ""),
      bars: n,
      stats,
      curve,
    };
  }
}

module.exports = { BacktestReader };
