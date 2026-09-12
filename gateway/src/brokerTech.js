"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// Retail brokerage & risk analytics for the "Broker Tech" page. Reads
// whatever retail-brokerage HDB OPENQ_BROKERTECH_HDB points at, with
// modules/analytics/brokerTech/brokerTech.q loaded on it, so the pure
// `.brk.*` batch functions run in-process. This reader drives one
// parameterised query that mirrors modules/analytics/brokerTech/run.q's
// window pull + section set: book revenue, revenue by instrument, exposure
// concentration + peak concurrent exposure, a per-provider profitability
// leaderboard, drawdown & toxicity rankings, A/B-book routing
// recommendation + the optimisation headline, risk breach alerts, and the
// per-broker scorecard.
//
// The window pull itself goes through .brk.src.trade/.brk.src.equity/
// .brk.src.sig/.brk.src.monthly (defined in brokerTech.q, see its own
// "Source-window pulls" section) rather than a bare "select ... from
// trade/equity/sig/monthly" - this file never needs to know which of the
// two real HDBs it's pointed at:
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
//     equity/sig were already in exactly this shape), so nothing here
//     changes if OPENQ_BROKERTECH_HDB is pointed back at it.
//
// The whole suite is a batch recompute over a date window (~1s for 90d / ~30k
// trades, more for wider windows), so responses are cached per parameter set
// with a TTL and a single-in-flight guard - the page polls, the HDB isn't
// hammered.

const num = (v) => (v == null || Number.isNaN(v) ? null : Number(v));
const dstr = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10);

