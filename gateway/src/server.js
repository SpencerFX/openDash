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
const { TablesReader } = require("./tables");

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
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
  const tables =
    config.tableSources && config.tableSources.length
      ? new TablesReader(config.tableSources)
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
          tables: tables ? tables.status() : { enabled: false },
        });
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
    if (tables) tables.start();
    await new Promise((resolve) => httpServer.listen(config.port, resolve));
    return { targets: Object.fromEntries(starts) };
  }

  async function stop() {
    await new Promise((res) => httpServer.close(() => res()));
    for (const ws of wss.clients) ws.terminate();
    await Promise.all([...gws.values()].map((g) => g.stop()));
    if (stream) await stream.stop();
    if (markout) await markout.stop();
    if (tables) await tables.stop();
  }

  return { httpServer, wss, gws, stream, markout, tables, start, stop };
}

module.exports = { createServer };
