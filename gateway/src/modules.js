"use strict";

const fs = require("fs");
const path = require("path");
const { QConnection } = require("jkdb");

// Reads openQ's cfg_proc/ JSON files to reconstruct each pipeline's process
// topology (nodes = roles) and live-probes every node's port. Edges are the
// canonical openQ dataflow derived from the roles present, not a literal
// dump of every *addr param:
//   feed -> tp -> cep -> rdb (active/standby pair) -> hdb
//   both rdb instances harvest into the idb; the idb checkpoints back to
//     both and promotes to the hdb at EOD (openQ core/idb.q). idb is its
//     own diagram column, not shared with rdb.
//   gw queries every store (rdb x2, idb, hdb)
// The rdb is one rdb.json launched twice with -instance 1/2 onto
// params.port1 / params.port2 (openQ core/rdb.q's active/standby design),
// so it has no top-level `port`; this file expands it into two nodes.
// Backs the dashboard's System > Modules interactive architecture diagram.

// left-to-right flow order for the diagram. idb gets its own column (it is a
// distinct process, not an rdb variant) between rdb and hdb.
const ROLE_COL = { fh: 0, feed: 0, tp: 1, cep: 2, rdb: 3, idb: 4, eod: 5, hdb: 5, gw: 6, housekeeping: 6 };

function moduleList(cfgDir) {
  const out = [];
  // the default platform is the loose cfg_proc/*.json set
  try {
    const loose = fs.readdirSync(cfgDir).filter((f) => f.endsWith(".json"));
    if (loose.length) out.push({ name: "default", label: "default platform", roleFiles: loose.map((f) => path.join(cfgDir, f)) });
  } catch {
    /* ignore */
  }
  const modDir = path.join(cfgDir, "modules");
  try {
    for (const name of fs.readdirSync(modDir)) {
      const d = path.join(modDir, name);
      if (!fs.statSync(d).isDirectory()) continue;
      const roleFiles = fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => path.join(d, f));
      if (roleFiles.length) out.push({ name, label: name, roleFiles });
    }
  } catch {
    /* ignore */
  }
  return out;
}

function buildTopology(mod) {
  const nodes = mod.roleFiles.flatMap((file) => {
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* ignore */
    }
    const id = path.basename(file, ".json"); // tp, rdb, idb, eod, ...
    const role = j.procType || id.replace(/\d.*$/, "");
    const p = j.params || {};
    const base = {
      role,
      col: ROLE_COL[role] ?? 3,
      schema: j.schema ? path.basename(j.schema) : null,
      libraries: j.libraries || [],
      cepscript: p.cepscript ? path.basename(p.cepscript) : null,
      params: p,
    };
    // the `proc` filter for /api/logs. The default platform logs to bare
    // role names (tp.log, ...); modules log to bymod_<name>_<role> which
    // logs.js exposes as <name>_<role> == the cfg `name`.
    const logBase = mod.name === "default" ? role : j.name || id;

    // rdb is an active/standby pair - one rdb.json, launched twice with
    // -instance 1/2 onto params.port1 / params.port2 (openQ core/rdb.q).
    // Expand into two nodes so the diagram + liveness show both.
    if (role === "rdb" && j.port == null && p.port1) {
      return [1, 2].map((inst) => ({
        ...base,
        id: inst === 1 ? id : `${id}_${inst}`,
        name: `${j.name || id} #${inst}`,
        port: inst === 1 ? p.port1 : p.port2 || null,
        instance: inst,
        standby: inst === 2,
        logProc: `${logBase}_${inst}`,
      }));
    }
    return [{
      ...base,
      id,
      name: j.name || id,
      port: j.port || p.port1 || null,
      logProc: logBase,
    }];
  });

  // ---- canonical dataflow edges, from the roles present -----------------
  const byRole = (r) => nodes.filter((n) => n.role === r);
  const edges = [];
  const add = (from, to, label, kind) => {
    if (!from || !to || from.id === to.id) return;
    if (edges.some((e) => e.from === from.id && e.to === to.id)) return;
    edges.push({ from: from.id, to: to.id, label, kind });
  };

  const tp = byRole("tp")[0];
  const cep = byRole("cep")[0];
  const hdb = byRole("hdb")[0];
  const eod = byRole("eod")[0];
  const rdbs = byRole("rdb");               // [rdb #1 (active), rdb #2 (standby)]
  const idbs = byRole("idb");               // single idb per module now
  const gws = byRole("gw");
  const feeds = [...byRole("fh"), ...byRole("feed")];

  // feed handler(s) -> tickerplant
  for (const f of feeds) add(f, tp, "publish", "feed");

  // tp -> cep -> rdb(s)  (with no cep the rdbs subscribe straight to the tp).
  // Both rdb instances subscribe; only #1 starts active.
  if (tp && cep) add(tp, cep, "subscribe", "flow");
  const source = cep || tp;
  for (const r of rdbs) add(source, r, "subscribe", "flow");

  // idb is its own process - it no longer subscribes to tp/cep. It harvests
  // the rdb pair's in-memory tables, pivots them, and checkpoints back to
  // every rdb instance (openQ core/idb.q "pivot-and-harvest").
  for (const i of idbs) {
    for (const r of rdbs) add(r, i, "harvest", "flow");
    for (const r of rdbs) add(i, r, "checkpoint", "flush");
  }

  // end-of-day promotion into the hdb (through the standalone eod job if the
  // module ships one, otherwise the idb / rdb promote directly)
  for (const i of idbs) {
    if (eod) add(i, eod, "checkpoints", "eod");
    else add(i, hdb, "EOD → HDB", "eod");
  }
  for (const r of rdbs) add(r, hdb, "EOD → HDB", "eod");
  if (eod) add(eod, hdb, "promote", "eod");

  // gateway queries every store
  for (const g of gws) {
    for (const r of rdbs) add(g, r, "query", "query");
    for (const i of idbs) add(g, i, "query", "query");
    if (hdb) add(g, hdb, "query", "query");
  }

  return { nodes, edges };
}

