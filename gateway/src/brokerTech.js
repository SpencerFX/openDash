"use strict";

const { QGateway } = require("./qGateway");
const { toRows } = require("./qshape");

// Retail brokerage & risk analytics for the "Broker Tech" page suite (main
// dashboard, Client Clusters, Trader Segments, CCY, SSI, Book Margin/P&L,
// Volume, and the 4 AI pages - Predicted Risk/Profitability/Attrition +
// Adaptive Toxicity Classifier). Routed through openQ's own gw (retailR_gw,
// cfg_proc/modules/retailR/gw.json, default 127.0.0.1:5125) rather than
// connecting straight to retailR_hdb/brokerTech_hdb - requested purely for
// benchmarking/visibility (System > Query Mon), same rationale as the
// econCal migration: this is a pure batch analytics HDB, no live feed, no
// RDB leg ever, so there's no "today" gap to fix here either. retailR_gw's
// rdbaddr and hdbaddr both point at retailR_hdb itself (there being no real
// rdb) - same single-connection-registers-once behaviour as calendar_gw.
//
// Each page's query logic lives server-side as a named .brk.api.* function
// (modules/analytics/brokerTech/api.q, loaded on both retailR_hdb and the
// legacy brokerTech_hdb) - one per page, mirroring the .oq.gw.brk* client
// entry points (openQ core/gw.q) this file calls through QGateway below.
// These used to be built here as raw q-string templates and sent over a
// plain sync IPC call (bypassing .util.gw entirely); see api.q's own header.
//
// The window pull itself goes through .brk.src.trade/.brk.src.equity/
// .brk.src.sig/.brk.src.monthly (defined in brokerTech.q, see its own
// "Source-window pulls" section) rather than a bare "select ... from
// trade/equity/sig/monthly" - server-side code never needs to know which of
// the two real HDBs it's loaded on:
//   retailR_hdb (cfg_proc/modules/retailR/hdb.json, port 5079, hdbroot
//     C:/data/r) - the default. Two platforms (mql5.com Signals +
//     myfxbook.com), pre-merged by the ingest pipeline into
//     platform+acctId-keyed trade/equity/growth tables; brokerTechSourceR.q
//     (loaded after brokerTech.q on that HDB only) overrides .brk.src.* to
//     synthesize a collision-free signalId from (platform;acctId) and
//     backfill myfxbook's missing kind/cancelled/orderType - see that
//     file's header for the full mapping and why.
//   brokerTech_hdb (cfg_proc/modules/brokerTech/hdb.json, port 5077,
//     hdbroot C:/data/retail) - the original single-platform (mql5.com
//     Signals only) HDB, now legacy but left running; .brk.src.* on that
//     HDB is brokerTech.q's own default (a plain windowed select - trade/
//     equity/sig were already in exactly this shape). Not yet given its own
//     gw (OPENQ_BROKERTECH_HDB has no gw-routed counterpart) - only
//     retailR_hdb, the active default, was migrated.
//
// The whole suite is a batch recompute over a date window (~1s for 90d / ~30k
// trades, more for wider windows), so responses are cached per parameter set
// with a TTL and a single-in-flight guard - the page polls, the HDB isn't
// hammered.

const num = (v) => (v == null || Number.isNaN(v) ? null : Number(v));
const dstr = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10);

// The 12 SUITE/CLUSTER_QUERY/SEGMENT_QUERY/CCY_QUERY/SSI_QUERY/MARGIN_QUERY/
// AI_RISK_QUERY/VFDT_QUERY/PROFIT_QUERY/HOURLY_QUERY/VOLUME_QUERY/CHURN_QUERY
// q-string templates that used to live here (built client-side, sent over a
// plain sync IPC call - .session.sync(...)) now live server-side as named
// .brk.api.* functions (modules/analytics/brokerTech/api.q), dispatched
// through openQ's own .oq.gw.brk* (core/gw.q) via QGateway below - same
// benchmarking/visibility rationale as the econCal migration (this HDB has
// no RDB leg to gain, it's purely for System > Query Mon).

