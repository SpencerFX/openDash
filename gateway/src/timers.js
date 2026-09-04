"use strict";

const { QConnection } = require("jkdb");
const { toRows } = require("./qshape");

// System > Timers: every recurring job openQ has scheduled, per process.
//
// openQ layers a multi-timer scheduler over kdb+'s single `.z.ts`
// (openQ core/utils/timer.q, loaded by EVERY process's `utilities` list),
// keeping one keyed table `.util.timer.tab`:
//   id added start end frequency func lastRun nextRun active mode info
// mode is one of `ABS (fixed grid) / `REL (relative to last start) /
// `DEF (deferred - relative to last finish, the common case) / `ONCE.
//
// This reader has no persistent connections. It reuses ModulesReader for
// the full cfg_proc topology (every role of every module + the default
// pipeline), then does one short-lived IPC probe per live node port that
// pulls its `.util.timer.tab`, and rolls the rows up per process, per
// module and platform-wide (mode mix, distinct callbacks, what fires
// next, anything overdue).

const CACHE_MS = 4000;

// Pull the timer table. `func` is stored as a projection (`@[`.some.fn]`
// or `{[fn;x] value fn}[`.some.fn]`) - stringify it here, the client digs
// the callback name out. -0Wp lastRun (never run) / 0Wp-ish nextRun
// (inactive) are nulled so they serialise cleanly. Guarded: any process
// without the table (shouldn't happen - timer.q is universal) yields ().
const TIMER_Q =
  "@[{0!select id, mode, active, info, " +
  "fn:{$[type[x] in 100 104 105h; -3!x; $[11h=type x; string x; \"\"]]} each func, " +
  "freqNs:`long$frequency, added, " +
  "lastRun:?[lastRun<2000.01.01D0; 0Np; lastRun], " +
  "nextRun:?[nextRun>2100.01.01D0; 0Np; nextRun] " +
  "from .util.timer.tab};`;()]";

const toMs = (v) => (v instanceof Date ? v.getTime() : v == null ? null : (Number.isNaN(Date.parse(v)) ? null : Date.parse(v)));
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

