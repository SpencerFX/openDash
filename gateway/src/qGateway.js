"use strict";

const { QConnection } = require("jkdb");
const { buildGwQuery, symbolLit, intLit, floatLit, castSymbolLit, NULL_SYM, BadInput } = require("./qlit");

// A pool of q IPC connections to the openQ `gw` process.
//
// openQ's gateway answers .oq.gw.query by sending the result back as an
// *async* message (a `error`data`stack`queryID! dict), not as a sync
// response, and it allocates the queryID itself - so a caller cannot match
// concurrent replies on one shared connection. Each pooled connection
// therefore carries at most one in-flight query; the next reply-shaped async
// message on that socket belongs to it.
//
// Requires the jkdb `message` event (this repo's jkdb build emits it).

function looksLikeReply(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    "queryID" in obj &&
    ("data" in obj || "error" in obj)
  );
}

function qErrText(data) {
  if (data == null) return "openQ gateway error";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

class QGateway {
  constructor(opts) {
    this.opts = opts; // { host, port, user, password, poolSize, queryTimeoutMs, useBigInt }
    this.slots = []; // { id, q, ready, busy, pending, gen }
    this.waiters = []; // [{ resolve, reject, timer }]
    this.stopped = false;
    this._nextQueryId = 1;
  }

  start() {
    for (let i = 0; i < this.opts.poolSize; i++) this._spawn(i);
    // resolve once at least one slot is connected, but don't hang forever
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if (this.slots.some((s) => s.ready)) return resolve({ connected: this.readyCount() });
        if (Date.now() - t0 > this.opts.queryTimeoutMs) return resolve({ connected: 0 });
        setTimeout(check, 100);
      };
      check();
    });
  }

  readyCount() {
    return this.slots.filter((s) => s.ready).length;
  }

  status() {
    return {
      target: `${this.opts.host}:${this.opts.port}`,
      poolSize: this.opts.poolSize,
      ready: this.readyCount(),
      busy: this.slots.filter((s) => s.busy).length,
      waiters: this.waiters.length,
    };
  }

  _spawn(id) {
    const slot = { id, q: null, ready: false, busy: false, pending: null, gen: 0 };
    // replace any existing slot with this id
    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx === -1) this.slots.push(slot);
    else this.slots[idx] = slot;
    this._connectSlot(slot);
    return slot;
  }

  _connectSlot(slot) {
    if (this.stopped) return;
    const gen = ++slot.gen;
    const q = new QConnection({
      host: this.opts.host,
      port: this.opts.port,
      user: this.opts.user || undefined,
      password: this.opts.password || undefined,
      useBigInt: this.opts.useBigInt,
      socketNoDelay: true,
    });
    slot.q = q;
    slot.ready = false;

    q.on("message", (obj) => {
      if (slot.gen !== gen) return;
      if (!looksLikeReply(obj) || !slot.pending) return; // identify chatter etc.
      const p = slot.pending;
      slot.pending = null;
      slot.busy = false;
      clearTimeout(p.timer);
      if (obj.error) p.reject(new Error(qErrText(obj.data)));
      else p.resolve({ data: obj.data, queryId: Number(obj.queryID) });
      this._drain();
    });

    q.on("asyncError", (err) => {
      if (slot.gen === gen) {
        // a malformed async frame - safest is to recycle this connection
        this._recycle(slot, `asyncError: ${err.message}`);
      }
    });

    const onGone = (why) => {
      if (slot.gen !== gen) return;
      slot.ready = false;
      if (slot.pending) {
        const p = slot.pending;
        slot.pending = null;
        slot.busy = false;
        clearTimeout(p.timer);
        p.reject(new Error(`openQ gateway connection lost (${why})`));
      }
      if (!this.stopped) setTimeout(() => this._connectSlot(slot), 1000);
    };
    q.on("close", () => onGone("close"));
    q.on("end", () => onGone("end"));
    q.on("error", () => {}); // handled via close/connect callback

    q.connect((err) => {
      if (slot.gen !== gen) return;
      if (err) {
        setTimeout(() => this._connectSlot(slot), 1000);
        return;
      }
      slot.ready = true;
      this._drain();
    });
  }

  _recycle(slot, why) {
    try {
      slot.q && slot.q.close(() => {});
    } catch {
      /* ignore */
    }
    const p = slot.pending;
    slot.pending = null;
    slot.busy = false;
    slot.ready = false;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error(`query connection recycled (${why})`));
    }
    if (!this.stopped) this._connectSlot(slot);
  }

  _acquire() {
    return new Promise((resolve, reject) => {
      const free = this.slots.find((s) => s.ready && !s.busy && !s.pending);
      if (free) {
        free.busy = true;
        return resolve(free);
      }
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error("timed out waiting for a free gateway connection"));
      }, this.opts.queryTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  _drain() {
    while (this.waiters.length) {
      const free = this.slots.find((s) => s.ready && !s.busy && !s.pending);
      if (!free) return;
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      free.busy = true;
      waiter.resolve(free);
    }
  }

  // Run one .oq.gw.query. `spec.sym` may be an array; multiple symbols are
  // fanned out as one query each and the rows concatenated.
  async query(spec) {
    if (!spec || typeof spec !== "object") throw new BadInput("query spec must be an object");
    const syms = spec.sym == null ? null : Array.isArray(spec.sym) ? spec.sym : [spec.sym];

    if (syms && syms.length > 1) {
      const parts = await Promise.all(
        syms.map((s) => this._one({ ...spec, sym: s }))
      );
      const data = mergeColumnar(parts.map((p) => p.data));
      return { data, queryId: parts.map((p) => p.queryId) };
    }
    return this._one({ ...spec, sym: syms ? syms[0] : undefined });
  }

  async _one(spec) {
    return this._runCall(buildGwQuery(spec));
  }

  // Symbol/exchange roster for `table` (see openQ core/gw.q's .oq.gw.symRoster
  // and core/query.q's .oq.query.symRoster) - the one gw entry point that
  // isn't the fixed table/cols/time/sym/where shape .oq.gw.query exposes,
  // called directly as a function rather than through buildGwQuery.
  async symRoster(table) {
    return this._runCall(`.oq.gw.symRoster[${symbolLit(table)}]`);
  }

  // Economic-calendar range query (openQ core/gw.q's .oq.gw.econCal / modules
  // /ingest/calendar/q/query.q's .oq.query.econCal) - another custom-shaped
  // gw entry point, like symRoster. Takes already-built q literal strings
  // (calendar.js's own qDate/qSymList validate+render sD/eD/ctys/imps/cats -
  // dates aren't a shape buildGwQuery's timestampLit covers, and category
  // names can contain spaces, which qlit's SYMBOL_RE-based helpers reject)
  // rather than a spec object, so this is a thin pass-through, not a spec
  // builder like _one()/query().
  async econCal(sDLit, eDLit, ctysLit, impsLit, catsLit) {
    return this._runCall(`.oq.gw.econCal[${sDLit};${eDLit};${ctysLit};${impsLit};${catsLit}]`);
  }

  // System > Query Mon's own poll (openQ core/utils/gateway.q's .util.gw.mon)
  // - a self-answering introspection call, not a routed query, so it lives
  // in .util.gw.* rather than .oq.gw.* (see that function's own header).
  // nRecent/nSlow/winMin/histMin come from this reader's own fixed config,
  // never user input, so they're rendered via qlit's intLit rather than a
  // table/symbol/time literal builder.
  async mon(nRecent, nSlow, winMin, histMin) {
    return this._runCall(
      `.util.gw.mon[${intLit(nRecent)};${intLit(nSlow)};${intLit(winMin)};${intLit(histMin)}]`
    );
  }

  // Broker Tech suite (openQ core/gw.q's .oq.gw.brk* / modules/analytics/
  // brokerTech/api.q's .brk.api.* - one method per /api/brokertech* page).
  // Routed to the HDB only, same rationale as econCal: retailR_hdb/
  // brokerTech_hdb are pure batch analytics HDBs with no RDB leg, ever -
  // this is purely for System > Query Mon visibility/benchmarking. An
  // empty/falsy brokerTag or symbol string means "no filter" -> NULL_SYM
  // (openQ's own `.brk.broker.filterTrades` convention), never an empty
  // q string literal.
  async brkSuite(lookbackDays, minTrades, topN) {
    return this._runCall(`.oq.gw.brkSuite[${intLit(lookbackDays)};${intLit(minTrades)};${intLit(topN)}]`);
  }

  async brkCluster(lookbackDays, k, minTrades) {
    return this._runCall(`.oq.gw.brkCluster[${intLit(lookbackDays)};${intLit(k)};${intLit(minTrades)}]`);
  }

  async brkSegment(lookbackDays, minTrades) {
    return this._runCall(`.oq.gw.brkSegment[${intLit(lookbackDays)};${intLit(minTrades)}]`);
  }

  async brkCcy(lookbackDays, symbol) {
    return this._runCall(`.oq.gw.brkCcy[${intLit(lookbackDays)};${castSymbolLit(symbol)}]`);
  }

  async brkSsi(lookbackDays, topN, drillSymbol) {
    return this._runCall(`.oq.gw.brkSsi[${intLit(lookbackDays)};${intLit(topN)};${castSymbolLit(drillSymbol)}]`);
  }

  async brkMargin(lookbackDays, brokerTag) {
    const bt = brokerTag ? castSymbolLit(brokerTag) : NULL_SYM;
    return this._runCall(`.oq.gw.brkMargin[${intLit(lookbackDays)};${bt}]`);
  }

  async brkAiRisk(lookbackDays) {
    return this._runCall(`.oq.gw.brkAiRisk[${intLit(lookbackDays)}]`);
  }

  async brkVfdt(lookbackDays) {
    return this._runCall(`.oq.gw.brkVfdt[${intLit(lookbackDays)}]`);
  }

  async brkProfit(lookbackDays) {
    return this._runCall(`.oq.gw.brkProfit[${intLit(lookbackDays)}]`);
  }

  // dateLit is a pre-validated q date literal string ("2026.08.01") or the
  // literal text "0Nd" (brokerTech.js's _clampHourly already renders it -
  // see HOURLY_QUERY's former dateLit param for the same contract).
  async brkHourly(lookbackDays, lookbackWeeks, testDays, zCut, dateLit) {
    return this._runCall(
      `.oq.gw.brkHourly[${intLit(lookbackDays)};${intLit(lookbackWeeks)};${intLit(testDays)};${floatLit(zCut)};${dateLit}]`
    );
  }

  async brkVolume(lookbackDays, brokerTag) {
    const bt = brokerTag ? castSymbolLit(brokerTag) : NULL_SYM;
    return this._runCall(`.oq.gw.brkVolume[${intLit(lookbackDays)};${bt}]`);
  }

  async brkChurn(lookbackDays) {
    return this._runCall(`.oq.gw.brkChurn[${intLit(lookbackDays)}]`);
  }

  async ttReport(signalId, lookbackDays) {
    return this._runCall(`.oq.gw.ttReport[${intLit(signalId)};${intLit(lookbackDays)}]`);
  }

  async ttRoster(lookbackDays, minTrades, topN) {
    return this._runCall(`.oq.gw.ttRoster[${intLit(lookbackDays)};${intLit(minTrades)};${intLit(topN)}]`);
  }

  // Run one pre-built ".oq.gw.*[...]" call string through a pooled slot,
  // matching a reply by queryID the way .query()/._one() already do.
  async _runCall(call) {
    const slot = await this._acquire();
    const localId = this._nextQueryId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (slot.pending && slot.pending.localId === localId) {
          this._recycle(slot, "query timeout");
        }
        reject(new Error(`openQ gateway query timed out after ${this.opts.queryTimeoutMs}ms`));
      }, this.opts.queryTimeoutMs);

      slot.pending = { resolve, reject, timer, localId };
      slot.q.asyn(call, (err) => {
        if (err) {
          if (slot.pending && slot.pending.localId === localId) {
            slot.pending = null;
            slot.busy = false;
          }
          clearTimeout(timer);
          reject(err);
          this._drain();
        }
      });
    });
  }

  async stop() {
    this.stopped = true;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("gateway shutting down"));
    }
    await Promise.all(
      this.slots.map(
        (s) =>
          new Promise((res) => {
            try {
              s.q ? s.q.close(() => res()) : res();
            } catch {
              res();
            }
          })
      )
    );
  }
}

// Concatenate several column-oriented tables with the same columns.
function mergeColumnar(tables) {
  const nonEmpty = tables.filter(
    (t) => t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).length
  );
  if (nonEmpty.length === 0) return tables[0];
  const cols = Object.keys(nonEmpty[0]);
  const out = {};
  for (const c of cols) out[c] = [].concat(...nonEmpty.map((t) => t[c] || []));
  return out;
}

module.exports = { QGateway, looksLikeReply, mergeColumnar };
