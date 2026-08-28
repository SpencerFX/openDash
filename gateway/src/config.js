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

const config = {
  port: int("PORT", 8080),
  corsOrigin: str("CORS_ORIGIN", "*"),

  targets,
  defaultTarget,
  // kept for scripts/smoke.js and any single-target caller
  gw: targets[defaultTarget],

  tables: list("OPENQ_TABLES"),

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
        : ["tp", "rdb", "hdb", "gw", "cep", "idb", "tmphdb", "fh", "eod", "bymod_*"];
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
  //   OPENQ_TABLE_SOURCES="default=127.0.0.1:5011,mon=127.0.0.1:5021,..."
  // default = one RDB per running pipeline.
  tableSources: (function () {
    const raw = str("OPENQ_TABLE_SOURCES", "");
    const parse = (s) => {
      const [name, hp] = s.split("=").map((x) => (x || "").trim());
      if (!name || !hp) return null;
      const [h, p] = hp.split(":");
      return { name, host: h || "127.0.0.1", port: Number(p) || 0 };
    };
    if (raw) return raw.split(",").map(parse).filter((x) => x && x.port);
    return [
      { name: "default", host: "127.0.0.1", port: 5011 },
      { name: "mon", host: "127.0.0.1", port: 5021 },
      { name: "markout", host: "127.0.0.1", port: 5031 },
      { name: "massive", host: "127.0.0.1", port: 5046 },
      { name: "primefinance", host: "127.0.0.1", port: 5071 },
      { name: "spread", host: "127.0.0.1", port: 5056 },
      { name: "yfinance", host: "127.0.0.1", port: 5051 },
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