// "@[`.util.conn.cleanup]" / "{[fn;x] value fn}[`.spreadMod.summary]" -> ".util.conn.cleanup"
function cleanFn(s) {
  if (s == null) return null;
  const str = String(s).trim();
  const m = str.match(/`([.A-Za-z0-9_]+)/);
  return m ? m[1] : str || null;
}

function humanFreq(ms) {
  if (ms == null || !isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${+s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = s / 60;
  if (m < 60) return `${+m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = m / 60;
  if (h < 24) return `${+h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${+(h / 24).toFixed(1)}d`;
}

function shapeTimer(row, now) {
  const freqMs = row.freqNs == null ? null : Number(row.freqNs) / 1e6;
  const lastRunMs = toMs(row.lastRun);
  const nextRunMs = toMs(row.nextRun);
  const active = row.active === true || row.active === 1;
  return {
    id: Number(row.id),
    fn: cleanFn(row.fn),
    label: row.info ? String(row.info) : null,
    mode: row.mode == null ? null : String(row.mode),
    active,
    freqMs: freqMs && isFinite(freqMs) ? freqMs : null,
    freqHuman: humanFreq(freqMs),
    added: iso(row.added),
    lastRun: iso(row.lastRun),
    nextRun: iso(row.nextRun),
    lastRunAgoMs: lastRunMs == null ? null : now - lastRunMs,
    dueInMs: nextRunMs == null ? null : nextRunMs - now,
    overdue: active && nextRunMs != null && nextRunMs < now - 1500,
  };
}

function probeTimers(host, port, timeoutMs) {
  return new Promise((resolve) => {
    if (!port) return resolve({ up: false, timers: [] });
    const q = new QConnection({ host, port, socketNoDelay: true });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { q.close(() => {}); } catch { /* ignore */ }
      resolve(v);
    };
    const t = setTimeout(() => finish({ up: false, error: "timeout", timers: [] }), timeoutMs);
    q.on("error", () => { clearTimeout(t); finish({ up: false, error: "refused", timers: [] }); });
    q.connect((err) => {
      if (err) { clearTimeout(t); return finish({ up: false, error: err.message, timers: [] }); }
      q.sync(TIMER_Q, (e, r) => {
        clearTimeout(t);
        if (e) return finish({ up: true, error: e.message, timers: [] });
        let rows = [];
        try { rows = toRows(r).rows || []; } catch { rows = []; }
        finish({ up: true, timers: rows });
      });
    });
  });
}

class TimersReader {
  constructor(modules, opts = {}) {
    this.modules = modules; // ModulesReader
    this.host = opts.host || "127.0.0.1";
    this.timeoutMs = opts.timeoutMs || 2500;
    this._cache = { at: 0, data: null };
  }

  start() {}
  async stop() {}
  status() {
    let names = [];
    try { names = (this.modules.list() || []).map((m) => m.name); } catch { /* ignore */ }
    return { enabled: true, host: this.host, modules: names };
  }

  async read() {
    if (this._cache.data && Date.now() - this._cache.at < CACHE_MS) return this._cache.data;

    const list = this.modules.list() || [];
    const topos = await Promise.all(
      list.map((m) =>
        this.modules.topology(m.name).catch((e) => ({ module: m.name, label: m.label, error: e.message, nodes: [] }))
      )
    );

    const nodeRefs = [];
    for (const t of topos) {
      for (const nd of t.nodes || []) {
        if (!nd.port) continue;
        nodeRefs.push({
          module: t.module,
          label: t.label || t.module,
          name: nd.logProc || nd.id,
          role: nd.role,
          port: nd.port,
          instance: nd.instance || null,
          standby: !!nd.standby,
        });
      }
    }

    const probes = await Promise.all(nodeRefs.map((n) => probeTimers(this.host, n.port, this.timeoutMs)));
    const now = Date.now();

    const processes = nodeRefs.map((n, i) => {
      const p = probes[i];
      const timers = (p.timers || [])
        .map((row) => shapeTimer(row, now))
        .sort((a, b) => {
          const an = a.dueInMs == null ? Infinity : a.dueInMs;
          const bn = b.dueInMs == null ? Infinity : b.dueInMs;
          return an - bn;
        });
      return {
        module: n.module,
        name: n.name,
        role: n.role,
        port: n.port,
        instance: n.instance,
        standby: n.standby,
        up: !!p.up,
        error: p.error || null,
        timerCount: timers.length,
        activeCount: timers.filter((x) => x.active).length,
        overdueCount: timers.filter((x) => x.overdue).length,
        timers,
      };
    });

    // per-module rollup
    const byModule = new Map();
    for (const pr of processes) {
      let m = byModule.get(pr.module);
      if (!m) {
        m = {
          name: pr.module,
          label: (topos.find((t) => t.module === pr.module) || {}).label || pr.module,
          procCount: 0,
          procUp: 0,
          procsWithTimers: 0,
          timerCount: 0,
          activeCount: 0,
          overdueCount: 0,
          procs: [],
        };
        byModule.set(pr.module, m);
      }
      m.procCount += 1;
      if (pr.up) m.procUp += 1;
      if (pr.timerCount) m.procsWithTimers += 1;
      m.timerCount += pr.timerCount;
      m.activeCount += pr.activeCount;
      m.overdueCount += pr.overdueCount;
      m.procs.push(pr);
    }
    const modules = [...byModule.values()].sort((a, b) => a.name.localeCompare(b.name));

    // platform-wide overview
    const allTimers = processes.flatMap((pr) => pr.timers.map((t) => ({ ...t, proc: pr.name, module: pr.module })));
    const active = allTimers.filter((t) => t.active);

    const byMode = {};
    for (const t of allTimers) byMode[t.mode || "?"] = (byMode[t.mode || "?"] || 0) + 1;

    const byFn = new Map();
    for (const t of allTimers) {
      const k = t.fn || "?";
      let f = byFn.get(k);
      if (!f) { f = { fn: k, count: 0, procs: new Set(), activeCount: 0, minFreqMs: Infinity }; byFn.set(k, f); }
      f.count += 1;
      f.procs.add(t.proc);
      if (t.active) f.activeCount += 1;
      if (t.freqMs != null) f.minFreqMs = Math.min(f.minFreqMs, t.freqMs);
    }
    const functions = [...byFn.values()]
      .map((f) => ({
        fn: f.fn,
        count: f.count,
        activeCount: f.activeCount,
        procs: f.procs.size,
        minFreqMs: isFinite(f.minFreqMs) ? f.minFreqMs : null,
        minFreqHuman: humanFreq(isFinite(f.minFreqMs) ? f.minFreqMs : null),
      }))
      .sort((a, b) => b.count - a.count || a.fn.localeCompare(b.fn));

    const upcoming = active
      .filter((t) => t.dueInMs != null)
      .sort((a, b) => a.dueInMs - b.dueInMs)
      .slice(0, 20)
      .map((t) => ({
        proc: t.proc, module: t.module, fn: t.fn, label: t.label, mode: t.mode,
        nextRun: t.nextRun, dueInMs: t.dueInMs, freqMs: t.freqMs, freqHuman: t.freqHuman, overdue: t.overdue,
      }));

    const overdue = active
      .filter((t) => t.overdue)
      .map((t) => ({
        proc: t.proc, module: t.module, fn: t.fn, label: t.label,
        nextRun: t.nextRun, lateMs: -t.dueInMs, freqMs: t.freqMs, freqHuman: t.freqHuman,
      }))
      .sort((a, b) => b.lateMs - a.lateMs);

    const activeFreqs = active.map((t) => t.freqMs).filter((v) => v != null && isFinite(v) && v > 0);

    const overview = {
      processes: processes.length,
      processesUp: processes.filter((p) => p.up).length,
      processesWithTimers: processes.filter((p) => p.timerCount > 0).length,
      totalTimers: allTimers.length,
      activeTimers: active.length,
      inactiveTimers: allTimers.length - active.length,
      distinctFunctions: functions.length,
      overdueTimers: overdue.length,
      modules: modules.length,
      byMode,
      fastestFreqMs: activeFreqs.length ? Math.min(...activeFreqs) : null,
      slowestFreqMs: activeFreqs.length ? Math.max(...activeFreqs) : null,
    };

    const data = {
      asOf: new Date().toISOString(),
      host: this.host,
      overview,
      modules,
      functions,
      upcoming,
      overdue,
    };
    this._cache = { at: now, data };
    return data;
  }
}

module.exports = { TimersReader };
