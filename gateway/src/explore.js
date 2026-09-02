"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");
const { BadInput, timestampLit } = require("./qlit");

function assert(cond, msg) {
  if (!cond) throw new BadInput(msg);
}

// Ad-hoc data explorer. Runs one guarded `select` straight against a
// configured openQ process (the same set /api/tables surveys - RDB pairs,
// IDBs, HDBs), NOT through a `gw` (only `main`/`mon` have one). Every
// dynamic piece is validated and re-emitted as a q literal - there is no
// free-text where clause. Supported filters: `sym in (...)`, a `timestamp`
// window, an ORDER BY, and a row LIMIT. A partitioned (HDB) table with no
// time window is pinned to its newest partition so an unbounded scan can't
// happen by accident.

// identifiers (table / column / order-by): a q name, no dots
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
// a symbol VALUE to filter on: Yahoo-style tickers (leading digit, dot,
// dash) are fine - emitted as `$"..."; only " and control chars are barred
const SYMVAL_RE = /^[^"\\\u0000-\u001f]{1,64}$/;

function ident(name) {
  assert(typeof name === "string" && IDENT_RE.test(name), `invalid identifier: ${JSON.stringify(name)}`);
  return name;
}
function symValLit(v) {
  assert(typeof v === "string" && SYMVAL_RE.test(v), `invalid symbol value: ${JSON.stringify(v)}`);
  return v;
}

// spec: { table, columns?, sym?, start?, end?, order?, dir?, limit? }
function buildExplore(spec) {
  const table = ident(spec.table);
  const cols = (Array.isArray(spec.columns) ? spec.columns : []).map(ident);
  const syms = (Array.isArray(spec.sym) ? spec.sym : []).map((s) => String(s).trim()).filter(Boolean);
  syms.forEach(symValLit); // validate (throws BadInput)
  const hasWindow = spec.start != null || spec.end != null;
  const start = spec.start != null ? timestampLit(spec.start) : "2000.01.01D00:00:00.000000000";
  const end = spec.end != null ? timestampLit(spec.end) : "2999.01.01D00:00:00.000000000";
  const order = spec.order ? ident(spec.order) : null;
  const desc = String(spec.dir || "").toLowerCase() === "desc";
  const limit = Math.min(Math.max(1, Math.trunc(Number(spec.limit) || 200)), 5000);

  const colSyms = cols.map((c) => "`" + c).join("");
  const colDict = cols.length ? `(${colSyms})!(${colSyms})` : "()";

  // Functional `?[t;w;b;a]` where-phrases can't reference the calling
  // lambda's locals by name, but a local BOUND to the value and spliced in
  // as `enlist v` works (that's what `parse` produces). So: bind the symbol
  // vector to `v`, build `w` phrase-by-phrase in the body.
  const symBind = syms.length
    ? ` v:\`$${syms.length === 1 ? `enlist "${syms[0]}"` : `("${syms.join('";"')}")`};` +
      " w:w,enlist (in;`sym; enlist v);"
    : "";
  const winPhrase = hasWindow ? ` w:w,enlist (within;\`timestamp; (${start};${end}));` : "";
  // partitioned table, no explicit window -> pin to the newest date that
  // actually has rows for THIS table (a shared HDB root can hold .Q.chk
  // stubs / other table families in newer partitions).
  const pin = hasWindow
    ? ""
    : ` if[t in .Q.pt;` +
      ` d0:@[{exec max date from select date from ${table}}; \`; 0Nd];` +
      ` if[not null d0; w:w,enlist (=;\`date; d0)]];`;
  const sort = order ? ` r:\`${order} ${desc ? "xdesc" : "xasc"} r;` : "";

  return (
    `{[] t:\`${table}; w:();` +
    symBind +
    winPhrase +
    pin +
    ` r:?[t; w; 0b; ${colDict}];` +
    sort +
    ` (count r; ${limit} sublist 0!r) }[]`
  );
}

class ExploreReader {
  constructor(sources, timeoutMs = 15000) {
    this.timeoutMs = timeoutMs;
    this.byName = new Map();
    for (const s of sources) {
      const eps =
        s.endpoints && s.endpoints.length ? s.endpoints : [{ host: s.host, port: s.port }];
      this.byName.set(s.name, {
        name: s.name,
        kind: s.kind || "rdb",
        sessions: eps.map(
          (e, i) =>
            new QSession({
              host: e.host,
              port: e.port,
              timeoutMs,
              reconnectMs: 1500,
              label: `explore:${s.name}${eps.length > 1 ? `#${i + 1}` : ""}`,
            })
        ),
      });
    }
  }

  start() {
    for (const s of this.byName.values()) for (const sess of s.sessions) sess.start();
  }
  async stop() {
    await Promise.all([...this.byName.values()].flatMap((s) => s.sessions.map((x) => x.stop())));
  }

  sources() {
    return [...this.byName.values()].map((s) => ({
      name: s.name,
      kind: s.kind,
      endpoints: s.sessions.map((x) => ({ target: x.target, connected: x.connected })),
    }));
  }

  status() {
    return { enabled: true, sources: this.sources() };
  }

  async query(spec) {
    if (!spec || !spec.source) throw new BadInput("source is required");
    const src = this.byName.get(spec.source);
    if (!src) {
      throw new BadInput(
        `unknown source: ${spec.source} (have: ${[...this.byName.keys()].join(", ")})`
      );
    }
    if (!spec.table) throw new BadInput("table is required");

    const q = buildExplore(spec);
    const started = Date.now();

    // RDB pairs: try each instance, take the one that returned rows (the
    // active one); a just-harvested standby returns 0. Non-pair: just [0].
    let lastErr = null;
    let best = null;
    for (const sess of src.sessions) {
      if (!sess.connected) continue;
      try {
        const res = await sess.sync(q, { timeoutMs: this.timeoutMs });
        const matched = Number(Array.isArray(res) ? res[0] : 0);
        const shaped = toRows(Array.isArray(res) ? res[1] : res);
        const out = {
          matched,
          rows: shaped.rows || [],
          columns: shaped.columns || [],
          target: sess.target,
        };
        if (!best || out.rows.length > best.rows.length) best = out;
        if (out.rows.length) break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!best) {
      const e = new Error(lastErr ? lastErr.message : `${spec.source} not reachable`);
      e.statusCode = lastErr ? 502 : 503;
      throw e;
    }

    return {
      source: spec.source,
      target: best.target,
      table: spec.table,
      q,
      tookMs: Date.now() - started,
      matched: best.matched,
      count: best.rows.length,
      truncated: best.matched > best.rows.length,
      columns: best.columns,
      rows: best.rows,
    };
  }
}

module.exports = { ExploreReader, buildExplore };
