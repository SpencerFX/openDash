"use strict";

// System > Process Mon: one flat view of every openQ process across every
// pipeline. Reuses ModulesReader (cfg_proc topology + a live IPC probe per
// node) and cross-references the latest pidstats snapshot for CPU / RSS /
// threads / pid. No connections of its own.

const CACHE_MS = 3000;

const toMs = (v) => (v instanceof Date ? v.getTime() : v == null ? null : Date.parse(v));
const n = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

class ProcMonReader {
  constructor(modules, pidstats) {
    this.modules = modules;      // ModulesReader
    this.pidstats = pidstats;    // PidstatsReader | null
    this._cache = { at: 0, data: null };
  }

  start() {}
  async stop() {}
  status() {
    return { enabled: true, modules: (this.modules.list() || []).map((m) => m.name), pidstats: !!this.pidstats };
  }

  // latest pidstats row per `sym`
  async _pidBySym() {
    if (!this.pidstats) return {};
    let rows = [];
    try { rows = (await this.pidstats.read()).rows || []; } catch { return {}; }
    const by = {};
    for (const r of rows) {
      const k = String(r.sym || "");
      if (!k) continue;
      const t = toMs(r.timestamp) || 0;
      if (!by[k] || t >= by[k]._t) by[k] = { ...r, _t: t };
    }
    return by;
  }

  _matchPid(bySym, logProc, id, moduleName) {
    // pidstats `sym` is the process -name. An rdb pair is one aggregate row
    // (`mon_rdb`, no _1/_2). The default pipeline runs as `tp0`/`rdb0`/... .
    const base = String(logProc || id || "").replace(/_[0-9]+$/, "");
    const cands = [logProc, base, `${moduleName}_${id}`];
    if (moduleName === "default") cands.push(`${id}0`, `${base}0`);
    for (const k of cands) if (k && bySym[k]) return bySym[k];
    return null;
  }

  async read() {
    if (this._cache.data && Date.now() - this._cache.at < CACHE_MS) return this._cache.data;

    const list = this.modules.list() || [];
    const [topos, bySym] = await Promise.all([
      Promise.all(list.map((m) => this.modules.topology(m.name).catch((e) => ({ module: m.name, label: m.label, error: e.message, nodes: [] })))),
      this._pidBySym(),
    ]);

    const matchedSyms = new Set();
    const modules = topos.map((t) => {
      const procs = (t.nodes || [])
        // the default platform's standalone housekeeping / standAlone configs
        // are opt-in monitoring helpers, not part of the pipeline - startup.sh
        // never launches them, so don't count them as "down".
        .filter((nd) => !(t.module === "default" && nd.role === "housekeeping"))
        .map((nd) => {
        const live = nd.live || {};
        const isBatch = nd.role === "eod";
        const pid = this._matchPid(bySym, nd.logProc, nd.id, t.module);
        if (pid) matchedSyms.add(pid.sym);
        const tables = live.tables || {};
        return {
          module: t.module,
          name: nd.logProc || nd.id,
          role: nd.role,
          port: nd.port || null,
          col: nd.col,
          standby: !!nd.standby,
          instance: nd.instance || null,
          up: !!live.up,
          batch: isBatch,
          status: !live.up ? (isBatch ? "batch" : "down") : nd.standby ? "standby" : "up",
          procType: live.procType || null,
          handles: n(live.handles),
          error: live.error || null,
          tables,
          rowsTotal: Object.values(tables).reduce((a, v) => a + (Number(v) || 0), 0),
          logProc: nd.logProc || null,
          cpuPct: pid ? n(pid.cpuPct) : null,
          rss: pid ? n(pid.rss) : null,
          threads: pid ? n(pid.threads) : null,
          pid: pid ? n(pid.pid) : null,
          command: pid ? pid.command || null : null,
          pidstatAt: pid ? toMs(pid.timestamp) : null,
        };
      });
      const real = procs.filter((p) => !p.batch);
      return {
        name: t.module,
        label: t.label || t.module,
        error: t.error || null,
        procs,
        up: real.filter((p) => p.up).length,
        total: real.length,
        offline: real.length > 0 && real.every((p) => !p.up),
      };
    });

    // pidstats rows we didn't map to a q node = infra / feeders (gateway,
    // vite, npm, node_*_feeder_js, python, ...)
    const infra = Object.values(bySym)
      .filter((r) => !matchedSyms.has(String(r.sym)))
      .map((r) => ({
        name: String(r.sym),
        procType: String(r.procType || "other"),
        cpuPct: n(r.cpuPct),
        rss: n(r.rss),
        threads: n(r.threads),
        pid: n(r.pid),
        command: r.command || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let processes = 0, up = 0, down = 0;
    for (const m of modules) for (const p of m.procs) {
      if (p.batch) continue;
      processes += 1;
      if (p.up) up += 1; else down += 1;
    }

    const data = {
      updatedAt: new Date().toISOString(),
      totals: {
        processes,
        up,
        down,
        modules: modules.length,
        modulesFullyUp: modules.filter((m) => m.total > 0 && m.up === m.total).length,
      },
      modules,
      infra,
    };
    this._cache = { at: Date.now(), data };
    return data;
  }
}

module.exports = { ProcMonReader };