class BrokerTechReader {
  constructor(opts) {
    this.enabled = opts.enabled !== false;
    this.defaults = {
      lookbackDays: opts.lookbackDays || 30,
      minTrades: opts.minTrades || 10,
      topN: opts.topN || 15,
    };
    this.ttlMs = Math.max(5000, opts.ttlMs || 60000);
    this.timeoutMs = Math.max(5000, opts.timeoutMs || 45000);
    this.gateway = new QGateway({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      poolSize: Math.max(1, opts.poolSize || 2),
      queryTimeoutMs: this.timeoutMs,
      useBigInt: opts.useBigInt,
    });
    this._cache = new Map(); // key -> { at, data }
    this._inflight = new Map(); // key -> Promise
    this._clusterCache = new Map(); // key -> { at, data }
    this._clusterInflight = new Map(); // key -> Promise
    this._marginCache = new Map(); // key -> { at, data }
    this._marginInflight = new Map(); // key -> Promise
    this._segmentCache = new Map(); // key -> { at, data }
    this._segmentInflight = new Map(); // key -> Promise
    this._ccyCache = new Map(); // key -> { at, data }
    this._ccyInflight = new Map(); // key -> Promise
    this._ssiCache = new Map(); // key -> { at, data }
    this._ssiInflight = new Map(); // key -> Promise
    this._vfdtCache = new Map(); // key -> { at, data }
    this._vfdtInflight = new Map(); // key -> Promise
    this._profitCache = new Map(); // key -> { at, data }
    this._profitInflight = new Map(); // key -> Promise
    this._hourlyCache = new Map(); // key -> { at, data }
    this._hourlyInflight = new Map(); // key -> Promise
    this._aiRiskCache = new Map(); // key -> { at, data }
    this._aiRiskInflight = new Map(); // key -> Promise
    this._churnCache = new Map(); // key -> { at, data }
    this._churnInflight = new Map(); // key -> Promise
    this._volumeCache = new Map(); // key -> { at, data }
    this._volumeInflight = new Map(); // key -> Promise
  }

  start() { this.gateway.start(); return this; }
  async stop() { await this.gateway.stop(); }
  get connected() { return this.gateway.readyCount() > 0; }

  status() {
    return {
      enabled: this.enabled,
      target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
      connected: this.connected,
      gw: this.gateway.status(),
    };
  }

  _requireUp() {
    if (!this.connected) {
      const e = new Error(
        `retailR_gw not reachable at ${this.gateway.opts.host}:${this.gateway.opts.port} - start it ` +
          `(scripts/startStop/startupAllByModule.sh retailR) with modules/analytics/brokerTech/` +
          `{brokerTech,brokerTechSourceR,api}.q in its hdb.json libraries`
      );
      e.statusCode = 503;
      throw e;
    }
  }