// One round-trip: pull the window once, run every .brk.* section, hand back a
// dict of tables/dicts. lookbackDays / minTrades / topN are pre-clamped ints.
const SUITE = (lookbackDays, minTrades, topN) => `
{[lookbackDays;minTrades;topN]
  if[not \`loaded in key \`.brk.info; :(enlist \`err)!enlist "brokerTech.q not loaded on brokerTech_hdb"];
  if[0=count .Q.PV; :(enlist \`err)!enlist "no partitions under the retail hdbroot"];
  eDate:last .Q.PV;
  sDate:(eDate-lookbackDays) | first .Q.PV;
  w:.brk.src.trade[sDate;eDate];
  eq:.brk.src.equity[sDate;eDate];
  mn:select from .brk.src.monthly[];
  s:0!select signalId,name,authorName,mtVersion,firstSeen,lastSeen from .brk.src.sig[];
  activeIds:exec distinct signalId from w;
  eq:select from eq where signalId in activeIds;
  mn:select from mn where signalId in activeIds;
  if[0=count w; :(enlist \`err)!enlist "no trade rows in the window - widen lookbackDays"];
  nm:\`signalId xkey s;
  addName:{[nm;t] \$[\`signalId in cols t; (0!t) lj nm; t]};
  lim:{[n;t] \$[n<count t; n sublist t; t]};

  summary:.brk.rev.summary w;
  revI:.brk.rev.byInstrument w;
  bookConc:.brk.expo.bookConcentration w;
  peak:.brk.expo.peakConcurrent w;

  perf:addName[nm;] select from .brk.perf.bySignal w where nTrades>=minTrades;
  perfC:select signalId,name,nTrades,winRatePct,profitFactor,expectancy,netProfit,
      grossCommission,grossSwap,totalLots,avgHoldMin,sub5MinPct,tradesPerDay from perf;

  dd:addName[nm;] select from .brk.perf.drawdown eq where nPts>=30;
  ddC:select signalId,name,nPts,netReturnPct,maxDDPct,curDDPct,underwaterSamplePct,
      ddDaysApprox,recoveryFactor from dd;

  toxAll:.brk.tox.score[w;eq];
  tox:addName[nm;] select from toxAll where nTrades>=minTrades;
  toxC:select signalId,name,nTrades,winRatePct,maxDDPct,scalpScore,martingaleScore,
      oneSidedScore,burstScore,tooGoodScore,toxScore,bucket from tox;
  toxBuckets:0!select nProviders:count i by bucket from select from toxAll where nTrades>=minTrades;

  bTag:\`signalId xkey .brk.broker.tag s;
  rec:addName[nm;] .brk.book.recommend[w;eq];
  rec:update brokerTag:\`UNKNOWN^brokerTag from rec lj bTag;
  routeRoll:0!select nProviders:count i, expectedRev:sum expectedRev,
      bBookRev:sum bBookTotalRev, aBookRev:sum aBookRev, totalLots:sum totalLots,
      rationale:first rationale by route from rec;
  routeRoll:update lotSharePct:?[0<sum totalLots; 100*totalLots%sum totalLots; 0n] from routeRoll;
  allB:sum rec\`bBookTotalRev; allA:sum rec\`aBookRev; recR:sum rec\`expectedRev;
  opt:\`allBBookRev\`allABookRev\`recommendedRev\`upliftVsBestExtreme\`nSignals\`nRouteA\`nRouteB\`nRouteSplit!(
    allB; allA; recR; recR-allB|allA;
    count rec; \`long\$sum rec[\`route]=\`A; \`long\$sum rec[\`route]=\`B; \`long\$sum rec[\`route]=\`SPLIT);

  // deterministic-formula inputs echoed back so the frontend's A/B what-if
  // simulator can seed its sliders from the desk's actual current policy
  // (.brk.cfg) rather than hardcoding a guess.
  thr:\`toxHighThreshold\`profitableClientUsd\`largeSizeLots\`splitHedgeFrac!(
    .brk.cfg\`toxHigh; .brk.cfg\`profitableClientUsd; .brk.cfg\`largeSizeLots; .brk.cfg\`splitHedgeFrac);

  // per-broker routing economics - reuses rec (no second .brk.book.recommend
  // pass), same shape as .brk.broker.routing but grouped off what's already computed.
  brokRouting:\`recommendedRev xdesc update upliftVsBestExtreme:recommendedRev-allBBookRev|allABookRev from
    0!select nProviders:count i, nRouteA:\`long\$sum route=\`A, nRouteB:\`long\$sum route=\`B,
        nRouteSplit:\`long\$sum route=\`SPLIT, totalLots:sum totalLots,
        allBBookRev:sum bBookTotalRev, allABookRev:sum aBookRev, recommendedRev:sum expectedRev
      by brokerTag from rec;

  // full per-signal routing detail (every active provider, not just topN) -
  // the raw ingredients .brk.book.recommend based its call on, so the
  // frontend can re-derive the route under a different threshold locally.
  recDetail:\`bBookTotalRev xdesc select signalId,name,brokerTag,nTrades,toxScore,bucket,
      clientNetProfit,bBookMarketPnl,commissionRev,swapRev,totalLots,bBookTotalRev,aBookRev,
      route,rationale,expectedRev from rec;

  // additional exec-quality signals for the toxicity component drill-down -
  // each a single O(n) group-by pass over the window (same cost class as
  // perf.bySignal / tox.score above), reused across the whole active set.
  expoSig:.brk.expo.bySignal w;
  holdDist:.brk.exec.holdTimeDist w;
  cancelR:.brk.exec.cancelRates w;

  // full per-signal toxicity detail (every active provider, not capped to
  // minTrades/topN) - the 5 tox components joined onto rec's revenue/route
  // fields (zero extra .brk.tox.score/.brk.book.recommend passes) plus the
  // exec-quality context (buy/sell bias, hold time, cancel rate) behind
  // each component.
  toxDetail:rec lj \`signalId xkey select signalId, scalpScore, martingaleScore,
      oneSidedScore, burstScore, tooGoodScore, winRatePct, maxDDPct from toxAll;
  toxDetail:toxDetail lj \`signalId xkey select signalId, buyLots, sellLots, netLots from expoSig;
  toxDetail:toxDetail lj \`signalId xkey select signalId, p50HoldMin:p50, sub5MinPct, maxHoldMin from holdDist;
  toxDetail:toxDetail lj \`signalId xkey select signalId, cancelRatePct from cancelR;
  toxDetail:\`toxScore xdesc update buyShare:?[0<buyLots+sellLots; 100*buyLots%buyLots+sellLots; 0n] from 0!toxDetail;

  // revenue/exposure at risk by toxicity bucket - "how much B-book revenue
  // sits with HIGH/EXTREME-scored providers".
  toxBucketRev:0!select nProviders:count i, nTrades:sum nTrades, totalLots:sum totalLots,
      clientNetProfit:sum clientNetProfit, bBookRev:sum bBookTotalRev, aBookRev:sum aBookRev,
      avgToxScore:avg toxScore, avgMaxDDPct:avg maxDDPct, avgWinRatePct:avg winRatePct
    by bucket from toxDetail;

  // average component profile per bucket - what's actually driving each
  // bucket (radar-chart friendly).
  toxBucketProfile:0!select nProviders:count i,
      scalpScore:avg scalpScore, martingaleScore:avg martingaleScore,
      oneSidedScore:avg oneSidedScore, burstScore:avg burstScore, tooGoodScore:avg tooGoodScore
    by bucket from toxDetail;

  // the deterministic formula's own tunables, echoed back so the frontend's
  // weight/threshold simulator seeds from the desk's real .brk.cfg.
  toxCfg:\`wScalp\`wMartingale\`wOneSided\`wBurst\`wTooGood\`toxMed\`toxHigh\`toxExtreme!(
    .brk.cfg\`wScalp; .brk.cfg\`wMartingale; .brk.cfg\`wOneSided; .brk.cfg\`wBurst; .brk.cfg\`wTooGood;
    .brk.cfg\`toxMed; .brk.cfg\`toxHigh; .brk.cfg\`toxExtreme);

  // order-mix (market vs pending/limit/stop) and stop-slippage - written in
  // .brk.exec.* but never surfaced anywhere until now. Both single O(n)
  // group-by passes, same cost class as cancelR/holdDist above.
  execOrderMix:.brk.exec.orderMix w;
  execStopSlip:.brk.exec.stopSlippage w;

  // full per-signal execution-quality detail (every active provider) -
  // reuses rec (name/brokerTag/toxScore/bucket/bBookTotalRev already on
  // it, zero extra .brk.tox.score/.brk.book.recommend passes) plus every
  // .brk.exec.* signal. Folded, not chained (t lj a lj b lj c parses
  // right-to-left, not left-to-right - see [[q_kdb_gotchas]]).
  execJoins:(
    \`signalId xkey select signalId,nOrders,nExecuted,nCancelled,cancelRatePct from cancelR;
    \`signalId xkey select signalId,p5,p25,p50,p75,p95,subMinPct,sub5MinPct,maxHoldMin from holdDist;
    \`signalId xkey select signalId,marketPct,pendingPct,limitPct,stopPct from execOrderMix;
    \`signalId xkey select signalId,nWithStop,nStoppedOut,stopHitRatePct,avgAdverseGapPx,maxAdverseGapPx from execStopSlip);
  execDetail:{x lj y}/[rec;execJoins];
  execDetail:\`cancelRatePct xdesc 0!select signalId,name,brokerTag,nTrades,toxScore,bucket,bBookTotalRev,
      nOrders,nExecuted,nCancelled,cancelRatePct,
      marketPct,pendingPct,limitPct,stopPct,
      p5,p25,p50,p75,p95,subMinPct,sub5MinPct,maxHoldMin,
      nWithStop,nStoppedOut,stopHitRatePct,avgAdverseGapPx,maxAdverseGapPx
    from execDetail;

  // book-level execution KPIs, properly volume-weighted (sum-of-sums, not
  // an average-of-per-provider-averages).
  execRollup:\`nProviders\`nOrders\`nExecuted\`nCancelled\`bookCancelRatePct\`nWithStop\`nStoppedOut\`bookStopHitRatePct!(
    count execDetail; sum execDetail\`nOrders; sum execDetail\`nExecuted; sum execDetail\`nCancelled;
    100*(sum execDetail\`nCancelled)%sum execDetail\`nOrders;
    sum execDetail\`nWithStop; sum execDetail\`nStoppedOut;
    ?[0<sum execDetail\`nWithStop; 100*(sum execDetail\`nStoppedOut)%sum execDetail\`nWithStop; 0n]);

  alAll:.brk.alert.breaches[w;eq];
  al:addName[nm;] alAll;
  alByKind:0!select nBreaches:count i by kind,severity from alAll;

  brokScore:.brk.broker.summary[w;eq;s];
  brokPnl:.brk.broker.pnl[w;s];

  \`meta\`summary\`revByInstrument\`bookConcentration\`peakConcurrent\`profitability\`drawdown\`toxicity\`toxBuckets\`routing\`optimise\`routingDetail\`thresholds\`brokerRouting\`toxDetail\`toxBucketRev\`toxBucketProfile\`toxCfg\`execDetail\`execRollup\`alerts\`alertsByKind\`brokerScorecard\`brokerRevenue ! (
    \`sDate\`eDate\`nPartitions\`nTradeRows\`nEquityRows\`nMonthlyRows\`nSignals\`nActive\`lookbackDays\`minTrades\`topN!(
      sDate; eDate; count .Q.PV; count w; count eq; count mn; count s; count activeIds; lookbackDays; minTrades; topN);
    summary;
    (\`best\`worst)!(lim[topN;\`totalRev xdesc revI]; lim[topN;\`totalRev xasc revI]);
    bookConc;
    lim[topN;peak];
    (\`winners\`losers)!(lim[topN;\`netProfit xdesc perfC]; lim[topN;\`netProfit xasc perfC]);
    lim[topN;\`maxDDPct xasc ddC];
    lim[topN;\`toxScore xdesc toxC];
    toxBuckets;
    routeRoll;
    opt;
    recDetail;
    thr;
    brokRouting;
    toxDetail;
    toxBucketRev;
    toxBucketProfile;
    toxCfg;
    execDetail;
    execRollup;
    lim[3*topN;\`severity\`kind xasc select signalId,name,kind,severity,metric,obsValue,threshold,message from al];
    alByKind;
    brokScore;
    brokPnl) }[${lookbackDays};${minTrades};${topN}]`;

