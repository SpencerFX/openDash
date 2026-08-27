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
};

module.exports = config;