  _clamp(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return {
      lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000),
      minTrades: i(q.minTrades, this.defaults.minTrades, 0, 10000),
      topN: i(q.top, this.defaults.topN, 3, 60),
    };
  }

  _clampClusters(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return {
      lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000),
      k: i(q.k, 5, 2, 12),
      minTrades: i(q.minTrades, this.defaults.minTrades, 0, 10000),
    };
  }

  _clampMargin(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    // default window is a year, not the SUITE default of 90d - the daily
    // history chart is the whole point of this page and 90 points is thin
    //
    // broker is a strict allowlist (letters/digits/spaces only, matching
    // .brk.broker.keywords' canonicals + `UNKNOWN) BEFORE it's ever
    // embedded into a q query string - see margin()'s brokerTagLit.
    // Anything else (or "ALL"/empty) falls back to "" = no filter.
    const brokerRaw = q.broker == null ? "" : String(q.broker).trim();
    const broker = /^[A-Za-z0-9 ]{1,40}$/.test(brokerRaw) && brokerRaw.toUpperCase() !== "ALL" ? brokerRaw : "";
    return { lookbackDays: i(q.lookbackDays, 365, 1, 4000), broker };
  }

  _clampVolume(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    // same strict allowlist + "ALL"/empty => no filter convention as
    // _clampMargin - see margin()'s brokerTagLit for why this is safe to
    // splice into the q query string.
    const brokerRaw = q.broker == null ? "" : String(q.broker).trim();
    const broker = /^[A-Za-z0-9 ]{1,40}$/.test(brokerRaw) && brokerRaw.toUpperCase() !== "ALL" ? brokerRaw : "";
    return { lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000), broker };
  }

  _clampSegments(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return {
      lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000),
      minTrades: i(q.minTrades, this.defaults.minTrades, 0, 10000),
    };
  }

  _clampCcy(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    // symbol is a strict allowlist (letters/digits/._- only, matching the
    // real symbol shapes seen in this data - EURUSD, XAUUSD-P, BTCUSD)
    // BEFORE it's ever embedded into a q query string - see ccy()'s
    // symbolLit. Anything else falls back to the EURUSD default.
    const symRaw = q.symbol == null ? "" : String(q.symbol).trim();
    const symbol = /^[A-Za-z0-9._-]{1,20}$/.test(symRaw) ? symRaw : "EURUSD";
    // a longer default than SUITE's 90d - "duration available" (first/last
    // seen, daily activity trend) is one of this page's own headline
    // questions, and needs more than 90 points to say anything useful.
    return { lookbackDays: i(q.lookbackDays, 180, 1, 4000), symbol };
  }

  _clampSsi(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    const symRaw = q.symbol == null ? "" : String(q.symbol).trim();
    const symbol = /^[A-Za-z0-9._-]{1,20}$/.test(symRaw) ? symRaw : "EURUSD";
    // recent positioning, not a year of history - SSI is meant to read as
    // "current sentiment", and a long window smears that into an average
    // that stops meaning "now". Shorter default than CCY's 180d.
    return {
      lookbackDays: i(q.lookbackDays, 30, 1, 4000),
      topN: i(q.topN, 20, 5, 40),
      symbol,
    };
  }

  _clampAiRisk(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return { lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000) };
  }

  _clampProfit(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return { lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000) };
  }

  _clampChurn(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return { lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000) };
  }

  _clampHourly(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    const f = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    // defaults per openq-notebook's backtest sweep (see brokertech_dashboard.md):
    // lookbackWeeks=20 (lookbackDays=180 to cover it with room to spare) was the
    // best-performing tested config, though it's a near-dead-heat with the flat
    // no-day-of-week baseline (liftVsFlat ~1.0) - honestly reported, not hidden.
    const lookbackWeeks = i(q.lookbackWeeks, 20, 4, 26);
    // date: a specific day to compare predicted-vs-actual for, instead of
    // the latest available one - validated strictly as YYYY-MM-DD before
    // ever reaching the query string (this becomes a literal q date, not a
    // bound parameter). Anything else (absent, malformed) means "latest".
    const dateRaw = q.date == null ? "" : String(q.date).trim();
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateRaw);
    const date = dateMatch ? `${dateMatch[1]}.${dateMatch[2]}.${dateMatch[3]}` : null;
    return {
      lookbackWeeks,
      lookbackDays: i(q.lookbackDays, 7 * (lookbackWeeks + 4), 30, 400),
      testDays: i(q.testDays, 14, 3, 60),
      zCut: f(q.zCut, 1.5, 0.5, 5),
      date,
    };
  }

  _clampVfdt(q) {
    const i = (v, def, lo, hi) => {
      if (v == null || v === "") return def;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return { lookbackDays: i(q.lookbackDays, this.defaults.lookbackDays, 1, 4000) };
  }

  _rows(tbl) {
    return (toRows(tbl).rows || []).map((r) => {
      const o = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v;
      }
      return o;
    });
  }

  // a .brk.segment.summary result renamed to a common `tier` string field
  // (dropping the dimension-specific column name) plus bigint/Date
  // normalisation - see segments()'s comment on why this exists.
  _tierRows(tbl, tierCol) {
    return this._rows(tbl).map((r) => {
      const { [tierCol]: tier, ...rest } = r;
      return { tier: tier == null ? null : String(tier), ...rest };
    });
  }

  // a q dict comes back as a plain object of scalars/arrays; normalise Dates/bigint
  _dict(d) {
    if (!d || typeof d !== "object") return {};
    const o = {};
    for (const k of Object.keys(d)) {
      const v = d[k];
      o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v;
    }
    return o;
  }

  async read(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clamp(query);
    const key = `${p.lookbackDays}|${p.minTrades}|${p.topN}`;

    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._inflight.has(key)) return this._inflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkSuite(p.lookbackDays, p.minTrades, p.topN);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const revI = d.revByInstrument || {};
      const perf = d.profitability || {};
      const routing = this._rows(d.routing).map((r) => ({
        route: String(r.route),
        nProviders: num(r.nProviders),
        expectedRev: num(r.expectedRev),
        bBookRev: num(r.bBookRev),
        aBookRev: num(r.aBookRev),
        rationale: r.rationale == null ? null : String(r.rationale),
      }));

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          nEquityRows: num(meta.nEquityRows),
          nMonthlyRows: num(meta.nMonthlyRows),
          nSignals: num(meta.nSignals),
          nActive: num(meta.nActive),
          lookbackDays: num(meta.lookbackDays),
          minTrades: num(meta.minTrades),
          topN: num(meta.topN),
        },
        summary: this._dict(d.summary),
        revByInstrument: {
          best: this._rows(revI.best),
          worst: this._rows(revI.worst),
        },
        bookConcentration: this._dict(d.bookConcentration),
        peakConcurrent: this._rows(d.peakConcurrent),
        profitability: {
          winners: this._rows(perf.winners),
          losers: this._rows(perf.losers),
        },
        drawdown: this._rows(d.drawdown),
        toxicity: this._rows(d.toxicity),
        toxBuckets: this._rows(d.toxBuckets),
        routing,
        optimise: this._dict(d.optimise),
        // full per-signal A/B routing detail (every active provider) + the
        // desk's actual current threshold policy - the A/B Book page's
        // what-if simulator re-derives .brk.book.recommend's route decision
        // client-side from these raw fields under adjustable thresholds.
        routingDetail: this._rows(d.routingDetail),
        thresholds: this._dict(d.thresholds),
        brokerRouting: this._rows(d.brokerRouting),
        // toxicity deep-dive (Toxic Analysis page): every active provider's
        // 5 component scores + exec-quality context, revenue-at-risk by
        // bucket, average component profile per bucket, and the desk's
        // real .brk.cfg weights/thresholds for the frontend's simulator.
        toxDetail: this._rows(d.toxDetail),
        toxBucketRev: this._rows(d.toxBucketRev),
        toxBucketProfile: this._rows(d.toxBucketProfile),
        toxCfg: this._dict(d.toxCfg),
        // execution quality (Execution Quality page): order mix + stop-
        // slippage, never surfaced before this - .brk.exec.orderMix and
        // .brk.exec.stopSlippage were written but unused until now.
        execDetail: this._rows(d.execDetail),
        execRollup: this._dict(d.execRollup),
        alerts: this._rows(d.alerts),
        alertsByKind: this._rows(d.alertsByKind),
        brokerScorecard: this._rows(d.brokerScorecard),
        brokerRevenue: this._rows(d.brokerRevenue),
      };

      this._cache.set(key, { at: Date.now(), data });
      // keep the per-param cache small
      if (this._cache.size > 16) {
        const oldest = [...this._cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._cache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._inflight.delete(key));

    this._inflight.set(key, job);
    return job;
  }

  // Client Clusters page: deterministic k-means over behavioural features
  // (.brk.cluster.run). Own cache/in-flight map, keyed on (lookbackDays,k,minTrades).
  async clusters(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampClusters(query);
    const key = `${p.lookbackDays}|${p.k}|${p.minTrades}`;

    const hit = this._clusterCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._clusterInflight.has(key)) return this._clusterInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkCluster(p.lookbackDays, p.k, p.minTrades);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const clients = this._rows(d.clients).map((r) => ({
        ...r,
        label: r.label == null ? null : String(r.label),
        dominantSession: r.dominantSession == null ? null : String(r.dominantSession),
        top1Symbol: r.top1Symbol == null ? null : String(r.top1Symbol),
      }));
      const clusters = this._rows(d.clusters).map((r) => ({
        ...r,
        label: r.label == null ? null : String(r.label),
      }));

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          k: num(meta.k),
          minTrades: num(meta.minTrades),
          nClients: num(meta.nClients),
        },
        clients,
        clusters,
      };

      this._clusterCache.set(key, { at: Date.now(), data });
      if (this._clusterCache.size > 16) {
        const oldest = [...this._clusterCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._clusterCache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._clusterInflight.delete(key));

    this._clusterInflight.set(key, job);
    return job;
  }

  // Trader Segments page: explicit activity/size/frequency/session
  // grouping (.brk.segment.*) - own cache/in-flight map, keyed on
  // (lookbackDays, minTrades). See SEGMENT_QUERY's own header for why
  // this is a separate page from Client Clusters, not a merge of the two.
  async segments(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampSegments(query);
    const key = `${p.lookbackDays}|${p.minTrades}`;

    const hit = this._segmentCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._segmentInflight.has(key)) return this._segmentInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkSegment(p.lookbackDays, p.minTrades);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const strCols = (rows, cols) =>
        rows.map((r) => {
          const o = { ...r };
          for (const c of cols) o[c] = o[c] == null ? null : String(o[c]);
          return o;
        });
      const clients = strCols(this._rows(d.clients), [
        "name", "authorName", "mtVersion", "top1Symbol", "dominantSession",
        "bucket", "activityTier", "sizeTier", "freqTier", "sessionTier",
      ]);
      // each by* row also carries nProviders/nTrades/totalLots/avgLots/
      // avgHoldMin/tradesPerDay/winRatePct/clientNetProfit/totalRev/toxScore
      // straight through from .brk.segment.summary - only the tier label
      // itself needs the bigint/symbol -> string treatment below.
      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          minTrades: num(meta.minTrades),
          nClients: num(meta.nClients),
        },
        clients,
        // each row's own tier column renamed to a common `tier` field, so
        // the frontend can iterate all 4 breakdowns with one code path
        // instead of branching on which dimension's column name to read.
        byActivity: this._tierRows(d.byActivity, "activityTier"),
        bySize: this._tierRows(d.bySize, "sizeTier"),
        byFreq: this._tierRows(d.byFreq, "freqTier"),
        bySession: this._tierRows(d.bySession, "sessionTier"),
      };

      this._segmentCache.set(key, { at: Date.now(), data });
      if (this._segmentCache.size > 16) {
        const oldest = [...this._segmentCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._segmentCache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._segmentInflight.delete(key));

    this._segmentInflight.set(key, job);
    return job;
  }

  // CCY page: one symbol's behavioural + brokerage profile (.brk.ccy.*).
  // Own cache/in-flight map, keyed on (lookbackDays, symbol).
  async ccy(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampCcy(query);
    const key = `${p.lookbackDays}|${p.symbol}`;

    const hit = this._ccyCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._ccyInflight.has(key)) return this._ccyInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      // p.symbol was already validated against a strict allowlist in
      // _clampCcy - qGateway's brkCcy re-validates via qlit's castSymbolLit.
      const { data: d } = await this.gateway.brkCcy(p.lookbackDays, p.symbol);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const headlineRows = this._rows(d.headline).map((r) => ({ ...r, symbol: r.symbol == null ? null : String(r.symbol) }));
      const strTierCol = (rows, col) => rows.map((r) => ({ ...r, [col]: r[col] == null ? null : String(r[col]) }));

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          lookbackDays: num(meta.lookbackDays),
          symbol: meta.symbol == null ? null : String(meta.symbol),
        },
        // every symbol traded this window, for the dropdown - always the
        // FULL population regardless of which symbol is selected.
        symbols: strTierCol(this._rows(d.symbols), "symbol"),
        headline: headlineRows[0] || null,
        holdDist: strTierCol(this._rows(d.holdDist), "band"),
        sizeDist: strTierCol(this._rows(d.sizeDist), "band"),
        sessionMix: strTierCol(this._rows(d.sessionMix), "session"),
        daily: this._rows(d.daily).map((r) => ({ ...r, date: dstr(r.date) })),
        brokers: strTierCol(this._rows(d.brokers), "brokerTag"),
      };

      this._ccyCache.set(key, { at: Date.now(), data });
      if (this._ccyCache.size > 32) {
        const oldest = [...this._ccyCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._ccyCache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._ccyInflight.delete(key));

    this._ccyInflight.set(key, job);
    return job;
  }

  // SSI page: long/short split for the top N symbols (.brk.ssi.bySymbol)
  // plus a per-broker drill-down for one symbol (.brk.ssi.byBroker). Own
  // cache/in-flight map, keyed on (lookbackDays, topN, symbol).
  async ssi(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampSsi(query);
    const key = `${p.lookbackDays}|${p.topN}|${p.symbol}`;

    const hit = this._ssiCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._ssiInflight.has(key)) return this._ssiInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      // p.symbol was already validated against a strict allowlist in
      // _clampSsi - qGateway's brkSsi re-validates via qlit's castSymbolLit.
      const { data: d } = await this.gateway.brkSsi(p.lookbackDays, p.topN, p.symbol);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const strCol = (rows, col) => rows.map((r) => ({ ...r, [col]: r[col] == null ? null : String(r[col]) }));

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          lookbackDays: num(meta.lookbackDays),
          topN: num(meta.topN),
          drillSymbol: meta.drillSymbol == null ? null : String(meta.drillSymbol),
        },
        // every traded symbol this window, for the drill-down dropdown -
        // always the FULL population, independent of topN/drillSymbol.
        allSymbols: strCol(this._rows(d.allSymbols), "symbol"),
        bySymbol: strCol(this._rows(d.bySymbol), "symbol"),
        byBroker: strCol(this._rows(d.byBroker), "brokerTag"),
      };

      this._ssiCache.set(key, { at: Date.now(), data });
      if (this._ssiCache.size > 32) {
        const oldest = [...this._ssiCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._ssiCache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._ssiInflight.delete(key));

    this._ssiInflight.set(key, job);
    return job;
  }

  // Predicted Risk Score page: live cold-start classifier scores next to
  // the deterministic toxScore for every currently-active provider, plus
  // the static feature-importance panel and walk-forward validation
  // summary. Own cache/in-flight map, keyed on lookbackDays alone.
  async aiRisk(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampAiRisk(query);
    const key = `${p.lookbackDays}`;

    const hit = this._aiRiskCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._aiRiskInflight.has(key)) return this._aiRiskInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkAiRisk(p.lookbackDays);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const watchlist = this._rows(d.watchlist).map((r) => ({
        ...r,
        bucket: r.bucket == null ? null : String(r.bucket),
      }));
      const importance = this._rows(d.importance).map((r) => ({
        ...r,
        feature: r.feature == null ? null : String(r.feature),
      }));
      const validation = this._dict(d.validation);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          nScored: num(meta.nScored),
          lookbackDays: num(meta.lookbackDays),
        },
        watchlist,
        importance,
        validation: {
          nFolds: num(validation.nFolds),
          meanAuc: num(validation.meanAuc),
          stdAuc: num(validation.stdAuc),
          meanPrecisionAtDecile: num(validation.meanPrecisionAtDecile),
          stdPrecisionAtDecile: num(validation.stdPrecisionAtDecile),
          meanBaseRate: num(validation.meanBaseRate),
          lift: num(validation.lift),
          nAccounts: num(validation.nAccounts),
          gbtAuc: num(validation.gbtAuc),
          logitAucSameFold: num(validation.logitAucSameFold),
          earlyDays: num(validation.earlyDays),
          labelDays: num(validation.labelDays),
        },
      };

      this._aiRiskCache.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => this._aiRiskInflight.delete(key));

    this._aiRiskInflight.set(key, job);
    return job;
  }

  // Predicted Profitability Score page: same batch-LR framework as aiRisk()
  // above, aimed at the desk's other cold-start question (see
  // .brk.profit.* in brokerTech.q). Own cache/in-flight map.
  async profit(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampProfit(query);
    const key = `${p.lookbackDays}`;

    const hit = this._profitCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._profitInflight.has(key)) return this._profitInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkProfit(p.lookbackDays);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const watchlist = this._rows(d.watchlist);
      const importance = this._rows(d.importance).map((r) => ({
        ...r,
        feature: r.feature == null ? null : String(r.feature),
      }));
      const validation = this._dict(d.validation);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          nScored: num(meta.nScored),
          lookbackDays: num(meta.lookbackDays),
        },
        watchlist,
        importance,
        validation: {
          nFolds: num(validation.nFolds),
          meanAuc: num(validation.meanAuc),
          stdAuc: num(validation.stdAuc),
          meanPrecisionAtDecile: num(validation.meanPrecisionAtDecile),
          stdPrecisionAtDecile: num(validation.stdPrecisionAtDecile),
          meanBaseRate: num(validation.meanBaseRate),
          lift: num(validation.lift),
          nAccounts: num(validation.nAccounts),
          gbtAuc: num(validation.gbtAuc),
          logitAucSameFold: num(validation.logitAucSameFold),
          earlyDays: num(validation.earlyDays),
          labelDays: num(validation.labelDays),
        },
      };

      this._profitCache.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => this._profitInflight.delete(key));

    this._profitInflight.set(key, job);
    return job;
  }

  // Predicted Time of Trading page: desk-wide hourly activity forecast (see
  // .brk.hourly.* in brokerTech.q) - a seasonal time-series model, not a
  // per-account scorer, so this returns today's predicted-vs-actual series,
  // the day-of-week x hour heatmap, flagged anomalous hours, and a
  // walk-forward backtest. Own cache/in-flight map.
  async hourly(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampHourly(query);
    const key = `${p.lookbackDays}:${p.lookbackWeeks}:${p.testDays}:${p.zCut}:${p.date || "curr"}`;

    const hit = this._hourlyCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._hourlyInflight.has(key)) return this._hourlyInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkHourly(
        p.lookbackDays, p.lookbackWeeks, p.testDays, p.zCut, p.date || "0Nd"
      );
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const backtest = this._dict(d.backtest);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          heatmapStart: dstr(meta.heatmapStart),
          heatmapEnd: dstr(meta.heatmapEnd),
          lookbackDays: num(meta.lookbackDays),
          lookbackWeeks: num(meta.lookbackWeeks),
          testDays: num(meta.testDays),
          zCut: num(meta.zCut),
          latestDate: dstr(meta.latestDate),
        },
        today: this._rows(d.today),
        heatmap: this._rows(d.heatmap),
        anomalies: this._rows(d.anomalies),
        backtest: {
          nDays: num(backtest.nDays),
          meanMae: num(backtest.meanMae),
          meanSmape: num(backtest.meanSmape),
          meanFlatMae: num(backtest.meanFlatMae),
          liftVsFlat: num(backtest.liftVsFlat),
        },
      };

      this._hourlyCache.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => this._hourlyInflight.delete(key));

    this._hourlyInflight.set(key, job);
    return job;
  }

  // Predicted Client Attrition page: live churn-probability scores for
  // every currently active provider, plus the static feature-importance
  // panel and walk-forward validation summary. Own cache/in-flight map,
  // keyed on lookbackDays alone - same shape as aiRisk()/profit().
  async churn(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampChurn(query);
    const key = `${p.lookbackDays}`;

    const hit = this._churnCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._churnInflight.has(key)) return this._churnInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkChurn(p.lookbackDays);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const watchlist = this._rows(d.watchlist);
      const importance = this._rows(d.importance).map((r) => ({
        ...r,
        feature: r.feature == null ? null : String(r.feature),
      }));
      const validation = this._dict(d.validation);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          rawLatestDate: dstr(meta.rawLatestDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          nScored: num(meta.nScored),
          lookbackDays: num(meta.lookbackDays),
        },
        watchlist,
        importance,
        validation: {
          nFolds: num(validation.nFolds),
          meanAuc: num(validation.meanAuc),
          stdAuc: num(validation.stdAuc),
          meanPrecisionAtDecile: num(validation.meanPrecisionAtDecile),
          stdPrecisionAtDecile: num(validation.stdPrecisionAtDecile),
          meanBaseRate: num(validation.meanBaseRate),
          lift: num(validation.lift),
          nRows: num(validation.nRows),
          gbtAuc: num(validation.gbtAuc),
          logitAucSameFold: num(validation.logitAucSameFold),
          obsDays: num(validation.obsDays),
          churnGapDays: num(validation.churnGapDays),
        },
      };

      this._churnCache.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => this._churnInflight.delete(key));

    this._churnInflight.set(key, job);
    return job;
  }

  // Adaptive Toxicity Classifier page (VFDT/Hoeffding Tree) - same shape as
  // aiRisk() above, own cache/in-flight map since the two models score
  // independently and a caller may want both on screen at once.
  async vfdt(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampVfdt(query);
    const key = `${p.lookbackDays}`;

    const hit = this._vfdtCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._vfdtInflight.has(key)) return this._vfdtInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      const { data: d } = await this.gateway.brkVfdt(p.lookbackDays);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const watchlist = this._rows(d.watchlist).map((r) => ({
        ...r,
        bucket: r.bucket == null ? null : String(r.bucket),
      }));
      const importance = this._rows(d.importance).map((r) => ({
        ...r,
        feature: r.feature == null ? null : String(r.feature),
      }));
      const treeStats = this._dict(d.treeStats);
      const splitUsage = this._rows(treeStats.splitUsage).map((r) => ({
        ...r,
        feature: r.feature == null ? null : String(r.feature),
      }));
      const curve = this._rows(d.curve);
      const validation = this._dict(d.validation);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          nScored: num(meta.nScored),
          lookbackDays: num(meta.lookbackDays),
        },
        watchlist,
        importance,
        tree: {
          depth: num(treeStats.depth),
          nNodes: num(treeStats.nNodes),
          nBranches: num(treeStats.nBranches),
          nLeaves: num(treeStats.nLeaves),
          splitUsage,
        },
        curve,
        validation: {
          nAccounts: num(validation.nAccounts),
          baseRate: num(validation.baseRate),
          prequentialAccuracy: num(validation.prequentialAccuracy),
          prequentialAuc: num(validation.prequentialAuc),
          precisionAtDecile: num(validation.precisionAtDecile),
          lift: num(validation.lift),
          warnCut: num(validation.warnCut),
        },
      };

      this._vfdtCache.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => this._vfdtInflight.delete(key));

    this._vfdtInflight.set(key, job);
    return job;
  }

  // Book Margin page: the whole book's consolidated margin (every
  // provider/brokerage summed together) - today's snapshot, today's
  // by-pair breakdown, the whole-window by-pair rollup, and the daily
  // history for the trend chart. Own cache/in-flight map, keyed on
  // lookbackDays alone (the one real parameter this page takes).
  async margin(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampMargin(query);
    const key = `${p.lookbackDays}|${p.broker}`;

    const hit = this._marginCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._marginInflight.has(key)) return this._marginInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      // p.broker was already validated against a strict [A-Za-z0-9 ]
      // allowlist in _clampMargin; empty means "no filter" - qGateway's
      // brkMargin turns that into NULL_SYM, non-empty into castSymbolLit.
      const { data: d } = await this.gateway.brkMargin(p.lookbackDays, p.broker);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);
      const todayRows = this._rows(d.today);
      const todayRoutedRows = this._rows(d.todayRouted);
      const todayIdealRows = this._rows(d.todayIdeal);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          latestDate: dstr(meta.latestDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          lookbackDays: num(meta.lookbackDays),
          broker: meta.brokerTag ? String(meta.brokerTag) : null,
        },
        // roster of parsed broker tags (see .brk.broker.tag) + this-window
        // nTrades/nProviders/totalLots - ALWAYS off the unfiltered window,
        // so picking a broker never shrinks the dropdown's own options.
        brokers: this._rows(d.brokers),
        // one row (today's consolidated book totals) - a single object is
        // easier for the frontend's headline cards than a 1-row array.
        // "today"/byPair*/daily = totalRev under the "everything
        // internalised" convention (.brk.rev.daily); the *Routed
        // siblings are the same figures under the ACTUAL A/B/SPLIT policy
        // .brk.book.recommend would apply (.brk.rev.dailyRouted) - the
        // frontend's raw/routed toggle picks between the two.
        today: todayRows[0] || null,
        todayRouted: todayRoutedRows[0] || null,
        // ideal = the theoretical ceiling: each signal routed to WHICHEVER
        // of A/B actually paid off better in hindsight, no SPLIT compromise
        // (.brk.rev.dailyIdeal) - the bar the real routing engine is
        // measured against, not something a desk could pre-commit to.
        todayIdeal: todayIdealRows[0] || null,
        byPairToday: this._rows(d.byPairToday),
        byPairTodayRouted: this._rows(d.byPairTodayRouted),
        byPairTodayIdeal: this._rows(d.byPairTodayIdeal),
        byPairWindow: this._rows(d.byPairWindow),
        byPairWindowRouted: this._rows(d.byPairWindowRouted),
        byPairWindowIdeal: this._rows(d.byPairWindowIdeal),
        daily: this._rows(d.daily),
        dailyRouted: this._rows(d.dailyRouted),
        dailyIdeal: this._rows(d.dailyIdeal),
        thresholds: this._dict(d.thresholds),
      };

      this._marginCache.set(key, { at: Date.now(), data });
      if (this._marginCache.size > 16) {
        const oldest = [...this._marginCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._marginCache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._marginInflight.delete(key));

    this._marginInflight.set(key, job);
    return job;
  }

  // Volume page (Broker category): trading volume by broker (roster,
  // always unfiltered so the picker never empties) and by symbol (the bar
  // chart, scoped to whichever broker is selected - "All" by default).
  async volume(query = {}) {
    if (!this.enabled) {
      const e = new Error("brokerTech disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();
    const p = this._clampVolume(query);
    const key = `${p.lookbackDays}|${p.broker}`;

    const hit = this._volumeCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this._volumeInflight.has(key)) return this._volumeInflight.get(key);

    const job = (async () => {
      const started = Date.now();
      // same "" = no filter convention as margin() above.
      const { data: d } = await this.gateway.brkVolume(p.lookbackDays, p.broker);
      if (d && d.err) {
        const e = new Error(String(d.err));
        e.statusCode = 503;
        throw e;
      }

      const meta = this._dict(d.meta);

      const data = {
        connected: true,
        target: `${this.gateway.opts.host}:${this.gateway.opts.port}`,
        computedMs: Date.now() - started,
        cachedForMs: this.ttlMs,
        meta: {
          sDate: dstr(meta.sDate),
          eDate: dstr(meta.eDate),
          nPartitions: num(meta.nPartitions),
          nTradeRows: num(meta.nTradeRows),
          lookbackDays: num(meta.lookbackDays),
          broker: meta.brokerTag ? String(meta.brokerTag) : null,
        },
        brokers: this._rows(d.brokers),
        bySymbol: this._rows(d.bySymbol),
      };

      this._volumeCache.set(key, { at: Date.now(), data });
      if (this._volumeCache.size > 16) {
        const oldest = [...this._volumeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._volumeCache.delete(oldest[0]);
      }
      return data;
    })().finally(() => this._volumeInflight.delete(key));

    this._volumeInflight.set(key, job);
    return job;
  }
}

module.exports = { BrokerTechReader };