// Client clustering (Client Clusters page) - a separate, smaller query:
// pulls the window, runs modules/analytics/brokerTech/brokerTech.q's
// .brk.cluster.run (deterministic k-means over size/duration/symbol-
// diversity/session-mix/profitability/profitability-by-size), and joins
// provider names on. Its own cache key (k is a real clustering parameter,
// not a display cap like topN) - independent of the SUITE cache above.
const CLUSTER_QUERY = (lookbackDays, k, minTrades) => `
{[lookbackDays;k;minTrades]
  if[not \`loaded in key \`.brk.info; :(enlist \`err)!enlist "brokerTech.q not loaded on brokerTech_hdb"];
  if[0=count .Q.PV; :(enlist \`err)!enlist "no partitions under the retail hdbroot"];
  eDate:last .Q.PV;
  sDate:(eDate-lookbackDays) | first .Q.PV;
  w:.brk.src.trade[sDate;eDate];
  if[0=count w; :(enlist \`err)!enlist "no trade rows in the window - widen lookbackDays"];
  nm:\`signalId xkey 0!select signalId,name,authorName,mtVersion from .brk.src.sig[];

  res:.brk.cluster.run[w;k;minTrades];
  clients:(0!res\`clients) lj nm;
  clusters:res\`clusters;

  \`meta\`clients\`clusters!(
    \`sDate\`eDate\`nPartitions\`nTradeRows\`k\`minTrades\`nClients!(
      sDate; eDate; count .Q.PV; count w; k; minTrades; count clients);
    clients;
    clusters) }[${lookbackDays};${k};${minTrades}]`;

