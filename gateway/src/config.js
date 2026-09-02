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
      // no feeder/eod); startable via startupAllByModule.sh eq.
      return v.length ? v : ["mon", "markout", "spread", "primefinance", "report", "eq"];
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
  // Each entry is `name=host:port[:kind]`, and `host:port` may be repeated
  // joined by '+'. kind:
  //   rdb (default) - a pipeline RDB. Listed as a '+'-joined active/standby
  //     PAIR: both are surveyed and the higher per-table row count (the
  //     active one) is kept, else the source reads 0 while the first
  //     instance sits standby.
  //   hdb           - an on-disk HDB (eq_hdb), single endpoint.
  //   idb           - a pivot-and-harvest IDB: /api/tables reports the row
  //     count it has staged to -idbroot since the last EOD (its own
  //     in-memory tables are transient - cleared after each harvest).
  tableSources: (function () {
    const ep = (hp) => {
      const [h, p, k] = String(hp).split(":");
      return { host: h || "127.0.0.1", port: Number(p) || 0, kind: k || undefined };
    };
    const parse = (s) => {
      const [name, hps] = s.split("=").map((x) => (x || "").trim());
      if (!name || !hps) return null;
      const endpoints = hps.split("+").map((x) => x.trim()).filter(Boolean).map(ep).filter((e) => e.port);
      if (!endpoints.length) return null;
      return {
        name,
        endpoints,
        host: endpoints[0].host,
        port: endpoints[0].port,
        kind: endpoints[0].kind || "rdb",
      };
    };
    const raw = str("OPENQ_TABLE_SOURCES", "");
    if (raw) return raw.split(",").map(parse).filter(Boolean);
    const one = (name, port, kind) => ({
      name,
      endpoints: [{ host: "127.0.0.1", port }],
      host: "127.0.0.1",
      port,
      kind: kind || "rdb",
    });
    const pair = (name, p1, p2) => ({
      name,
      endpoints: [{ host: "127.0.0.1", port: p1 }, { host: "127.0.0.1", port: p2 }],
      host: "127.0.0.1",
      port: p1,
      kind: "rdb",
    });
    return [
      pair("default", 5011, 5100),
      pair("mon", 5021, 5101),
      pair("markout", 5031, 5102),
      pair("massive", 5046, 5105),
      pair("primefinance", 5071, 5104),
      pair("spread", 5056, 5103),
      pair("eq_m1_yfinance", 5061, 5116),
      // per-module IDB: rows staged to -idbroot since the last EOD
      one("mon_idb", 5022, "idb"),
      one("markout_idb", 5032, "idb"),
      one("massive_idb", 5047, "idb"),
      one("primefinance_idb", 5072, "idb"),
      one("spread_idb", 5057, "idb"),
      one("eq_m1_yfinance_idb", 5117, "idb"),
      // eq_hdb read-only archive (eq_d1_yfinance + eq_m1_yfinance) - single HDB
      one("eq_hdb", 5090, "hdb"),
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
  // System > HDB Health page (labelled "efx HDB" / "eq HDB" / "mon HDB",
  // shown in that alpha order):
  //   archive ("efx HDB") - the on-disk `tableHealth`/`tableHealthTick` scan
  //             archive (one row per (tab,date), written by
  //             05_table_health_scan.q against C:/data/db1/efx), read off
  //             mon_hdb (C:/data/db1/mon).
  //   eq       - a LIVE scan of eq_hdb (C:/data/db1/eq).
  //   mon      - a LIVE scan of mon_hdb's own partitioned tables.
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
      // ordered to match the HDB Health page's alpha button order:
      // efx HDB (archive) · eq HDB · mon HDB
      if (mon && !/^(off|none|0|false)$/i.test(mon))
        sources.push({ name: "archive", ...ep(mon), kind: "archive" });
      if (eq && !/^(off|none|0|false)$/i.test(eq))
        sources.push({ name: "eq", ...ep(eq), kind: "live" });
      if (mon && !/^(off|none|0|false)$/i.test(mon))
        sources.push({ name: "mon", ...ep(mon), kind: "live" });
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
