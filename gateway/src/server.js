"use strict";

const http = require("http");
const { URL } = require("url");
const { WebSocketServer } = require("ws");

const config = require("./config");
const { QGateway } = require("./qGateway");
const { StreamBridge } = require("./stream");
const { toRows } = require("./qshape");
const { BadInput } = require("./qlit");
const { readLogs } = require("./logs");
const { MarkoutReader } = require("./markout");
const { SpreadReader } = require("./spread");
const { PrimeReader } = require("./prime");
const { ReportReader } = require("./report");
const { HdbHealthManager } = require("./hdbHealth");
const { OhlcStore } = require("./ohlc");
const { ModulesReader } = require("./modules");
const { TestsReader } = require("./tests");
const { TablesReader } = require("./tables");
const { ExploreReader } = require("./explore");
const { CatalogReader } = require("./catalog");
const { ControlManager } = require("./control");
const { ReplayManager } = require("./replay");
const { EqOhlcReader } = require("./eqOhlc");
const { QueryMonReader } = require("./queryMon");
const { PidstatsReader } = require("./pidstats");
const { ProcMonReader } = require("./procMon");

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Control-Token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(text);
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new BadInput("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BadInput("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Gate for every mutating op (Control page + tests/run). Read-only unless
// OPENQ_CONTROL_TOKEN is set and presented as `Authorization: Bearer <t>`
// (or `X-Control-Token: <t>`).
function controlGate(req) {
  if (!config.control.enabled) {
    const e = new Error("control is disabled on the gateway (OPENQ_CONTROL_ENABLED=0)");
    e.statusCode = 503;
    throw e;
  }
  const tok = config.control.token;
  if (!tok) {
    const e = new Error("control is read-only: set OPENQ_CONTROL_TOKEN in openDash/gateway/.env and restart the gateway");
    e.statusCode = 403;
    throw e;
  }
  const hdr = req.headers["authorization"] || "";
  const given = (hdr.startsWith("Bearer ") ? hdr.slice(7) : "") || req.headers["x-control-token"] || "";
  if (given !== tok) {
    const e = new Error("bad or missing control token");
    e.statusCode = 401;
    throw e;
  }
}

function checkTable(table) {
  if (typeof table !== "string" || !table) throw new BadInput("`table` is required");
  if (config.tables.length && !config.tables.includes(table)) {
    throw new BadInput(`table not allowed: ${table} (allowed: ${config.tables.join(", ")})`);
  }
}

// spec from query-string params
function specFromSearch(sp) {
  const spec = { table: sp.get("table") };
  const columns = sp.get("columns");
  if (columns) spec.columns = columns.split(",").map((s) => s.trim()).filter(Boolean);
  if (sp.get("start")) spec.start = sp.get("start");
  if (sp.get("end")) spec.end = sp.get("end");
  const sym = sp.get("sym");
  if (sym) spec.sym = sym.split(",").map((s) => s.trim()).filter(Boolean);
  if (sp.get("symPattern")) spec.symPattern = sp.get("symPattern");
  if (sp.get("format")) spec.format = sp.get("format");
  if (sp.get("target")) spec.target = sp.get("target");
  return spec;
}

async function runQuery(gw, spec) {
  checkTable(spec.table);
  const started = Date.now();
  const { data, queryId } = await gw.query(spec);
  const shaped = toRows(data);
  const body = {
    table: spec.table,
    target: spec.target || undefined,
    queryId,
    tookMs: Date.now() - started,
  };
  if (spec.format === "columns") {
    body.columns = shaped.columns || null;
    body.data = data && typeof data === "object" ? shaped : { value: shaped.value };
  } else if ("rows" in shaped) {
    body.columns = shaped.columns;
    body.count = shaped.count;
    body.rows = shaped.rows;
  } else {
    body.value = shaped.value;
  }
  return body;
}

function createServer() {
  // one connection pool per named openQ gw target
  const gws = new Map(
    Object.entries(config.targets).map(([name, opts]) => [name, new QGateway(opts)])
  );
  const pickGw = (name) => {
    const key = name || config.defaultTarget;
    const g = gws.get(key);
    if (!g) {
      const e = new Error(`unknown target: ${key} (have: ${[...gws.keys()].join(", ")})`);
      e.statusCode = 400;
      throw e;
    }
    return g;
  };
  const stream = config.stream.enabled ? new StreamBridge(config.stream) : null;
  const markout = config.markout.enabled ? new MarkoutReader(config.markout) : null;
  const spread = config.spread.enabled ? new SpreadReader(config.spread) : null;
  const prime = config.prime.enabled ? new PrimeReader(config.prime) : null;
  const report = config.report.enabled ? new ReportReader(config.report) : null;
  const hdbHealth = config.hdbHealth.enabled ? new HdbHealthManager(config.hdbHealth) : null;
  const ohlc = config.ohlc.enabled ? new OhlcStore(config.ohlc) : null;
  const modules = new ModulesReader(config.cfgDir);
  const tests = new TestsReader(config.testsDir);
  const catalog = new CatalogReader(config.catalogFile);
  const control = config.control.enabled ? new ControlManager(config.control) : null;
  const replay = config.replay && config.replay.enabled ? new ReplayManager(config.replay) : null;
  const eqOhlc = config.eq && config.eq.enabled ? new EqOhlcReader(config.eq) : null;
  const queryMon = config.queryMon && config.queryMon.enabled ? new QueryMonReader(config.queryMon) : null;
  const pidstats = config.pidstats && config.pidstats.enabled ? new PidstatsReader(config.pidstats) : null;
  const tables =
    config.tableSources && config.tableSources.length
      ? new TablesReader(config.tableSources, config.cepTimeoutMs)
      : null;
  // Data > Explorer: ad-hoc `select` against any RDB/HDB source (skip the
  // idb sources - their in-memory tables are transient).
  const exploreSources = (config.tableSources || []).filter((s) => (s.kind || "rdb") !== "idb");
  const procMon = new ProcMonReader(modules, pidstats);
  const explore = exploreSources.length
    ? new ExploreReader(exploreSources, Math.max(config.queryTimeoutMs || 0, 15000))
    : null;

  const httpServer = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      return send(res, 400, { error: "bad url" });
    }

    if (req.method === "OPTIONS") return send(res, 204, {});

    try {
      if (url.pathname === "/health" || url.pathname === "/") {
        return send(res, 200, {
          ok: true,
          service: "openq-dashboard-gateway",
          defaultTarget: config.defaultTarget,
          gateways: Object.fromEntries([...gws].map(([n, g]) => [n, g.status()])),
          stream: stream ? stream.status() : { enabled: false },
          markout: markout ? markout.status() : { enabled: false },
          spread: spread ? spread.status() : { enabled: false },
          prime: prime ? prime.status() : { enabled: false },
          report: report ? report.status() : { enabled: false },
          hdbHealth: hdbHealth ? hdbHealth.status() : { enabled: false },
          ohlc: ohlc ? ohlc.status() : { enabled: false },
          modules: modules.status(),
          tests: tests.status(),
          catalog: catalog.status(),
          tables: tables ? tables.status() : { enabled: false },
          explore: explore ? explore.status() : { enabled: false },
          procMon: procMon.status(),
          control: control ? control.status() : { enabled: false },
          replay: replay ? replay.status() : { enabled: false },
          eq: eqOhlc ? eqOhlc.status() : { enabled: false },
          queryMon: queryMon ? queryMon.status() : { enabled: false },
          pidstats: pidstats ? pidstats.status() : { enabled: false },
        });
      }

      if (url.pathname === "/api/tests") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        return send(res, 200, tests.results());
      }
      if (url.pathname === "/api/tests/run") {
        if (req.method !== "POST") return send(res, 405, { error: "use POST" });
        controlGate(req);
        return send(res, 202, tests.run());
      }

      if (url.pathname === "/api/control") {
        if (!control) { const e = new Error("control disabled (OPENQ_CONTROL_ENABLED=0)"); e.statusCode = 503; throw e; }
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        const state = await control.state();
        state.readOnly = !config.control.token;
        return send(res, 200, state);
      }
      if (url.pathname.startsWith("/api/control/")) {
        if (!control) { const e = new Error("control disabled (OPENQ_CONTROL_ENABLED=0)"); e.statusCode = 503; throw e; }
        if (req.method !== "POST") return send(res, 405, { error: "use POST" });
        controlGate(req);
        const op = url.pathname.slice("/api/control/".length);
        const body = await readJsonBody(req);
        let result;
        if (op === "up") result = control.up();
        else if (op === "down") result = control.down();
        else if (op === "plant") result = control.plant(body.action);
        else if (op === "module") result = control.module(body.name, body.action);
        else if (op === "mongw") result = control.monGwOp(body.action);
        else if (op === "feeder") result = control.feeder(body.name, body.action);
        else if (op === "eod") result = control.eod(body.module);
        else return send(res, 404, { error: `no control op: ${op}` });
        return send(res, result.started ? 202 : 409, result);
      }

      if (url.pathname === "/api/replay") {
        if (!replay) { const e = new Error("replay disabled (OPENQ_REPLAY_ENABLED=0)"); e.statusCode = 503; throw e; }
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        const state = await replay.state();
        state.readOnly = !config.control.token;
        return send(res, 200, state);
      }
      if (url.pathname.startsWith("/api/replay/")) {
        if (!replay) { const e = new Error("replay disabled (OPENQ_REPLAY_ENABLED=0)"); e.statusCode = 503; throw e; }
        if (req.method !== "POST") return send(res, 405, { error: "use POST" });
        controlGate(req);
        const op = url.pathname.slice("/api/replay/".length);
        const body = await readJsonBody(req);
        let result;
        if (op === "start") {
          // a live feeder on the same module would interleave its synthetic
          // ticks with the replay - stop it first unless told not to
          if (control && body.stopFeeder !== false) {
            const fd = replay.feederFor(body.module);
            if (fd) { try { control.feeder(fd, "stop"); } catch { /* best effort */ } }
          }
          result = replay.start(body.module, body);
        } else if (op === "stop") {
          result = await replay.stop(body.module);
        } else if (op === "command") {
          result = await replay.command(body.module, body.verb, body.value);
        } else {
          return send(res, 404, { error: `no replay op: ${op}` });
        }
        return send(res, result.started ? 202 : 409, result);
      }

      if (url.pathname === "/api/modules") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        const name = url.searchParams.get("name");
        return send(res, 200, name ? await modules.topology(name) : { modules: modules.list() });
      }

      if (url.pathname === "/api/procmon") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        return send(res, 200, await procMon.read());
      }

      if (url.pathname === "/api/catalog") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        try {
          return send(res, 200, catalog.read());
        } catch (e) {
          const err = new Error(`data catalog unavailable: ${e.message}`);
          err.statusCode = 503;
          throw err;
        }
      }

      if (url.pathname === "/api/querymon") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!queryMon) { const e = new Error("query mon disabled (OPENQ_QUERYMON=0)"); e.statusCode = 503; throw e; }
        return send(res, 200, await queryMon.read());
      }

      if (url.pathname === "/api/pidstats") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!pidstats) { const e = new Error("pidstats disabled (set OPENQ_PIDSTATS_RDB to the mon_rdb host:port)"); e.statusCode = 503; throw e; }
        return send(res, 200, await pidstats.read());
      }

      if (url.pathname === "/api/eq/syms") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!eqOhlc) { const e = new Error("eq disabled (set OPENQ_EQ_HDB to the eq_hdb host:port)"); e.statusCode = 503; throw e; }
        return send(res, 200, await eqOhlc.syms());
      }
      if (url.pathname === "/api/eq/bars") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!eqOhlc) { const e = new Error("eq disabled (set OPENQ_EQ_HDB to the eq_hdb host:port)"); e.statusCode = 503; throw e; }
        return send(res, 200, await eqOhlc.bars(url.searchParams.get("sym"), url.searchParams.get("days")));
      }

      if (url.pathname === "/api/ohlc") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!ohlc) { const e = new Error("ohlc disabled (set OPENQ_OHLC_STREAM)"); e.statusCode = 503; throw e; }
        const sp = url.searchParams;
        const syms = ohlc.syms();
        const want = sp.get("sym");
        const sym = want && syms.includes(want) ? want : syms[0] || null;
        const bucketSec = Math.max(1, Math.min(3600, Number(sp.get("bucket")) || 15));
        const count = Math.max(1, Math.min(500, Number(sp.get("count")) || 90));
        const bars = sym ? ohlc.bars(sym, bucketSec, count) : [];
        const last = bars.length ? bars[bars.length - 1].close : null;
        const first = bars.length ? bars[0].open : null;
        return send(res, 200, {
          connected: ohlc.connected, sym, syms, bucketSec, count: bars.length, bars, last,
          hi: bars.length ? Math.max(...bars.map((b) => b.high)) : null,
          lo: bars.length ? Math.min(...bars.map((b) => b.low)) : null,
          changePct: first && last ? (last / first - 1) * 100 : null,
        });
      }

      if (url.pathname === "/api/report") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!report) {
          const e = new Error("report disabled (set OPENQ_REPORT_CEP)");
          e.statusCode = 503;
          throw e;
        }
        return send(res, 200, await report.read());
      }

      if (url.pathname === "/api/hdbhealth") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!hdbHealth) {
          const e = new Error("hdb health disabled (set OPENQ_HDBHEALTH to the mon_hdb host:port)");
          e.statusCode = 503;
          throw e;
        }
        return send(res, 200, await hdbHealth.read(url.searchParams.get("source")));
      }

      if (url.pathname === "/api/prime") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!prime) {
          const e = new Error("prime disabled (set OPENQ_PRIME_CEP)");
          e.statusCode = 503;
          throw e;
        }
        return send(res, 200, await prime.read());
      }

      if (url.pathname === "/api/spread") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!spread) {
          const e = new Error("spread disabled (set OPENQ_SPREAD_CEP)");
          e.statusCode = 503;
          throw e;
        }
        return send(res, 200, await spread.read());
      }

      if (url.pathname === "/api/tables") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!tables) {
          const e = new Error("table survey disabled (no OPENQ_TABLE_SOURCES)");
          e.statusCode = 503;
          throw e;
        }
        return send(res, 200, await tables.readAll());
      }

      if (url.pathname === "/api/explore") {
        if (!explore) {
          const e = new Error("explorer disabled (no queryable OPENQ_TABLE_SOURCES)");
          e.statusCode = 503;
          throw e;
        }
        if (req.method === "GET" && !url.searchParams.get("source")) {
          return send(res, 200, { sources: explore.sources() });
        }
        let spec;
        if (req.method === "GET") {
          const sp = url.searchParams;
          const csv = (k) => (sp.get(k) ? sp.get(k).split(",").map((s) => s.trim()).filter(Boolean) : undefined);
          spec = {
            source: sp.get("source"),
            table: sp.get("table"),
            columns: csv("columns"),
            sym: csv("sym"),
            start: sp.get("start") || undefined,
            end: sp.get("end") || undefined,
            order: sp.get("order") || undefined,
            dir: sp.get("dir") || undefined,
            limit: sp.get("limit") || undefined,
          };
        } else if (req.method === "POST") {
          spec = await readJsonBody(req);
        } else {
          return send(res, 405, { error: "use GET or POST" });
        }
        return send(res, 200, await explore.query(spec));
      }

      if (url.pathname === "/api/markout") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        if (!markout) {
          const e = new Error("markout disabled (set OPENQ_MARKOUT_CEP)");
          e.statusCode = 503;
          throw e;
        }
        return send(res, 200, await markout.read());
      }

      if (url.pathname === "/api/query") {
        let spec;
        if (req.method === "GET") spec = specFromSearch(url.searchParams);
        else if (req.method === "POST") spec = await readJsonBody(req);
        else return send(res, 405, { error: "use GET or POST" });
        const body = await runQuery(pickGw(spec.target), spec);
        return send(res, 200, body);
      }

      if (url.pathname === "/api/logs") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        const sp = url.searchParams;
        const csv = (k) => (sp.get(k) ? sp.get(k).split(",").map((s) => s.trim()).filter(Boolean) : []);
        const body = readLogs(config.logs, {
          limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
          level: csv("level"),
          proc: csv("proc"),
          q: sp.get("q") || "",
          since: sp.get("since") || "",
        });
        return send(res, 200, body);
      }

      return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 502;
      return send(res, status, { error: err.message || String(err) });
    }
  });

  // ---- WebSocket: live ticks ------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (pathname !== "/stream") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    // table -> Set(sym) | null (null = all syms)
    ws.subs = new Map();

    ws.send(
      JSON.stringify({
        type: "hello",
        stream: stream ? stream.status() : { enabled: false },
      })
    );

    if (!stream) {
      ws.send(JSON.stringify({ type: "error", message: "streaming disabled (set OPENQ_STREAM_PORT)" }));
    }

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
      }
      const action = msg && msg.action;
      try {
        if (action === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (action === "subscribe") {
          if (!stream) throw new Error("streaming disabled");
          checkTable(msg.table);
          const syms = Array.isArray(msg.sym) && msg.sym.length ? new Set(msg.sym) : null;
          const had = ws.subs.has(msg.table);
          ws.subs.set(msg.table, syms);
          if (!had) stream.addRef(msg.table);
          ws.send(JSON.stringify({ type: "subscribed", table: msg.table, sym: syms ? [...syms] : "all" }));
        } else if (action === "unsubscribe") {
          if (ws.subs.has(msg.table)) {
            ws.subs.delete(msg.table);
            stream && stream.release(msg.table);
          }
          ws.send(JSON.stringify({ type: "unsubscribed", table: msg.table }));
        } else {
          ws.send(JSON.stringify({ type: "error", message: `unknown action: ${action}` }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: err.message || String(err) }));
      }
    });

    ws.on("close", () => {
      for (const table of ws.subs.keys()) stream && stream.release(table);
      ws.subs.clear();
    });
  });

  if (stream) {
    stream.on("tick", ({ table, columns, rows }) => {
      for (const ws of wss.clients) {
        if (ws.readyState !== ws.OPEN) continue;
        const filt = ws.subs.get(table);
        if (filt === undefined) continue;
        const out = filt ? rows.filter((r) => filt.has(r.sym)) : rows;
        if (!out.length) continue;
        ws.send(JSON.stringify({ type: "tick", table, columns, rows: out }));
      }
    });
  }

  async function start() {
    const starts = await Promise.all([...gws].map(async ([n, g]) => [n, await g.start()]));
    if (stream) stream.start();
    if (markout) markout.start();
    if (spread) spread.start();
    if (prime) prime.start();
    if (report) report.start();
    if (hdbHealth) hdbHealth.start();
    if (ohlc) ohlc.start();
    if (eqOhlc) eqOhlc.start();
    if (queryMon) queryMon.start();
    if (pidstats) pidstats.start();
    if (tables) tables.start();
    if (explore) explore.start();
    procMon.start();
    await new Promise((resolve) => httpServer.listen(config.port, resolve));
    return { targets: Object.fromEntries(starts) };
  }

  async function stop() {
    await new Promise((res) => httpServer.close(() => res()));
    if (replay) await replay.stopAll();
    for (const ws of wss.clients) ws.terminate();
    await Promise.all([...gws.values()].map((g) => g.stop()));
    if (stream) await stream.stop();
    if (markout) await markout.stop();
    if (spread) await spread.stop();
    if (prime) await prime.stop();
    if (report) await report.stop();
    if (hdbHealth) await hdbHealth.stop();
    if (ohlc) await ohlc.stop();
    if (eqOhlc) await eqOhlc.stop();
    if (queryMon) await queryMon.stop();
    if (pidstats) await pidstats.stop();
    if (tables) await tables.stop();
    if (explore) await explore.stop();
    await procMon.stop();
  }

  return { httpServer, wss, gws, stream, markout, spread, prime, report, hdbHealth, ohlc, eqOhlc, tables, explore, procMon, control, replay, queryMon, pidstats, start, stop };
}

module.exports = { createServer };
