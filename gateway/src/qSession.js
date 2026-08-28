"use strict";

const { EventEmitter } = require("events");
const { QConnection } = require("jkdb");

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RECONNECT_MS = 1000;

class TimeoutError extends Error {
  constructor(target, ms) {
    super(`q sync to ${target} timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.statusCode = 504;
  }
}
class NotConnectedError extends Error {
  constructor(target) {
    super(`not connected to ${target}`);
    this.name = "NotConnectedError";
    this.statusCode = 503;
  }
}

// One reconnecting jkdb connection to a single q process. Owns the whole
// connect / drop / backoff-reconnect lifecycle so callers don't each
// reimplement it, and enforces a per-query timeout so a hung peer can't
// wedge a request until the TCP socket eventually dies.
//
// Events: "connect", "disconnect", "upd" (raw jkdb upd payload).
class QSession extends EventEmitter {
  // opts: { host, port, user?, password?, timeoutMs?, reconnectMs?, label? }
  constructor(opts) {
    super();
    this.opts = opts;
    this.host = opts.host;
    this.port = opts.port;
    this.label = opts.label || `${opts.host}:${opts.port}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.reconnectMs = opts.reconnectMs ?? DEFAULT_RECONNECT_MS;
    this.q = null;
    this.connected = false;
    this.stopped = false;
    this.reconnects = 0;
  }

  get target() {
    return `${this.host}:${this.port}`;
  }

  start() {
    if (!this.stopped && !this.q) this._open();
    return this;
  }

  _scheduleReopen() {
    if (this.stopped) return;
    this.q = null;
    this.reconnects += 1;
    setTimeout(() => this._open(), this.reconnectMs);
  }

  _open() {
    if (this.stopped) return;
    const q = new QConnection({
      host: this.host,
      port: this.port,
      user: this.opts.user || undefined,
      password: this.opts.password || undefined,
      socketNoDelay: true,
    });
    this.q = q;

    q.on("upd", (msg) => this.emit("upd", msg));

    const gone = () => {
      if (this.q !== q) return;
      const was = this.connected;
      this.connected = false;
      if (was) this.emit("disconnect");
      this._scheduleReopen();
    };
    q.on("close", gone);
    q.on("end", gone);
    q.on("error", () => {}); // handled via connect callback / close

    q.connect((err) => {
      if (this.q !== q) return;
      if (err) return this._scheduleReopen();
      this.connected = true;
      this.emit("connect");
    });
  }

  // Sync query with a timeout. Rejects with NotConnectedError (503),
  // TimeoutError (504), or the q error. On timeout the socket is dropped so
  // the orphaned jkdb callback can't later be handed a subsequent query's
  // reply (jkdb's callback queue is a plain FIFO), and the reconnect loop
  // takes over.
  sync(expr, { timeoutMs } = {}) {
    const limit = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.q) return reject(new NotConnectedError(this.target));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new TimeoutError(this.target, limit));
        try {
          this.q && this.q.close(() => {});
        } catch {
          /* ignore */
        }
      }, limit);
      this.q.sync(expr, (err, res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(res);
      });
    });
  }

  // fire-and-forget async call; no-op if not connected
  asyn(expr) {
    if (this.connected && this.q) {
      try {
        this.q.asyn(expr);
      } catch {
        /* ignore */
      }
    }
  }

  status() {
    return { target: this.target, connected: this.connected, reconnects: this.reconnects };
  }

  stop() {
    this.stopped = true;
    const q = this.q;
    this.q = null;
    return new Promise((res) => {
      try {
        q ? q.close(() => res()) : res();
      } catch {
        res();
      }
    });
  }
}

module.exports = { QSession, TimeoutError, NotConnectedError };