class BrokerTechReader {
  constructor(opts) {
    this.enabled = opts.enabled !== false;
    this.defaults = {
      lookbackDays: opts.lookbackDays || 90,
      minTrades: opts.minTrades || 10,
      topN: opts.topN || 15,
    };
    this.ttlMs = Math.max(5000, opts.ttlMs || 60000);
    this.timeoutMs = Math.max(5000, opts.timeoutMs || 45000);
    this.session = new QSession({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      timeoutMs: this.timeoutMs,
      reconnectMs: 2000,
      label: "brokertech-hdb",
    });
    this._cache = new Map(); // key -> { at, data }
    this._inflight = new Map(); // key -> Promise
    this._clusterCache = new Map(); // key -> { at, data }
    this._clusterInflight = new Map(); // key -> Promise
  }

  start() { this.session.start(); return this; }
  async stop() { await this.session.stop(); }
  get connected() { return this.session.connected; }

  status() {
    return { enabled: this.enabled, target: this.session.target, connected: this.session.connected };
  }

  _requireUp() {
    if (!this.session.connected) {
      const e = new Error(
        `retail-brokerage HDB not reachable at ${this.session.target} - start it ` +
          `(scripts/startStop/startupAllByModule.sh retailR, or brokerTech for the ` +
          `legacy single-platform HDB) with modules/analytics/brokerTech/brokerTech.q ` +
          `in its hdb.json libraries`
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
      const d = await this.session.sync(SUITE(p.lookbackDays, p.minTrades, p.topN), {
        timeoutMs: this.timeoutMs,
      });
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
        target: this.session.target,
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
      const d = await this.session.sync(CLUSTER_QUERY(p.lookbackDays, p.k, p.minTrades), {
        timeoutMs: this.timeoutMs,
      });
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
        target: this.session.target,
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
}

module.exports = { BrokerTechReader };
