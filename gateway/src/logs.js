"use strict";

const fs = require("fs");
const path = require("path");

// Reads openQ's per-role .log files and returns parsed rows.
//
// openQ log line format (from core/utils/log.q):
//   2026.08.27D21:13:16.980806|21324|INFO|0|.oq.tp.modeSet|message text
//   time                      |pid  |lvl |h|function      |message
//
// Anything that doesn't match (q error lines starting `'`, indented stack
// frames) is appended to the preceding row's message.

const LINE_RE =
  /^(\d{4}\.\d{2}\.\d{2}D\d{2}:\d{2}:\d{2}\.\d+)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([\s\S]*)$/;

function fmtTime(tok) {
  // 2026.08.27D21:13:16.980806 -> 2026-08-27 21:13:16.980
  const m = tok.match(/^(\d{4})\.(\d{2})\.(\d{2})D(\d{2}:\d{2}:\d{2})\.(\d+)$/);
  if (!m) return tok;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}.${m[5].slice(0, 3)}`;
}

function readTail(file, maxBytes) {
  const st = fs.statSync(file);
  if (st.size <= maxBytes) {
    return { text: fs.readFileSync(file, "utf8"), truncated: false, bytes: st.size };
  }
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    let text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    if (nl !== -1) text = text.slice(nl + 1); // drop the partial first line
    return { text, truncated: true, bytes: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

function parseFile(proc, text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = LINE_RE.exec(line);
    if (m) {
      rows.push({
        sort: m[1],
        time: fmtTime(m[1]),
        process: proc,
        pid: Number(m[2]) || null,
        level: (m[3].trim() || "INFO").toUpperCase(),
        handle: m[4].trim(),
        function: m[5].trim(),
        message: m[6],
      });
    } else if (rows.length) {
      rows[rows.length - 1].message += "\n" + line;
    } else {
      rows.push({
        sort: "",
        time: "",
        process: proc,
        pid: null,
        level: line.startsWith("'") ? "ERROR" : "RAW",
        handle: "",
        function: "",
        message: line,
      });
    }
  }
  return rows;
}

function listFiles(dir, allow) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const e = new Error(`log dir not readable: ${dir} (${err.code || err.message})`);
    e.statusCode = 503;
    throw e;
  }
  const all = !allow || !allow.length || allow.includes("*");
  // allow entries are exact basenames ("gw") or prefix globs ("bymod_*")
  const exact = new Set();
  const prefixes = [];
  for (const a of allow || []) {
    const s = a.toLowerCase();
    if (s.endsWith("*")) prefixes.push(s.slice(0, -1));
    else exact.add(s);
  }
  const matches = (base) =>
    all || exact.has(base) || prefixes.some((p) => base.startsWith(p));
  // pretty process label: strip the harness prefixes the log dir accumulates
  const procName = (base) =>
    base.replace(/^(bymod_|all_|xtra_default_|xtra_)/, "");

  return names
    .filter((n) => n.toLowerCase().endsWith(".log"))
    .map((n) => ({ n, base: n.replace(/\.log$/i, "").toLowerCase() }))
    .filter(({ base }) => matches(base))
    .map(({ n, base }) => {
      const st = fs.statSync(path.join(dir, n));
      return {
        name: n,
        process: procName(base),
        bytes: st.size,
        modified: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.process.localeCompare(b.process) || a.name.localeCompare(b.name));
}

// opts: { limit, level:[], proc:[], q, since }  (level/proc case-insensitive)
function readLogs(cfg, opts = {}) {
  const dir = cfg.dir;
  const files = listFiles(dir, cfg.files);

  const wantProc = (opts.proc || []).map((s) => s.toLowerCase());
  const wantLevel = (opts.level || []).map((s) => s.toUpperCase());
  const needle = (opts.q || "").toLowerCase();
  const since = opts.since || "";
  const limit = Math.min(Math.max(1, opts.limit || 200), 2000);

  let rows = [];
  for (const f of files) {
    if (wantProc.length && !wantProc.includes(f.process.toLowerCase())) continue;
    const { text } = readTail(path.join(dir, f.name), cfg.maxTailBytes);
    rows = rows.concat(parseFile(f.process, text));
  }

  rows.sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0)); // newest first

  if (wantLevel.length) rows = rows.filter((r) => wantLevel.includes(r.level));
  if (needle)
    rows = rows.filter(
      (r) =>
        r.message.toLowerCase().includes(needle) ||
        r.function.toLowerCase().includes(needle)
    );
  if (since) rows = rows.filter((r) => r.sort >= since);

  const total = rows.length;
  rows = rows.slice(0, limit).map(({ sort, ...rest }) => rest);

  return {
    dir,
    files,
    processes: [...new Set(files.map((f) => f.process))],
    levels: ["ERROR", "WARN", "INFO", "DEBUG"],
    count: rows.length,
    total,
    rows,
  };
}

module.exports = { readLogs };
