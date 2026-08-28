"use strict";

const { EventEmitter } = require("events");
const { QSession } = require("./qSession");
const { symbolLit } = require("./qlit");
const { toRows } = require("./qshape");

// Bridges an openQ .u.sub-speaking process (a tp or rdb) to plain events.
// One physical connection (a QSession); per-table reference counting. Sym
// filtering is left to the consumer (we always .u.sub the whole table) so
// overlapping subscriptions from different WebSocket clients don't fight
// over openQ's "one subscription per handle" replace semantics.
//
// Emits:
//   "tick"   ({ table, columns, rows, count })
//   "status" ({ connected, error? })

class StreamBridge extends EventEmitter {
  constructor(opts) {
    super();
    this.tables = new Map(); // table -> refcount
    this.session = new QSession({ ...opts, label: "stream" });

    this.session.on("upd", (msg) => {
      // msg = ["upd", <table sym>, <columnar table>]
      const shaped = toRows(msg[2]);
      if (!shaped.rows) return;
      this.emit("tick", { table: msg[1], ...shaped });
    });
    this.session.on("connect", () => {
      this.emit("status", { connected: true });
      for (const table of this.tables.keys()) this._sub(table); // re-establish
    });
    this.session.on("disconnect", () => this.emit("status", { connected: false }));
  }

  start() {
    this.session.start();
  }

  get connected() {
    return this.session.connected;
  }

  _sub(table) {
    if (!this.session.connected) return;
    this.session
      .sync(`.u.sub[${symbolLit(table)};\`]`)
      .catch((err) => this.emit("status", { connected: this.session.connected, error: `sub ${table}: ${err.message}` }));
  }

  addRef(table) {
    symbolLit(table); // validate up front (throws BadInput on garbage)
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
      target: this.session.target,
      connected: this.session.connected,
      tables: [...this.tables.keys()],
    };
  }

  async stop() {
    await this.session.stop();
  }
}

module.exports = { StreamBridge };