async function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    if (!port) return resolve({ up: false });
    const q = new QConnection({ host, port, socketNoDelay: true });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { q.close(() => {}); } catch { /* ignore */ }
      resolve(v);
    };
    const t = setTimeout(() => finish({ up: false, error: "timeout" }), timeoutMs);
    q.on("error", () => { clearTimeout(t); finish({ up: false, error: "refused" }); });
    q.connect((err) => {
      if (err) { clearTimeout(t); return finish({ up: false, error: err.message }); }
      q.sync(
        "(string .z.p; {x!count each value each x} tables[]; count key .z.W; @[{string .util.start.CLP[`procType][`val]};::;\"\"])",
        (e, r) => {
          clearTimeout(t);
          if (e) return finish({ up: true, error: e.message });
          const [asOf, tbl, handles, procType] = r;
          const tables = {};
          if (tbl && typeof tbl === "object") for (const [k, c] of Object.entries(tbl)) tables[k] = Number(c);
          finish({ up: true, asOf, tables, handles: Number(handles) || 0, procType: procType || null });
        }
      );
    });
  });
}

class ModulesReader {
  constructor(cfgDir, host = "127.0.0.1", timeoutMs = 2500) {
    this.cfgDir = cfgDir;
    this.host = host;
    this.timeoutMs = timeoutMs;
  }

  list() {
    return moduleList(this.cfgDir).map((m) => ({ name: m.name, label: m.label, roles: m.roleFiles.length }));
  }

  async topology(name) {
    const mods = moduleList(this.cfgDir);
    const mod = mods.find((m) => m.name === name);
    if (!mod) {
      const e = new Error(`unknown module: ${name} (have: ${mods.map((m) => m.name).join(", ")})`);
      e.statusCode = 404;
      throw e;
    }
    const { nodes, edges } = buildTopology(mod);
    const live = await Promise.all(nodes.map((n) => probe(this.host, n.port, this.timeoutMs)));
    nodes.forEach((n, i) => { n.live = live[i]; });
    return {
      module: mod.name,
      label: mod.label,
      cfgDir: this.cfgDir,
      up: nodes.filter((n) => n.live && n.live.up).length,
      total: nodes.length,
      nodes,
      edges,
    };
  }

  status() {
    let names = [];
    try { names = this.list().map((m) => m.name); } catch { /* ignore */ }
    return { enabled: true, cfgDir: this.cfgDir, modules: names };
  }
}

module.exports = { ModulesReader };
