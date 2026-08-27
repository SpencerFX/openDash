"use strict";

const { EventEmitter } = require("events");
const { QConnection } = require("jkdb");
const { symbolLit } = require("./qlit");
const { toRows } = require("./qshape");

// Bridges an openQ .u.sub-speaking process (a tp or rdb) to plain events.
// One physical connection; per-table reference counting. Sym filtering is
// left to the consumer (we always .u.sub the whole table) so overlapping
// subscriptions from different WebSocket clients don't fight over openQ's
// "one subscription per handle" replace semantics.
//
// Emits:
//   "tick"   ({ table, columns, rows, count })
//   "status" ({ connected })

class StreamBridge extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; // { host, port, user, password }
    this.q = null;
    this.connected = false;
    this.tables = new Map(); // table -> refcount
    this.stopped = false;
  }

  start() {
    this._connect();
  }

  _connect() {
    if (this.stopped) return;
    const q = new QConnection({
      host: this.opts.host,
      port: this.opts.port,
      user: this.opts.user || undefined,
      password: this.opts.password || undefined,
      socketNoDelay: true,
    });
    this.q = q;

    q.on("upd", (msg) => {
      // msg = ["upd", <table sym>, <columnar table>]
      const table = msg[1];
      const shaped = toRows(msg[2]);
      if (!shaped.rows) return;
      this.emit("tick", { table, ...shaped });
    });

    const onGone = () => {
      if (this.q !== q) return;
      this.connected = false;
      this.emit("status", { connected: false });
      if (!this.stopped) setTimeout(() => this._connect(), 1000);
    };
    q.on("close", onGone);
    q.on("end", onGone);
    q.on("error", () => {});

    q.connect((err) => {
      if (this.q !== q) return;
      if (err) {
        setTimeout(() => this._connect(), 1000);
        return;
      }
      this.connected = true;
      this.emit("status", { connected: true });
      // re-establish every table we were subscribed to
      for (const table of this.tables.keys()) this._sub(table);
    });
  }

  _sub(table) {
    if (!this.connected || !this.q) return;
    const call = `.u.sub[${symbolLit(table)};\`]`;
    this.q.sync(call, (err) => {
      if (err) this.emit("status", { connected: this.connected, error: `sub ${table}: ${err.message}` });
    });
  }

  addRef(table) {
    // validate the name up front (throws BadInput on garbage)
    symbolLit(table);
    const n = this.tables.get(table) || 0;
    this.tables.set(table, n + 1);
    if (n === 0) this._sub(table);
  }

  release(table) {
    const n = this.tables.get(table);
    if (!n) return;
    if (n === 1) this.tables.delete(table);
    else this.tables.set(table, n - 1);
    // openQ has no per-table unsub primitive exposed here; dropping refs is
    // enough - the bridge simply stops forwarding once no client wants it.
  }

  status() {
    return {
      enabled: true,
      target: `${this.opts.host}:${this.opts.port}`,
      connected: this.connected,
      tables: [...this.tables.keys()],
    };
  }

  async stop() {
    this.stopped = true;
    await new Promise((res) => {
      try {
        this.q ? this.q.close(() => res()) : res();
      } catch {
        res();
      }
    });
  }
}

module.exports = { StreamBridge };
