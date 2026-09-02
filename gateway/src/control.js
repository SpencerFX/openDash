"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, execFile } = require("child_process");

// Process control for the openQ platform, backing the dashboard's System >
// Control page. Everything here shells out to the same scripts an operator
// would run by hand (scripts/startup.sh, scripts/startupAllByModule.sh, the
// node feeders under tools/) or, for EOD, makes one IPC call to a running
// idb writer. One operation at a time (a global mutex), every run recorded
// with its exit code + output tail.
//
// Mutating calls are gated in server.js behind OPENQ_CONTROL_TOKEN - this
// class trusts its caller and only guards against bad names / concurrent ops.

const MODULE_RE = /^[a-z][a-z0-9_]*$/;

function tcpProbe(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (up) => {
      try { s.destroy(); } catch { /* ignore */ }
      resolve(up);
    };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// "/c/q/w64/q" (MSYS, fine for bash's Q_BIN) -> "C:/q/w64/q.exe" for a
// direct Node spawn(), which can't resolve MSYS paths on Windows.
function toNativeExe(p) {
  let w = String(p || "").replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  if (process.platform === "win32" && !/\.[a-z0-9]+$/i.test(w)) w += ".exe";
  return w;
}

class ControlManager {
  constructor(cfg) {
    this.root = cfg.root;                       // .../openQ
    this.scripts = path.join(this.root, "scripts");
    this.core = path.join(this.root, "core");
    this.logDir = path.join(this.scripts, "logs");
    this.cfgDir = cfg.cfgDir || path.join(this.root, "cfg_proc");
    this.qBin = cfg.qBin;                       // MSYS form, for bash's Q_BIN
    this.qExe = toNativeExe(cfg.qBin);          // native form, for spawn()
    this.dataDir = cfg.dataDir;
    this.withCep = !!cfg.withCep;
    this.withIdb = !!cfg.withIdb;
    this.bash = cfg.bash || "bash";
    this.host = cfg.host || "127.0.0.1";
    this.modules = cfg.modules;                 // ["mon","markout",...]
    this.monGw = cfg.monGw;                     // {name,port,rdbaddr,hdbaddr,schema}
    this.feeders = cfg.feeders;                 // [{name,script}]
    this.feederDir = cfg.feederDir;
    this.feederLogDir = cfg.feederLogDir;
    this.opTimeoutMs = cfg.opTimeoutMs || 300000;

    this._current = null;                       // {action,target,startedAt,steps:[]}
    this._history = [];                         // newest first, capped
    this._feederPids = {};                      // name -> {pid,startedAt,logFile}
    this._monGwProc = null;                     // {pid,startedAt}
    this._scan = { at: 0, map: {} };            // cached CIM feeder scan

    try { fs.mkdirSync(this.feederLogDir, { recursive: true }); } catch { /* ignore */ }
  }

  // ---- mutex / history --------------------------------------------------

  _begin(action, target) {
    if (this._current) {
      const e = new Error(`busy: ${this._current.action} ${this._current.target} already running`);
      e.statusCode = 409;
      throw e;
    }
    this._current = { action, target, startedAt: new Date().toISOString(), steps: [] };
    return this._current;
  }

  _finish(op, { ok, exitCode = null, output = "" }) {
    if (this._current !== op) return;
    this._current = null;
    this._history.unshift({
      action: op.action,
      target: op.target,
      startedAt: op.startedAt,
      finishedAt: new Date().toISOString(),
      ok,
      exitCode,
      steps: op.steps.length ? op.steps : undefined,
      output: (output || "").slice(-8000),
    });
    this._history.length = Math.min(this._history.length, 40);
  }

  // ---- low-level runners ----------------------------------------------

  // spawn a command, capture combined output, resolve {code,output}. Also
  // streams to a per-run logfile under scripts/logs/.
  _run(op, label, cmd, args, extraEnv, cwd) {
    const logFile = path.join(this.logDir, `control_${label}.log`);
    return new Promise((resolve) => {
      let ws;
      try { ws = fs.createWriteStream(logFile, { flags: "w" }); } catch { ws = null; }
      const header = `# ${new Date().toISOString()}  ${cmd} ${args.join(" ")}\n`;
      if (ws) ws.write(header);
      let buf = header;
      let child;
      try {
        child = spawn(cmd, args, {
          cwd: cwd || this.root,
          env: { ...process.env, ...(extraEnv || {}) },
        });
      } catch (e) {
        resolve({ code: -1, output: `${buf}spawn failed: ${e.message}\n` });
        return;
      }
      const onData = (d) => {
        const s = d.toString();
        buf += s;
        if (buf.length > 200000) buf = buf.slice(-200000);
        if (ws) ws.write(s);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const killTimer = setTimeout(() => {
        buf += `\n# timeout after ${this.opTimeoutMs}ms - killing\n`;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, this.opTimeoutMs);
      child.on("error", (e) => {
        clearTimeout(killTimer);
        if (ws) ws.end();
        resolve({ code: -1, output: `${buf}error: ${e.message}\n` });
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (ws) ws.end();
        resolve({ code: code == null ? -1 : code, output: buf });
      });
    });
  }

  async _script(op, stepLabel, scriptName, scriptArgs = [], extraEnv = {}) {
    const script = path.join(this.scripts, scriptName);
    if (!fs.existsSync(script)) {
      op.steps.push({ step: stepLabel, ok: false, note: `missing: ${script}` });
      return { code: -1, output: `missing script ${script}` };
    }
    const env = { Q_BIN: this.qBin, DATA_DIR: this.dataDir, ...extraEnv };
    const r = await this._run(op, stepLabel, this.bash, [script, ...scriptArgs], env);
    op.steps.push({ step: stepLabel, ok: r.code === 0, exitCode: r.code });
    return r;
  }

  // ---- feeders --------------------------------------------------------

  _feederLog(name) { return path.join(this.feederLogDir, `feed-${name}.log`); }

  // best-effort: node feeders started outside this process, matched by
  // "<name>-feeder.js" in the command line (Windows: Get-CimInstance).
  _scanFeeders() {
    if (Date.now() - this._scan.at < 2000) return Promise.resolve(this._scan.map);
    return new Promise((resolve) => {
      if (process.platform !== "win32") { this._scan = { at: Date.now(), map: {} }; return resolve({}); }
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          const map = {};
          if (!err && stdout && stdout.trim()) {
            let rows;
            try { rows = JSON.parse(stdout); } catch { rows = []; }
            if (!Array.isArray(rows)) rows = [rows];
            for (const row of rows) {
              const cl = row && row.CommandLine;
              if (!cl) continue;
              const m = /([a-z]+)-feeder\.js/i.exec(cl);
              if (m) map[m[1].toLowerCase()] = Number(row.ProcessId);
            }
          }
          this._scan = { at: Date.now(), map };
          resolve(map);
        }
      );
    });
  }

  async _feederState(scan) {
    const out = [];
    for (const f of this.feeders) {
      const tracked = this._feederPids[f.name];
      let pid = tracked && alive(tracked.pid) ? tracked.pid : null;
      if (!pid && scan[f.name] && alive(scan[f.name])) pid = scan[f.name];
      let lastLine = null;
      let ageMs = null;
      try {
        const st = fs.statSync(this._feederLog(f.name));
        ageMs = Date.now() - st.mtimeMs;
        const txt = fs.readFileSync(this._feederLog(f.name), "utf8").trim().split(/\r?\n/);
        lastLine = txt[txt.length - 1] || null;
      } catch { /* no log yet */ }
      out.push({
        name: f.name,
        script: f.script,
        running: !!pid,
        pid: pid || null,
        source: pid && tracked && tracked.pid === pid ? "managed" : pid ? "external" : null,
        logMtimeAgeMs: ageMs,
        lastLine,
      });
    }
    return out;
  }

  _startFeeder(op, name) {
    const f = this.feeders.find((x) => x.name === name);
    const logFile = this._feederLog(name);
    let fd;
    try { fd = fs.openSync(logFile, "a"); } catch { fd = "ignore"; }
    const child = spawn("node", [path.join(this.feederDir, f.script)], {
      cwd: this.feederDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env },
    });
    child.unref();
    this._feederPids[name] = { pid: child.pid, startedAt: new Date().toISOString(), logFile };
    op.steps.push({ step: `start feeder ${name}`, ok: true, pid: child.pid });
    return child.pid;
  }

  async _stopFeeder(op, name) {
    const scan = await this._scanFeeders();
    const tracked = this._feederPids[name];
    const pid = (tracked && alive(tracked.pid) && tracked.pid) || (alive(scan[name]) && scan[name]) || null;
    if (!pid) { op.steps.push({ step: `stop feeder ${name}`, ok: true, note: "not running" }); return; }
    let killed = false;
    try { process.kill(pid, "SIGTERM"); killed = true; } catch { /* try taskkill */ }
    if (process.platform === "win32") {
      await new Promise((r) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => r()));
      killed = true;
    }
    delete this._feederPids[name];
    op.steps.push({ step: `stop feeder ${name}`, ok: killed, pid });
  }

  // ---- mon_gw -------------------------------------------------------

  _startMonGw(op) {
    const g = this.monGw;
    const logFile = path.join(this.logDir, `bymod_${g.name}.log`);
    let fd;
    try { fd = fs.openSync(logFile, "a"); } catch { fd = "ignore"; }
    const args = [
      "init.q", "-procType", "gw", "-name", g.name, "-port", String(g.port),
      "-rdbaddr", g.rdbaddr, "-hdbaddr", g.hdbaddr, "-schema", g.schema,
    ];
    const child = spawn(this.qExe, args, {
      cwd: this.core, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env },
    });
    child.unref();
    this._monGwProc = { pid: child.pid, startedAt: new Date().toISOString() };
    op.steps.push({ step: "start mon_gw", ok: true, pid: child.pid });
  }

  async _stopMonGw(op) {
    let pid = this._monGwProc && alive(this._monGwProc.pid) ? this._monGwProc.pid : null;
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
      if (process.platform === "win32") {
        await new Promise((r) => execFile("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true }, () => r()));
      }
    }
    this._monGwProc = null;
    op.steps.push({ step: "stop mon_gw", ok: true, note: pid ? `killed ${pid}` : "not tracked (use module stop / taskkill)" });
  }

  // ---- state --------------------------------------------------------
  //
  // Liveness is derived from TCP-probing each role's configured port, NOT
  // from the pidfiles: on this Windows/MSYS setup the scripts' `$!` is a
  // bash pseudo-pid, not the q process's Windows pid, so process.kill(pid,0)
  // is meaningless. The pidfile is still read for the recorded pids.

  // [{role, port}] from a dir of cfg_proc role JSONs. The rdb runs as an
  // active/standby pair with no top-level `port` (params.port1 is the
  // active instance - openQ core/rdb.q); probe that one for module liveness.
  _rolePorts(dir) {
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            const port = Number(j.port) || Number(j.params && j.params.port1) || null;
            return { role: j.procType || path.basename(f, ".json"), port };
          } catch { return null; }
        })
        // eod is a one-shot batch job, never a running daemon - don't probe it
        .filter((x) => x && x.port && x.role !== "eod");
    } catch { return []; }
  }

  _pidfilePids(name) {
    try {
      return fs.readFileSync(path.join(this.logDir, name), "utf8").trim().split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const sp = line.indexOf(" ");
          return { role: sp === -1 ? line : line.slice(0, sp), pid: sp === -1 ? null : Number(line.slice(sp + 1).trim()) };
        });
    } catch { return null; }
  }

  async _probeRoles(roles) {
    return Promise.all(roles.map(async (r) => ({ ...r, up: await tcpProbe(this.host, r.port) })));
  }

  async _plantState() {
    let roles = this._rolePorts(this.cfgDir);
    if (!roles.length) {
      roles = [
        { role: "tp", port: 5010 }, { role: "rdb", port: 5011 },
        { role: "hdb", port: 5012 }, { role: "gw", port: 5013 },
      ];
    }
    // housekeeping is never a daemon here; cep/idb only if startup.sh was
    // told to include them (WITH_CEP / WITH_IDB)
    roles = roles.filter((r) =>
      r.role !== "housekeeping" &&
      (this.withCep || r.role !== "cep") &&
      (this.withIdb || r.role !== "idb"));
    const probed = await this._probeRoles(roles);
    return {
      up: probed.some((p) => p.up),
      upCount: probed.filter((p) => p.up).length,
      total: probed.length,
      pidfilePresent: !!this._pidfilePids("openq.pids"),
      procs: probed,
    };
  }

  async _moduleStates() {
    return Promise.all(this.modules.map(async (name) => {
      const probed = await this._probeRoles(this._rolePorts(path.join(this.cfgDir, "modules", name)));
      const upCount = probed.filter((p) => p.up).length;
      return {
        name,
        up: upCount > 0,
        procCount: upCount,
        total: probed.length,
        pidfilePresent: !!this._pidfilePids(`openq-${name}.pids`),
        procs: probed,
      };
    }));
  }

  async state() {
    const scan = await this._scanFeeders();
    const [plant, modules, feeders] = await Promise.all([
      this._plantState(),
      this._moduleStates(),
      this._feederState(scan),
    ]);
    const monGwUp = await tcpProbe(this.host, this.monGw.port);
    return {
      enabled: true,
      root: this.root,
      qBin: this.qExe,
      dataDir: this.dataDir,
      busy: this._current
        ? { action: this._current.action, target: this._current.target, startedAt: this._current.startedAt, steps: this._current.steps }
        : null,
      plant,
      monGw: {
        name: this.monGw.name,
        port: this.monGw.port,
        up: monGwUp,
        pid: this._monGwProc && alive(this._monGwProc.pid) ? this._monGwProc.pid : null,
      },
      modules,
      feeders,
      history: this._history,
    };
  }

  // ---- operations (all return {started:true} or {started:false,reason}) --

  _launch(action, target, fn) {
    let op;
    try { op = this._begin(action, target); } catch (e) { return { started: false, reason: e.message }; }
    Promise.resolve()
      .then(() => fn(op))
      .then((res) => this._finish(op, { ok: res !== false, ...(typeof res === "object" ? res : {}) }))
      .catch((e) => this._finish(op, { ok: false, output: (e && e.stack) || String(e) }));
    return { started: true, action, target };
  }

  plant(actionRaw) {
    const action = String(actionRaw || "");
    if (action !== "start" && action !== "stop") return { started: false, reason: "action must be start|stop" };
    return this._launch(`plant:${action}`, "plant", async (op) => {
      if (action === "stop") return this._script(op, "plant-stop", "shutdown.sh");
      const env = { WITH_CEP: this.withCep ? "1" : "0", WITH_IDB: this.withIdb ? "1" : "0" };
      const r = await this._script(op, "plant-start", "startup.sh", [], env);
      return { exitCode: r.code, output: r.output, ok: r.code === 0 };
    });
  }

  module(nameRaw, actionRaw) {
    const name = String(nameRaw || "");
    const action = String(actionRaw || "");
    if (!MODULE_RE.test(name) || !this.modules.includes(name)) {
      return { started: false, reason: `unknown module: ${name} (have: ${this.modules.join(", ")})` };
    }
    if (!["start", "stop", "restart"].includes(action)) {
      return { started: false, reason: "action must be start|stop|restart" };
    }
    return this._launch(`module:${action}`, name, async (op) => {
      let out = "";
      let code = 0;
      if (action === "stop" || action === "restart") {
        const r = await this._script(op, `${name}-stop`, "shutdownAllByModule.sh", [name]);
        out += r.output;
        code = r.code;
      }
      if (action === "start" || action === "restart") {
        const r = await this._script(op, `${name}-start`, "startupAllByModule.sh", [name]);
        out += r.output;
        code = r.code;
      }
      return { exitCode: code, output: out, ok: code === 0 };
    });
  }

  monGwOp(actionRaw) {
    const action = String(actionRaw || "");
    if (!["start", "stop", "restart"].includes(action)) {
      return { started: false, reason: "action must be start|stop|restart" };
    }
    return this._launch(`mongw:${action}`, this.monGw.name, async (op) => {
      if (action === "stop" || action === "restart") await this._stopMonGw(op);
      if (action === "start" || action === "restart") {
        if (action === "restart") await new Promise((r) => setTimeout(r, 1500));
        this._startMonGw(op);
      }
      return { ok: true };
    });
  }

  feeder(nameRaw, actionRaw) {
    const name = String(nameRaw || "");
    const action = String(actionRaw || "");
    if (!this.feeders.some((f) => f.name === name)) {
      return { started: false, reason: `unknown feeder: ${name} (have: ${this.feeders.map((f) => f.name).join(", ")})` };
    }
    if (!["start", "stop", "restart"].includes(action)) {
      return { started: false, reason: "action must be start|stop|restart" };
    }
    return this._launch(`feeder:${action}`, name, async (op) => {
      if (action === "stop" || action === "restart") await this._stopFeeder(op, name);
      if (action === "start" || action === "restart") {
        if (action === "restart") await new Promise((r) => setTimeout(r, 800));
        this._startFeeder(op, name);
      }
      return { ok: true };
    });
  }

  // EOD: run the module's standalone one-shot `eod` process
  // (cfg_proc/modules/<mod>/eod.json -> initFromCfg.q -procType eod), which
  // reads that module's checkpointed idb segments off disk and promotes
  // today's partition into its HDB, then exits. The module's cfg roots
  // (examples/data/<mod>/...) are the same ones its running writers use, so
  // no path mismatch. Best run with the module's own writers quiesced -
  // the confirm text on the button says so.
  eod(moduleRaw) {
    const name = String(moduleRaw || "");
    if (!MODULE_RE.test(name) || !this.modules.includes(name)) {
      return { started: false, reason: `unknown module: ${name} (have: ${this.modules.join(", ")})` };
    }
    const cfgPath = path.join(this.cfgDir, "modules", name, "eod.json");
    if (!fs.existsSync(cfgPath)) {
      return { started: false, reason: `${name} has no eod.json (nothing to promote)` };
    }
    return this._launch("eod", name, async (op) => {
      const r = await this._run(op, `eod-${name}`, this.qExe, ["initFromCfg.q", "-config", cfgPath], {}, this.core);
      op.steps.push({ step: `eod one-shot for ${name}`, ok: r.code === 0, exitCode: r.code });
      return { ok: r.code === 0, exitCode: r.code, output: r.output };
    });
  }

  // orchestrated: the "plant restart sequence" - plant, modules, mon_gw, feeders
  up() {
    return this._launch("bring-up-all", "everything", async (op) => {
      await this._run(op, "clean-pids", this.bash, ["-c", `rm -f "${this.logDir.replace(/\\/g, "/")}"/openq*.pids`], {});
      op.steps.push({ step: "clear stale pidfiles", ok: true });
      const p = await this._script(op, "plant-start", "startup.sh", [], {
        WITH_CEP: this.withCep ? "1" : "0", WITH_IDB: this.withIdb ? "1" : "0",
      });
      for (const m of this.modules) {
        await this._script(op, `module ${m}`, "startupAllByModule.sh", [m]);
      }
      await new Promise((r) => setTimeout(r, 3000));
      this._startMonGw(op);
      await new Promise((r) => setTimeout(r, 3000));
      for (const f of this.feeders) this._startFeeder(op, f.name);
      const bad = op.steps.filter((s) => s.ok === false);
      return { ok: bad.length === 0, exitCode: p.code, output: op.steps.map((s) => `${s.ok === false ? "FAIL" : "ok  "} ${s.step}`).join("\n") };
    });
  }

  down() {
    return this._launch("tear-down-all", "everything", async (op) => {
      for (const f of this.feeders) await this._stopFeeder(op, f.name);
      await this._stopMonGw(op);
      for (const m of [...this.modules].reverse()) {
        await this._script(op, `stop ${m}`, "shutdownAllByModule.sh", [m]);
      }
      await this._script(op, "plant-stop", "shutdown.sh");
      return { ok: true, output: op.steps.map((s) => `${s.ok === false ? "FAIL" : "ok  "} ${s.step}`).join("\n") };
    });
  }

  status() {
    return { enabled: true, busy: !!this._current, historyCount: this._history.length };
  }
}

module.exports = { ControlManager };
