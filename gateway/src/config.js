"use strict";

const fs = require("fs");
const path = require("path");

// Minimal .env loader (no dotenv dependency). Only sets keys not already
// present in process.env.
function loadDotenv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotenv(path.resolve(__dirname, "..", ".env"));

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}
function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${v}`);
  return Math.trunc(n);
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
}
function list(name) {
  return str(name, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const streamPort = int("OPENQ_STREAM_PORT", 0);

// per-query timeout for the direct CEP / RDB sync reads (markout / spread /
// prime / tables). Local aggregates, so shorter than the gw pool's.
const cepTimeoutMs = Math.max(500, int("OPENQ_CEP_TIMEOUT_MS", 5000));

const gwBase = {
  user: str("OPENQ_GW_USER", ""),
  password: str("OPENQ_GW_PASSWORD", ""),
  poolSize: Math.max(1, int("OPENQ_POOL_SIZE", 4)),
  queryTimeoutMs: Math.max(1000, int("OPENQ_QUERY_TIMEOUT_MS", 15000)),
  useBigInt: bool("OPENQ_USE_BIGINT", false),
};

// One or more named openQ gw processes to route /api/query at.
//   OPENQ_GW_TARGETS="main=127.0.0.1:5013,mon=127.0.0.1:5025"
// If unset, a single "main" target from OPENQ_GW_HOST/OPENQ_GW_PORT.
function parseTargets() {
  const raw = str("OPENQ_GW_TARGETS", "");
  const fallback = {
    main: {
      ...gwBase,
      host: str("OPENQ_GW_HOST", "127.0.0.1"),
      port: int("OPENQ_GW_PORT", 5013),
    },
  };
  if (!raw) return fallback;
  const out = {};
  for (const part of raw.split(",")) {
    const [name, hostport] = part.split("=").map((s) => (s || "").trim());
    if (!name || !hostport) continue;
    const [h, p] = hostport.split(":");
    out[name] = { ...gwBase, host: h || "127.0.0.1", port: Number(p) || 5013 };
  }
  return Object.keys(out).length ? out : fallback;
}

const targets = parseTargets();
const defaultTarget = Object.keys(targets)[0];

// Query Mon can watch a wider set of gw-capable processes than /api/query
// routes at: every module HDB loads utils/gateway.q too, so it exposes its
// own .util.gw.queue / .util.gw.servers even though the analytics pages read
// it with a plain select rather than through the gateway entrypoint.
//   OPENQ_QUERYMON_TARGETS="mon_gw=127.0.0.1:5025,markout=127.0.0.1:5033,..."
// Same "name=host:port,..." format; falls back to the /api/query targets.
function parseQueryMonTargets() {
  const raw = str("OPENQ_QUERYMON_TARGETS", "");
  if (!raw) return targets;
  const out = {};
  for (const part of raw.split(",")) {
    const [name, hostport] = part.split("=").map((s) => (s || "").trim());
    if (!name || !hostport) continue;
    const [h, p] = hostport.split(":");
    out[name] = { ...gwBase, host: h || "127.0.0.1", port: Number(p) || 5013 };
  }
  return Object.keys(out).length ? out : targets;
}
const queryMonTargets = parseQueryMonTargets();

const config = {
  port: int("PORT", 8080),
  corsOrigin: str("CORS_ORIGIN", "*"),

  targets,
  defaultTarget,
  // kept for scripts/smoke.js and any single-target caller
  gw: targets[defaultTarget],

  tables: list("OPENQ_TABLES"),

  // openQ's cfg_proc/ dir - the per-role JSON configs the Modules page reads
  // to reconstruct each pipeline's process topology.
  cfgDir: str("OPENQ_CFG_DIR", path.resolve(__dirname, "..", "..", "..", "openQ", "cfg_proc")),

  // openQ's tests/ dir - the Tests page reads tests/logs/results/ (written by
  // tests/sh/run_all.sh) and can trigger a fresh run.
  testsDir: str("OPENQ_TESTS_DIR", path.resolve(__dirname, "..", "..", "..", "openQ", "tests")),

  // openQ's curated data dictionary (schemas/catalog.json) - table/column
  // descriptions + kdb+ types, served to the dashboard's Data > Catalog page.
  catalogFile: str(
    "OPENQ_CATALOG_FILE",
    path.resolve(__dirname, "..", "..", "..", "openQ", "schemas", "catalog.json")
  ),

  // System > Control page: start/stop the plant, modules, feeders, EOD.
  // Mutating routes are gated in server.js behind OPENQ_CONTROL_TOKEN -
  // unset => the page is read-only (GET works, every POST 403).
  control: {
    enabled: bool("OPENQ_CONTROL_ENABLED", true),
    token: str("OPENQ_CONTROL_TOKEN", ""),
    root: str("OPENQ_ROOT", path.resolve(__dirname, "..", "..", "..", "openQ")),
    cfgDir: str("OPENQ_CFG_DIR", path.resolve(__dirname, "..", "..", "..", "openQ", "cfg_proc")),
    qBin: str("OPENQ_Q_BIN", "/c/q/w64/q"),
    dataDir: str("OPENQ_DATA_DIR", "C:/tmp/openq-dash-e2e/data2"),
    withCep: bool("OPENQ_START_WITH_CEP", false),
    withIdb: bool("OPENQ_START_WITH_IDB", false),
    bash: str("OPENQ_BASH", "bash"),
    host: str("OPENQ_GW_HOST", "127.0.0.1"),
    modules: (function () {
      const v = list("OPENQ_CONTROL_MODULES");
      // eq = the read-only equities HDB (cfg_proc/modules/eq/, one hdb proc,
      // no feeder/eod); startable via startupAllByModule.sh eq. candlePattern
      // = the same shape for the candlePattern table (C:/data/db1/ta), read
      // by the EQ > Candles page.
      return v.length ? v : ["mon", "markout", "spread", "primefinance", "report", "eq", "candlePattern"];
    })(),
    monGw: {
      name: str("OPENQ_MONGW_NAME", "mon_gw"),
      port: int("OPENQ_MONGW_PORT", 5025),
      rdbaddr: str("OPENQ_MONGW_RDBADDR", ":localhost:5021"),
      hdbaddr: str("OPENQ_MONGW_HDBADDR", ":localhost:5023"),
      schema: str("OPENQ_MONGW_SCHEMA", "schema_mon.q"),
    },
    feeders: [
      { name: "pidstat", script: "pidstat-feeder.js" },
      { name: "markout", script: "markout-feeder.js" },
      { name: "spread", script: "spread-feeder.js" },
      { name: "prime", script: "prime-feeder.js" },
    ],
    feederDir: path.resolve(__dirname, "..", "tools"),
    feederLogDir: str("OPENQ_FEEDER_LOG_DIR", "C:/tmp/openq-dash-e2e"),
    opTimeoutMs: Math.max(30000, int("OPENQ_CONTROL_OP_TIMEOUT_MS", 300000)),
  },

  // System > Control page, Replay panel: paced tp-log replay driving the
  // markout / market-impact / spread CEPs off real captured data. Each
  // target spawns openQ's modules/replay/replay.q against that module's
  // tickerplant. Mutating routes share OPENQ_CONTROL_TOKEN with Control.
  replay: {
    enabled: bool("OPENQ_REPLAY_ENABLED", true),
    root: str("OPENQ_ROOT", path.resolve(__dirname, "..", "..", "..", "openQ")),
    qBin: str("OPENQ_Q_BIN", "/c/q/w64/q"),
    host: str("OPENQ_GW_HOST", "127.0.0.1"),
    logDir: str("OPENQ_LOG_DIR", path.resolve(__dirname, "..", "..", "..", "openQ", "scripts", "logs")),
    opTimeoutMs: Math.max(4000, int("OPENQ_REPLAY_OP_TIMEOUT_MS", 20000)),
    defaults: {
      speed: Math.max(0.25, Number(str("OPENQ_REPLAY_SPEED", "10")) || 10),
      stamp: str("OPENQ_REPLAY_STAMP", "now") === "keep" ? "keep" : "now",
      loop: bool("OPENQ_REPLAY_LOOP", true),
      lastn: int("OPENQ_REPLAY_LASTN", 6),
    },
    targets: [
      {
        module: "markout",
        tp: str("OPENQ_REPLAY_MARKOUT_TP", ":127.0.0.1:5030"),
        schema: "schemas/schema_markout.q",
        src: str("OPENQ_REPLAY_MARKOUT_SRC", "examples/data/markout/tplogs"),
        port: int("OPENQ_REPLAY_MARKOUT_PORT", 5098),
        feeder: "markout",
        pages: ["Markout", "Market Impact"],
      },
      {
        module: "spread",
        tp: str("OPENQ_REPLAY_SPREAD_TP", ":127.0.0.1:5055"),
        schema: "schemas/schema_spread.q",
        src: str("OPENQ_REPLAY_SPREAD_SRC", "examples/data/spread/tplogs"),
        port: int("OPENQ_REPLAY_SPREAD_PORT", 5097),
        feeder: "spread",
        pages: ["Spreads"],
      },
    ],
  },

  logs: {
    // where openQ's per-role .log files are written (scripts/startup.sh's LOGS)
    dir: str(
      "OPENQ_LOG_DIR",
      path.resolve(__dirname, "..", "..", "..", "openQ", "scripts", "logs")
    ),
    // which <name>.log files to surface: exact role names and/or "prefix*"
    // globs ("*" alone = every file). The dir also accumulates stale
    // per-test-run logs; default = core roles + every running module
    // (scripts/startupAllByModule.sh -> bymod_<mod>_<role>.log).
    files: (function () {
      const v = list("OPENQ_LOG_FILES");
      return v.length
        ? v
        // rdb* catches the active/standby pair's rdb_1.log / rdb_2.log
        : ["tp", "rdb*", "hdb", "gw", "cep", "idb", "tmphdb", "fh", "eod", "bymod_*"];
    })(),
    maxTailBytes: Math.max(64 * 1024, int("OPENQ_LOG_TAIL_BYTES", 1024 * 1024)),
  },

  stream: {
    enabled: streamPort > 0,
    host: str("OPENQ_STREAM_HOST", str("OPENQ_GW_HOST", "127.0.0.1")),
    port: streamPort,
    user: str("OPENQ_STREAM_USER", ""),
    password: str("OPENQ_STREAM_PASSWORD", ""),
  },

  // openQ processes to survey for /api/tables (in-memory table inventory).
  //   OPENQ_TABLE_SOURCES="default=127.0.0.1:5011+127.0.0.1:5100,mon=...,mon_idb=127.0.0.1:5022:idb,..."
  // Each entry is `name=host:port[:kind[:only]]`, and `host:port` may be
  // repeated joined by '+'. kind:
  //   rdb (default) - a pipeline RDB. Listed as a '+'-joined active/standby
  //     PAIR: both are surveyed and the higher per-table row count (the
  //     active one) is kept, else the source reads 0 while the first
  //     instance sits standby.
  //   hdb           - an on-disk HDB (eq_hdb, fx_hdb), single endpoint.
  //   idb           - a pivot-and-harvest IDB: /api/tables reports the row
  //     count it has staged to -idbroot since the last EOD (its own
  //     in-memory tables are transient - cleared after each harvest).
  // `only` (4th ':'-field, '|'-separated table names): restrict this source
  // to just those tables. Needed for a shared HDB root that also holds
  // huge unrelated tables - e.g. fx_hdb's efx root also carries the
  // multi-billion-row *_massive / *_dukasCopy tables, and surveying those
  // (`select count i by date` over every partition) takes ~90s; pinning
  // fx_hdb to `fx_m1_yfinance` keeps the survey instant. Also trims phantom
  // schema-declared-but-unfed tables off a pipeline RDB (the eq_m1_yfinance
  // module's schema declares fx/futures/rateIndices too, all always 0 there).
  //
  // `boundDays` (5th ':'-field, integer, hdb only): cap the per-partition
  // row count to the last N partition-dates. A root with thousands of
  // partitions (efx ~5456, mon ~6191, mostly empty `.Q.chk` stubs) is
  // otherwise minutes to survey even for a tiny table. `rows` then reads
  // "last N days" (the dashboard labels it); leave the `only` field empty
  // (`fx_hdb=...:5093:hdb::800`) to bound WITHOUT pinning.
  tableSources: (function () {
    const ep = (hp) => {
      const [h, p, k, only, bound] = String(hp).split(":");
      return {
        host: h || "127.0.0.1",
        port: Number(p) || 0,
        kind: k || undefined,
        only: only || undefined,
        boundDays: bound && Number(bound) > 0 ? Math.floor(Number(bound)) : undefined,
      };
    };
    const parse = (s) => {
      const [name, hps] = s.split("=").map((x) => (x || "").trim());
      if (!name || !hps) return null;
      const endpoints = hps.split("+").map((x) => x.trim()).filter(Boolean).map(ep).filter((e) => e.port);
      if (!endpoints.length) return null;
      const only = (endpoints.find((e) => e.only) || {}).only;
      const boundDays = (endpoints.find((e) => e.boundDays) || {}).boundDays;
      return {
        name,
        endpoints,
        host: endpoints[0].host,
        port: endpoints[0].port,
        kind: endpoints[0].kind || "rdb",
        only: only ? only.split("|").map((x) => x.trim()).filter(Boolean) : undefined,
        boundDays: boundDays || undefined,
      };
    };
    const raw = str("OPENQ_TABLE_SOURCES", "");
    if (raw) return raw.split(",").map(parse).filter(Boolean);
    const one = (name, port, kind, only, boundDays) => ({
      name,
      endpoints: [{ host: "127.0.0.1", port }],
      host: "127.0.0.1",
      port,
      kind: kind || "rdb",
      only: only || undefined,
      boundDays: boundDays || undefined,
    });
    const pair = (name, p1, p2, only) => ({
      name,
      endpoints: [{ host: "127.0.0.1", port: p1 }, { host: "127.0.0.1", port: p2 }],
      host: "127.0.0.1",
      port: p1,
      kind: "rdb",
      only: only || undefined,
    });
    return [
      pair("default", 5011, 5100),
      pair("mon", 5021, 5101),
      pair("markout", 5031, 5102),
      pair("massive", 5046, 5105),
      pair("primefinance", 5071, 5104),
      pair("spread", 5056, 5103),
      // eq_m1_yfinance's schema declares fx/futures/rateIndices too, all
      // always 0 in this pipeline - pin the survey to its one real table
      pair("eq_m1_yfinance", 5061, 5116, ["eq_m1_yfinance"]),
      // per-module IDB: rows staged to -idbroot since the last EOD
      one("mon_idb", 5022, "idb"),
      one("markout_idb", 5032, "idb"),
      one("massive_idb", 5047, "idb"),
      one("primefinance_idb", 5072, "idb"),
      one("spread_idb", 5057, "idb"),
      one("eq_m1_yfinance_idb", 5117, "idb"),
      // Live - HDB: one source per db1 HDB root. eq_hdb is small enough for
      // an unbounded full-history survey; the rest carry thousands of
      // partitions (efx ~5456, mon ~6191) or huge raw-feed tables, so they
      // get a boundDays cap - all their tables still list, `rows` = last Nd.
      one("eq_hdb", 5090, "hdb"),
      one("fx_hdb", 5093, "hdb", null, 800), // efx root (fx_m1/d1_yfinance + *_massive/*_dukasCopy)
      one("mon_hdb", 5023, "hdb", null, 400), // C:/data/db1/mon (jobStatus/logs/pidstats + tableHealth* archive)
      one("primefinance_hdb", 5075, "hdb"), // examples/data/primefinance/hdb - small
      one("ta_hdb", 5095, "hdb", null, 800), // C:/data/db1/ta - candlePattern daily scan
    ];
  })(),

  // the markout module's CEP (modules/markout/cep.q) - holds the live
  // .markout.completed / .impact.completed analytics state, read by /api/markout.
  // OPENQ_MARKOUT_CEP="127.0.0.1:5034"; unset -> /api/markout disabled.
  markout: cepTarget("OPENQ_MARKOUT_CEP", 5034),

  // the spread module's CEP (modules/spread/cep.q) - holds .spread.snap
  // (build-up attribution), read by /api/spread.
  // OPENQ_SPREAD_CEP="127.0.0.1:5059"; unset -> /api/spread disabled.
  spread: cepTarget("OPENQ_SPREAD_CEP", 5059),

  // the primefinance module's CEP (modules/primefinance/cep.q) - holds the
  // .prime.* securities-finance state, read by /api/prime.
  // OPENQ_PRIME_CEP="127.0.0.1:5074"; unset -> /api/prime disabled.
  prime: cepTarget("OPENQ_PRIME_CEP", 5074),

  // the report module's CEP (modules/report/cep.q) - holds .report.latest,
  // the per-symbol Desk Risk & TCA table, read by /api/report.
  // OPENQ_REPORT_CEP="127.0.0.1:5080"; unset -> /api/report disabled.
  report: cepTarget("OPENQ_REPORT_CEP", 5080),

  // /api/hdbhealth?source=<name>. Selectable sources, each a button on the
  // System > HDB Health page (labelled "efx HDB" / "eq HDB" / "futures HDB" /
  // "mon HDB" / "rates HDB" / "ta HDB", shown in that alpha order) - one per
  // top-level folder actually present under C:/data/db1/ as of 2026-09-05
  // (efx, eq, futures, mon, rates, ta):
  //   archive ("efx HDB") - the on-disk `tableHealth`/`tableHealthTick` scan
  //             archive (one row per (tab,date), written by
  //             05_table_health_scan.q against C:/data/db1/efx), read off
  //             mon_hdb (C:/data/db1/mon). Whole-history for the
  //             `_massive`/`_dukasCopy` tables and for `tableHealthFxYf`
  //             (fx_m1_yfinance + fx_d1_yfinance, scanned across efx's whole
  //             2009-> partition range).
  //   eq ("eq HDB") - the on-disk `tableHealthEqYf` scan archive for
  //             C:/data/db1/eq's eq_m1_yfinance + eq_d1_yfinance (same
  //             05_table_health_scan.q), scanned across that root's whole
  //             2010-> partition range so it's unbounded and shows full
  //             history. Gives rows-per-month, archive completeness and
  //             rows-per-day - the live eq_hdb scan couldn't.
  //   futures ("futures HDB") - same idea as eq, for C:/data/db1/futures'
  //             futures_m1_yfinance/futures_d1_yfinance (`tableHealthFutures`).
  //   mon      - a LIVE scan of mon_hdb's own partitioned tables.
  //   rates ("rates HDB") - same idea as eq, for C:/data/db1/rates'
  //             rateIndices_m1_yfinance/rateIndices_d1_yfinance
  //             (`tableHealthRates`).
  //   ta ("ta HDB") - same idea as eq, for C:/data/db1/ta's single
  //             `candlePattern` table (`tableHealthTa`) - the
  //             modules/analytics/candle daily scan's own archive, not a raw
  //             market-data one, but it's a real folder under db1 with the
  //             same completeness question worth asking of it.
  // Override the whole list with OPENQ_HDBHEALTH_SOURCES =
  //   "name=host:port[:archive|live],...". Back-compat: OPENQ_HDBHEALTH is
  // the archive+mon target; OPENQ_EQ_HDB the eq target. off/none/0 disables.
  hdbHealth: (function () {
    const timeoutMs = Math.max(cepTimeoutMs, int("OPENQ_HDBHEALTH_TIMEOUT_MS", 60000));
    const ep = (hp) => {
      const [h, p] = String(hp).split(":");
      return { host: h || "127.0.0.1", port: Number(p) || 5023 };
    };
    const raw = str("OPENQ_HDBHEALTH_SOURCES", "");
    let sources = [];
    if (raw) {
      for (const part of raw.split(",")) {
        const [name, rest] = part.split("=").map((s) => (s || "").trim());
        if (!name || !rest) continue;
        const bits = rest.split(":");
        const kind = /^(archive|live)$/i.test(bits[2] || "") ? bits[2].toLowerCase() : "live";
        sources.push({ name, ...ep(bits.slice(0, 2).join(":")), kind });
      }
    } else {
      const mon = str("OPENQ_HDBHEALTH", "127.0.0.1:5023");
      const eq = str("OPENQ_EQ_HDB", "127.0.0.1:5090");
      const monOn = mon && !/^(off|none|0|false)$/i.test(mon);
      const eqOn = eq && !/^(off|none|0|false)$/i.test(eq);
      // ordered to match the HDB Health page's alpha button order:
      // efx HDB (archive) · eq HDB · futures HDB · mon HDB (live) · rates HDB · ta HDB
      // efx HDB: the whole-history `tableHealth`/`tableHealthTick` scan of
      // C:/data/db1/efx's `_massive`/`_dukasCopy` bar+tick tables, PLUS
      // `tableHealthFxYf` (fx_m1_yfinance + fx_d1_yfinance, also physically
      // in the efx root). tableHealthFxYf was re-scanned across efx's whole
      // partition range (2009-> , 6191 partitions), so it no longer needs
      // per-tab bounding - all three tabs are unbounded and the source
      // shows full history. (If a future fx load is only scanned into a
      // recent window again, put back `boundDays` on this tab.)
      if (monOn)
        sources.push({
          name: "archive",
          ...ep(mon),
          kind: "archive",
          tabs: [
            { name: "tableHealth", kind: "bar" },
            { name: "tableHealthTick", kind: "tick" },
            { name: "tableHealthFxYf", kind: "bar" },
          ],
        });
      // futures/rates/ta HDB: the `tableHealth<Name>` archive that
      // 05_table_health_scan.q writes into the /mon root (served by mon_hdb,
      // not the module's own live hdb) - one archive source each with
      // rows-per-month, archive completeness and rows-per-day. Only the
      // bounded window each was actually scanned into carries that splay, so
      // the reader MUST stay bounded (boundDays) - an unbounded scan of the
      // 6k+ /mon root would OS-error on a 2009 partition with no such splay.
      //
      // eq HDB: `tableHealthEqYf` - eq_m1_yfinance + eq_d1_yfinance scanned
      // across C:/data/db1/eq's whole partition range (2010-> , 6091
      // partitions), same as tableHealthFxYf, so this source is unbounded
      // and shows full history for both tables. Supersedes the older
      // `tableHealthEq` splay (which an early scan had also written
      // futures/rates m1 rows into - that stale splay is left orphaned; the
      // `only` filter it needed is gone).
      if (monOn && eqOn)
        sources.push({
          name: "eq",
          ...ep(mon),
          kind: "archive",
          tabs: [{ name: "tableHealthEqYf", kind: "bar" }],
        });
      if (monOn)
        sources.push({
          name: "futures",
          ...ep(mon),
          kind: "archive",
          tabs: [{ name: "tableHealthFutures", kind: "bar" }],
          boundDays: int("OPENQ_HDBHEALTH_FUTURES_BOUND_DAYS", 400),
        });
      if (monOn) sources.push({ name: "mon", ...ep(mon), kind: "live" });
      if (monOn)
        sources.push({
          name: "rates",
          ...ep(mon),
          kind: "archive",
          tabs: [{ name: "tableHealthRates", kind: "bar" }],
          boundDays: int("OPENQ_HDBHEALTH_RATES_BOUND_DAYS", 400),
        });
      if (monOn)
        sources.push({
          name: "ta",
          ...ep(mon),
          kind: "archive",
          tabs: [{ name: "tableHealthTa", kind: "bar" }],
          boundDays: int("OPENQ_HDBHEALTH_TA_BOUND_DAYS", 60),
        });
    }
    if (!sources.length) return { enabled: false };
    return { enabled: true, sources, defaultSource: sources[0].name, timeoutMs };
  })(),

  // System > Query Mon: reads .util.gw.queue / .util.gw.servers off each
  // watched gw-capable process (mon_gw, the module HDBs, gw0) for query
  // throughput / latency / error behaviour. Target set is OPENQ_QUERYMON_TARGETS
  // (falls back to the /api/query targets).
  queryMon: {
    enabled: bool("OPENQ_QUERYMON", true),
    targets: queryMonTargets,
    timeoutMs: Math.max(2000, int("OPENQ_QUERYMON_TIMEOUT_MS", 6000)),
    recent: Math.max(5, int("OPENQ_QUERYMON_RECENT", 40)),
    slow: Math.max(3, int("OPENQ_QUERYMON_SLOW", 15)),
    winMin: Math.max(1, int("OPENQ_QUERYMON_WINDOW_MIN", 5)),
    histMin: Math.max(5, int("OPENQ_QUERYMON_HISTORY_MIN", 30)),
  },

  // System > Processes: live pidstats samples read straight off the mon RDB
  // pair - NOT mon_gw, whose HDB shares C:/data/db1/mon with the table-health
  // archive and can't cheaply serve "latest samples". See src/pidstats.js.
  // OPENQ_PIDSTATS_RDB is a comma list of the active/standby instances
  // (cfg_proc/modules/mon/rdb.json -port1/-port2); both are queried and
  // unioned since mon_idb pivots which one is subscribed. off/none/0 disables.
  pidstats: (function () {
    const raw = str("OPENQ_PIDSTATS_RDB", "127.0.0.1:5021,127.0.0.1:5101");
    if (!raw || /^(off|none|0|false)$/i.test(raw)) return { enabled: false };
    const endpoints = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((hp) => {
        const [h, p] = hp.split(":");
        return { host: h || "127.0.0.1", port: Number(p) || 5021 };
      });
    return {
      enabled: endpoints.length > 0,
      endpoints,
      table: str("OPENQ_PIDSTATS_TABLE", "pidstats"),
      timeoutMs: Math.max(2000, int("OPENQ_PIDSTATS_TIMEOUT_MS", 8000)),
    };
  })(),

  // System > Job Status: the mon module's `jobStatus` table
  // (modules/mon/jobStatus.q -> schema_mon.q). Realtime off the mon RDB
  // pair (OPENQ_JOBSTATUS_RDB, same active/standby pair as pidstats),
  // history off the mon HDB (OPENQ_JOBSTATUS_HDB, default mon_hdb :5023).
  // OPENQ_JOBSTATUS_RDB=off/none/0 disables the page.
  jobStatus: (function () {
    const raw = str("OPENQ_JOBSTATUS_RDB", "127.0.0.1:5021,127.0.0.1:5101");
    if (!raw || /^(off|none|0|false)$/i.test(raw)) return { enabled: false };
    const endpoints = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((hp) => {
        const [h, p] = hp.split(":");
        return { host: h || "127.0.0.1", port: Number(p) || 5021 };
      });
    const hraw = str("OPENQ_JOBSTATUS_HDB", "127.0.0.1:5023");
    let hdb = null;
    if (hraw && !/^(off|none|0|false)$/i.test(hraw)) {
      const [h, p] = hraw.split(":");
      hdb = { host: h || "127.0.0.1", port: Number(p) || 5023 };
    }
    // mon_idb: staged-but-not-yet-promoted jobStatus segments, so a job that
    // ran earlier today (already harvested off the RDB, not yet in the HDB)
    // still shows. off/none/0 to skip.
    const iraw = str("OPENQ_JOBSTATUS_IDB", "127.0.0.1:5022");
    let idb = null;
    if (iraw && !/^(off|none|0|false)$/i.test(iraw)) {
      const [h, p] = iraw.split(":");
      idb = { host: h || "127.0.0.1", port: Number(p) || 5022 };
    }
    return {
      enabled: endpoints.length > 0,
      endpoints,
      hdb,
      idb,
      histDays: Math.max(1, Math.min(120, int("OPENQ_JOBSTATUS_HIST_DAYS", 14))),
      // a RUNNING row still "running" this many hours after it started is
      // treated as orphaned (crashed job / a bare .mon.job.start test call
      // with no .mon.job.end) and hidden from every list. 0 = never hide.
      staleRunningH: Math.max(0, int("OPENQ_JOBSTATUS_STALE_RUNNING_H", 6)),
      timeoutMs: Math.max(2000, int("OPENQ_JOBSTATUS_TIMEOUT_MS", 8000)),
      // openQ cfg_proc/ dir - scanned for */housekeeping.json (1 level, plus
      // one nested level for yfinance/<table>/) to derive the daily EOD
      // trigger time for the JobStatus page's "EOD & daily savedowns"
      // schedule table (last run from jobStatus, next run from eodTriggerTime).
      cfgDir: str("OPENQ_CFG_DIR", path.resolve(__dirname, "..", "..", "..", "openQ", "cfg_proc")),
      // jobName regex (case-insensitive) that marks a run as an EOD / daily
      // savedown for that same table - anything matching is folded into the
      // schedule view alongside the housekeeping.json-derived rows.
      eodPattern: str("OPENQ_JOBSTATUS_EOD_PATTERN", "_eod|_daily"),
    };
  })(),

  // System > Timers: every openQ process's `.util.timer.tab` (the
  // multi-timer scheduler in core/utils/timer.q). Reuses the Modules
  // cfg_proc topology + one light IPC probe per node - no persistent
  // connections, no own endpoint list. OPENQ_TIMERS=off to hide the page.
  timers: (function () {
    const raw = str("OPENQ_TIMERS", "on");
    if (/^(off|none|0|false)$/i.test(raw)) return { enabled: false };
    return {
      enabled: true,
      host: str("OPENQ_TIMERS_HOST", "127.0.0.1"),
      timeoutMs: Math.max(1000, int("OPENQ_TIMERS_TIMEOUT_MS", 2500)),
    };
  })(),

  // candlePattern_hdb (cfg_proc/modules/candlePattern/hdb.json, port 5095,
  // hdbroot C:/data/db1/ta) - the daily multi-timeframe candlestick-pattern
  // scan (`candlePattern` table, modules/analytics/candle/run.q) for the
  // EQ > Candles page (/api/eq/patterns, /api/eq/signals). Default
  // 127.0.0.1:5095; off/none/0 disables the page.
  candlePattern: (function () {
    const hp = str("OPENQ_CANDLEPATTERN_HDB", "127.0.0.1:5095");
    if (!hp || /^(off|none|0|false)$/i.test(hp)) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5095,
      maxDays: Math.max(1, int("OPENQ_CANDLEPATTERN_MAX_DAYS", 30)),
      timeoutMs: Math.max(cepTimeoutMs, int("OPENQ_CANDLEPATTERN_TIMEOUT_MS", 15000)),
    };
  })(),

  // the backtest service (modules/backtest/service.q, started with
  // scripts/startStop/startupBacktest.sh - not a cfg_proc/ module, see
  // that file's own header) - loads C:/data/db1/efx's fx_m1_massive once
  // and exposes .bt.svc.run/.bt.svc.meta for the Backtest page
  // (/api/backtest/run, /api/backtest/meta). Default 127.0.0.1:5097;
  // off/none/0 disables the page. Backtests are real, if modest,
  // computation (a month of 1-min bars through a rolling-window pipeline)
  // so this gets its own generous timeout, not cepTimeoutMs.
  backtest: (function () {
    const hp = str("OPENQ_BACKTEST", "127.0.0.1:5097");
    if (!hp || /^(off|none|0|false)$/i.test(hp)) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5097,
      timeoutMs: Math.max(cepTimeoutMs, int("OPENQ_BACKTEST_TIMEOUT_MS", 30000)),
    };
  })(),

  // retailR_hdb (cfg_proc/modules/retailR/hdb.json, port 5079, hdbroot
  // C:/data/r) with modules/analytics/brokerTech/{brokerTech,
  // brokerTechSourceR}.q loaded on it - the retail FX/CFD broker risk
  // analytics for the "Broker Tech" page (/api/brokertech). Two platforms
  // (mql5.com Signals + myfxbook.com) merged - see brokerTech.js's own
  // header and brokerTechSourceR.q for how. Set OPENQ_BROKERTECH_HDB to
  // 127.0.0.1:5077 to point back at the original single-platform
  // brokerTech_hdb (cfg_proc/modules/brokerTech/hdb.json, hdbroot
  // C:/data/retail) instead - same reader, same query shape, no code
  // change needed either way. The whole .brk.* suite is a batch recompute
  // over a date window, so the reader caches per (lookbackDays,minTrades,
  // top) for OPENQ_BROKERTECH_TTL_MS. off/none/0 disables.
  brokerTech: (function () {
    const hp = str("OPENQ_BROKERTECH_HDB", "127.0.0.1:5079");
    if (!hp || /^(off|none|0|false)$/i.test(hp)) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5079,
      lookbackDays: Math.max(1, int("OPENQ_BROKERTECH_LOOKBACK_DAYS", 90)),
      minTrades: Math.max(0, int("OPENQ_BROKERTECH_MIN_TRADES", 10)),
      topN: Math.max(3, int("OPENQ_BROKERTECH_TOP", 15)),
      ttlMs: Math.max(5000, int("OPENQ_BROKERTECH_TTL_MS", 60000)),
      timeoutMs: Math.max(cepTimeoutMs, int("OPENQ_BROKERTECH_TIMEOUT_MS", 45000)),
    };
  })(),

  // econCal HDB (calendar_hdb, cfg_proc/modules/calendar/hdb.json, port
  // 5078, hdbroot C:/data/calendar) - fxStreet economic-calendar events
  // (2010-> , ~204k rows, modules/ingest/calendar/) for the eFX > Economic
  // Calendar page (/api/calendar). Default 127.0.0.1:5078; off/none/0
  // disables. maxRangeDays caps how wide a single start/end request can be
  // (a fat-fingered multi-year range shouldn't pull the whole archive).
  calendar: (function () {
    const hp = str("OPENQ_CALENDAR_HDB", "127.0.0.1:5078");
    if (!hp || /^(off|none|0|false)$/i.test(hp)) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5078,
      maxRangeDays: Math.max(1, int("OPENQ_CALENDAR_MAX_RANGE_DAYS", 62)),
      timeoutMs: Math.max(cepTimeoutMs, int("OPENQ_CALENDAR_TIMEOUT_MS", 15000)),
    };
  })(),

  // the equities HDB (eq_hdb, cfg_proc/modules/eq/hdb.json, hdbroot
  // C:/data/db1/eq) - minute bars `eq_m1_yfinance` for the EQ > Charts
  // page. Default 127.0.0.1:5090; set OPENQ_EQ_HDB to off/none/0 to disable.
  eq: (function () {
    const hp = str("OPENQ_EQ_HDB", "127.0.0.1:5090");
    if (!hp || /^(off|none|0|false)$/i.test(hp)) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5090,
      table: str("OPENQ_EQ_TABLE", "eq_m1_yfinance"),
      maxDays: Math.max(1, int("OPENQ_EQ_MAX_DAYS", 21)),
      timeoutMs: Math.max(cepTimeoutMs, int("OPENQ_EQ_TIMEOUT_MS", 15000)),
    };
  })(),

  // the FX HDB (fx_hdb, cfg_proc/modules/fx/hdb.json, hdbroot
  // C:/data/db1/efx) - minute bars `fx_m1_yfinance` (28 G10 spot pairs
  // from yfinance) for the eFX > Charts page. Same EqOhlcReader, same
  // /api/*/{syms,bars} shape as eq. Default 127.0.0.1:5093; set
  // OPENQ_FX_HDB to off/none/0 to disable (the page then shows the error).
  fx: (function () {
    const hp = str("OPENQ_FX_HDB", "127.0.0.1:5093");
    if (!hp || /^(off|none|0|false)$/i.test(hp)) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5093,
      table: str("OPENQ_FX_TABLE", "fx_m1_yfinance"),
      maxDays: Math.max(1, int("OPENQ_FX_MAX_DAYS", 30)),
      timeoutMs: Math.max(cepTimeoutMs, int("OPENQ_FX_TIMEOUT_MS", 15000)),
      hdbName: "fx_hdb",
      startHint: 'the "fx" module (scripts/startStop/startupAllByModule.sh fx)',
      label: "fx-hdb",
    };
  })(),

  // same fx_hdb target as `fx` above (OPENQ_FX_HDB, default 127.0.0.1:5093),
  // but reads the long-history fx_m1_massive/fx_m1_yfinance archives that
  // share that hdbroot (C:/data/db1/efx) - powers the "view chart" drill-
  // down on a past event on the eFX > Economic Calendar page (a +/-N hour
  // window around the release, see fxEvent.js). Independent on/off switch
  // so it can be disabled without touching eFX > Charts.
  fxEventChart: (function () {
    const hp = str("OPENQ_FX_HDB", "127.0.0.1:5093");
    if (!hp || /^(off|none|0|false)$/i.test(hp)) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5093,
      windowHours: Math.max(1, int("OPENQ_FX_EVENT_WINDOW_HOURS", 6)),
      timeoutMs: Math.max(cepTimeoutMs, int("OPENQ_FX_EVENT_TIMEOUT_MS", 15000)),
    };
  })(),

  // live price feed for /api/ohlc (the dashboard's eFX > Charts page): a
  // tp/rdb that speaks .u.sub, whose `table` carries a mid/price column.
  // Default is markout's `rate` (timestamp,sym,mid). Unset -> disabled.
  ohlc: (function () {
    const hp = str("OPENQ_OHLC_STREAM", "");
    if (!hp) return { enabled: false };
    const [h, p] = hp.split(":");
    return {
      enabled: true,
      host: h || "127.0.0.1",
      port: Number(p) || 5030,
      table: str("OPENQ_OHLC_TABLE", "rate"),
      priceCol: str("OPENQ_OHLC_PRICE", "mid"),
      // eFX > Charts must only ever show currency pairs; default to the
      // markout feeder's FX set. Empty -> OhlcStore falls back to a
      // 6-upper-letter FX-pair shape check.
      syms: list("OPENQ_OHLC_SYMS").length
        ? list("OPENQ_OHLC_SYMS")
        : ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "EURGBP"],
      timeoutMs: cepTimeoutMs,
    };
  })(),
};

function cepTarget(envName, defPort) {
  const hp = str(envName, "");
  if (!hp) return { enabled: false };
  const [h, p] = hp.split(":");
  return {
    enabled: true,
    host: h || "127.0.0.1",
    port: Number(p) || defPort,
    user: str(envName + "_USER", ""),
    password: str(envName + "_PASSWORD", ""),
    timeoutMs: cepTimeoutMs,
  };
}

config.cepTimeoutMs = cepTimeoutMs;

module.exports = config;
