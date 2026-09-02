"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { QSession } = require("./qSession");

// Drives openQ's modules/replay/replay.q - one paced tp-log replay process
// per configured module (markout, spread, ...). Each replay.q re-publishes
// real captured ticks into that module's live tickerplant against a
// simulated clock, so the markout / market-impact / spread CEPs and the
// dashboards reading them run on realistic moving data instead of the
// synthetic node feeders.
//
// Same shape as ControlManager: spawn detached, track the pid, log to a
// file. Additionally holds one reconnecting QSession per running replay so
// the .rp.* control verbs (pause / resume / setSpeed / restart) and the
// .rp.status[] poll go straight over IPC. Mutating routes are gated in
// server.js behind OPENQ_CONTROL_TOKEN, same as the Control page.

// "/c/q/w64/q" (MSYS) -> "C:/q/w64/q.exe" for a direct Node spawn().
function toNativeExe(p) {
  let w = String(p || "").replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  if (process.platform === "win32" && !/\.[a-z0-9]+$/i.test(w)) w += ".exe";
  return w;
}

function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 10;
  return Math.max(0.25, Math.min(500, n));
}

// jkdb decodes a q dict to a plain object; just make timestamps portable.
function normStatus(d) {
  if (!d || typeof d !== "object") return null;
  const o = {};
  for (const k of Object.keys(d)) {
    const v = d[k];
    o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v;
  }
  return o;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

class ReplayManager {
  constructor(cfg) {
    this.enabled = cfg.enabled !== false;
    this.root = cfg.root;
    this.qExe = toNativeExe(cfg.qBin);
    this.logDir = cfg.logDir;
    this.host = cfg.host || "127.0.0.1";
    this.opTimeoutMs = Math.max(4000, cfg.opTimeoutMs || 20000);
    this.defaults = { speed: 10, stamp: "now", loop: true, lastn: 6, ...(cfg.defaults || {}) };

    // module name -> target record
    this.targets = new Map();
    for (const t of cfg.targets || []) {
      this.targets.set(t.module, {
        module: t.module,
        tp: t.tp,
        src: t.src,
        schema: t.schema,
        port: t.port,
        feeder: t.feeder || null,
        pages: t.pages || [],
        lastn: t.lastn,
        proc: null,       // { pid, startedAt, speed, stamp, loop, lastn, paused, logFile }
        session: null,    // QSession
        lastStatus: null,
      });
    }

    try { fs.mkdirSync(this.logDir, { recursive: true }); } catch { /* ignore */ }
  }

  has(name) { return this.targets.has(name); }
  names() { return [...this.targets.keys()]; }
  feederFor(name) { const t = this.targets.get(name); return t ? t.feeder : null; }

  _ensureSession(name) {
    const t = this.targets.get(name);
    if (!t) return null;
    if (t.session) return t.session;
    const s = new QSession({
      host: this.host, port: t.port,
      timeoutMs: 4000, reconnectMs: 1500, label: `replay:${name}`,
    });
    s.start();
    t.session = s;
    return s;
  }

  async _dropSession(t) {
    if (t.session) {
      try { await t.session.stop(); } catch { /* ignore */ }
      t.session = null;
    }
  }

  // ---- spawn / kill --------------------------------------------------

  start(name, opts = {}) {
    if (!this.enabled) return { started: false, reason: "replay is disabled on the gateway (OPENQ_REPLAY_ENABLED=0)" };
    const t = this.targets.get(name);
    if (!t) return { started: false, reason: `unknown replay target: ${name} (have: ${this.names().join(", ")})` };
    if (t.proc && alive(t.proc.pid)) return { started: false, reason: `${name} replay already running (pid ${t.proc.pid}) - stop it first` };

    const speed = clampSpeed(opts.speed ?? this.defaults.speed);
    const stamp = opts.stamp === "keep" ? "keep" : "now";
    const loop = opts.loop == null ? this.defaults.loop : !!opts.loop;
    const lastn = Number.isFinite(opts.lastn) ? Math.trunc(opts.lastn)
      : Number.isFinite(t.lastn) ? t.lastn : this.defaults.lastn;
    const paused = !!opts.paused;

    const args = [
      "modules/replay/replay.q",
      "-src", t.src,
      "-tp", t.tp,
      "-schema", t.schema,
      "-speed", String(speed),
      "-stamp", stamp,
      "-port", String(t.port),
      "-lastn", String(lastn),
    ];
    if (loop) args.push("-loop");
    if (paused) args.push("-paused");

    const logFile = path.join(this.logDir, `replay_${name}.log`);
    let fd;
    try { fd = fs.openSync(logFile, "a"); } catch { fd = "ignore"; }
    let child;
    try {
      child = spawn(this.qExe, args, {
        cwd: this.root, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env },
      });
    } catch (e) {
      return { started: false, reason: `spawn failed: ${e.message}` };
    }
    child.unref();

    t.proc = { pid: child.pid, startedAt: new Date().toISOString(), speed, stamp, loop, lastn, paused, logFile };
    t.lastStatus = null;
    this._ensureSession(name);
    return { started: true, module: name, pid: child.pid, port: t.port, speed, stamp, loop, lastn, paused };
  }

  async stop(name) {
    const t = this.targets.get(name);
    if (!t) return { started: false, reason: `unknown replay target: ${name}` };
    const pid = t.proc && t.proc.pid;
    await this._dropSession(t);
    if (pid && alive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* try taskkill */ }
      if (process.platform === "win32") {
        await new Promise((r) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => r()));
      }
    }
    t.proc = null;
    t.lastStatus = null;
    return { started: true, module: name, stopped: pid || null };
  }

  async stopAll() {
    for (const name of this.targets.keys()) await this.stop(name);
  }

  // ---- control verbs ----------------------------------------------

  async command(name, verbRaw, value) {
    const verb = String(verbRaw || "");
    const t = this.targets.get(name);
    if (!t) return { started: false, reason: `unknown replay target: ${name}` };
    if (!(t.proc && alive(t.proc.pid))) return { started: false, reason: `${name} replay is not running` };

    let expr;
    if (verb === "pause") expr = ".rp.pause[]";
    else if (verb === "resume") expr = ".rp.resume[]";
    else if (verb === "restart") expr = ".rp.restart[]";
    else if (verb === "speed") {
      const sp = clampSpeed(value);
      expr = `.rp.setSpeed[${sp}]`;
      t.proc.speed = sp;
    } else return { started: false, reason: `unknown replay verb: ${verb} (pause|resume|restart|speed)` };

    const s = this._ensureSession(name);
    try {
      const res = await s.sync(expr, { timeoutMs: this.opTimeoutMs });
      t.lastStatus = normStatus(res);
      if (verb === "pause") t.proc.paused = true;
      if (verb === "resume") t.proc.paused = false;
      return { started: true, module: name, verb, status: t.lastStatus };
    } catch (e) {
      return { started: false, reason: e.message || String(e) };
    }
  }

  // ---- state ------------------------------------------------------

  async _pollStatus(t) {
    if (!(t.proc && alive(t.proc.pid))) return null;
    const s = this._ensureSession(t.module);
    if (!s || !s.connected) return t.lastStatus;
    try {
      const res = await s.sync(".rp.status[]", { timeoutMs: 4000 });
      t.lastStatus = normStatus(res);
    } catch { /* keep last */ }
    return t.lastStatus;
  }

  async state() {
    const targets = [];
    for (const t of this.targets.values()) {
      const running = !!(t.proc && alive(t.proc.pid));
      const status = running ? await this._pollStatus(t) : null;
      targets.push({
        module: t.module,
        tp: t.tp,
        src: t.src,
        schema: t.schema,
        port: t.port,
        feeder: t.feeder,
        pages: t.pages,
        running,
        pid: running ? t.proc.pid : null,
        startedAt: running ? t.proc.startedAt : null,
        opts: running ? { speed: t.proc.speed, stamp: t.proc.stamp, loop: t.proc.loop, lastn: t.proc.lastn, paused: t.proc.paused } : null,
        status,
      });
    }
    return { enabled: this.enabled, defaults: this.defaults, targets };
  }

  status() {
    const running = [...this.targets.values()].filter((t) => t.proc && alive(t.proc.pid));
    return {
      enabled: this.enabled,
      targets: this.targets.size,
      running: running.length,
      playing: running.filter((t) => t.lastStatus && t.lastStatus.playing).map((t) => t.module),
    };
  }
}

module.exports = { ReplayManager };
