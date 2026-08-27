// pidstat-feeder - a stand-in for modules/mon/pidstat_poller.py on Windows.
//
// The real poller needs Linux `pidstat` (sysstat), which isn't available on
// Windows. This reads the *actual* Windows process table (Get-CimInstance)
// for the running q.exe / node.exe processes, maps each to its openQ role
// from the command line, computes %CPU from CPU-time deltas, and publishes
// one real `pidstats` row per process into mon_tp as a q `upd[...]` string.
// The rows have stable (host,pid,sym) identity - unlike .gen.selfPublish's
// random rows - so the dashboard's Processes page can chart them.
//
//   node tools/pidstat-feeder.js [intervalSeconds]   (default 3)
//
// Env: MON_TP_HOST (127.0.0.1), MON_TP_PORT (5020). Stop with Ctrl-C.
// Windows-only (uses powershell / Get-CimInstance).

const { execFile } = require("child_process");
const os = require("os");
const { QConnection } = require("jkdb");

const INTERVAL = Math.max(1, Number(process.argv[2] || 3)) * 1000;
const TP = {
  host: process.env.MON_TP_HOST || "127.0.0.1",
  port: Number(process.env.MON_TP_PORT) || 5020,
};
const HOST = os.hostname().replace(/[^A-Za-z0-9_.]/g, "_");
const CORES = os.cpus().length;
const TOTAL_MEM = os.totalmem();

const PS = `Get-CimInstance Win32_Process -Filter "name='q.exe' or name='node.exe'" |
  Select-Object ProcessId,Name,CommandLine,WorkingSetSize,VirtualSize,ThreadCount,HandleCount,UserModeTime,KernelModeTime |
  ConvertTo-Json -Compress`;

function ps() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", PS],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        let j;
        try { j = JSON.parse(stdout); } catch (e) { return reject(e); }
        resolve(Array.isArray(j) ? j : [j]);
      }
    );
  });
}

// derive {name, procType, port} from a q/node command line
function classify(cmd) {
  cmd = cmd || "";
  const pt = /-procType\s+(\S+)/.exec(cmd);
  const nm = /-name\s+(\S+)/.exec(cmd);
  const po = /-port\s+(\d+)/.exec(cmd);
  if (pt) return { name: nm ? nm[1] : pt[1], procType: pt[1], port: po ? +po[1] : 0 };
  if (/initFromCfg\.q/.test(cmd)) {
    const cfg = /modules[\\/](\w+)[\\/](\w+)\.json/.exec(cmd);
    if (cfg) return { name: `${cfg[1]}_${cfg[2]}`, procType: cfg[2].replace(/\d.*$/, ""), port: 0 };
  }
  if (/\bindex\.js/.test(cmd)) return { name: "dashboard_gateway", procType: "gateway", port: 8899 };
  if (/\bmon-feed\.js/.test(cmd)) return { name: "pidstat_feeder", procType: "feeder", port: 0 };
  if (/vite/.test(cmd)) return { name: "dashboard_vite", procType: "webdev", port: 5173 };
  if (/-p\s+(\d+)/.test(cmd)) return { name: "q_" + RegExp.$1, procType: "q", port: +RegExp.$1 };
  if (/npm-cli\.js/.test(cmd)) return { name: "npm", procType: "webdev", port: 0 };
  return { name: "node_" + (/([\w.-]+\.js)/.exec(cmd) || [, "misc"])[1].replace(/\W/g, "_"), procType: "other", port: 0 };
}

const prev = new Map(); // pid -> { cpu100ns, t }

function qstr(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
function sym(s) {
  return String(s).replace(/[^A-Za-z0-9_.]/g, "_") || "unknown";
}
function qts(ms) {
  const d = new Date(ms), p = (x, w = 2) => String(x).padStart(w, "0");
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}D${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000`;
}

async function tick(q) {
  let procs;
  try { procs = await ps(); } catch (e) { console.error("ps failed:", e.message); return; }
  const now = Date.now();
  const rows = [];

  for (const p of procs) {
    const pid = p.ProcessId;
    // CIM times are 100-ns ticks; may arrive as number or {value}
    const um = Number(p.UserModeTime && p.UserModeTime.value != null ? p.UserModeTime.value : p.UserModeTime) || 0;
    const km = Number(p.KernelModeTime && p.KernelModeTime.value != null ? p.KernelModeTime.value : p.KernelModeTime) || 0;
    const cpu100ns = um + km;
    const pr = prev.get(pid);
    prev.set(pid, { cpu100ns, t: now, um, km });
    if (!pr) continue; // need a delta

    const dtSec = (now - pr.t) / 1000;
    if (dtSec <= 0) continue;
    const userPct = ((um - pr.um) / 1e7 / dtSec) * 100;
    const sysPct = ((km - pr.km) / 1e7 / dtSec) * 100;
    const cpuPct = userPct + sysPct;

    const rss = Number(p.WorkingSetSize) || 0;
    const vsz = Number(p.VirtualSize) || 0;
    const c = classify(p.CommandLine);

    rows.push({
      sym: sym(c.name), host: HOST, pid, uid: 0, procType: sym(c.procType), port: c.port,
      userPct, sysPct, cpuPct,
      vsz, rss, memPct: (rss / TOTAL_MEM) * 100,
      threads: Number(p.ThreadCount) || 0, fdnr: Number(p.HandleCount) || 0,
      command: (p.CommandLine || `${p.Name} ${pid}`).slice(0, 200),
    });
  }
  if (!rows.length) return;

  const n = rows.length;
  const tsv = Array(n).fill(qts(now)).join(" ");
  const col = (f) => rows.map(f).join(" ");
  const fcol = (f) => rows.map((r) => f(r).toFixed(3)).join(" ");
  const stmt =
    "upd[`pidstats;(" +
    `${tsv};` +                                   // timestamp
    "`" + rows.map((r) => r.sym).join("`") + ";" + // sym
    `${tsv};` +                                    // pidstatTime
    "`" + rows.map(() => HOST).join("`") + ";" +   // host
    col((r) => r.pid) + "i;" +                     // pid
    col(() => 0) + "i;" +                          // uid
    "`" + rows.map((r) => r.procType).join("`") + ";" + // procType
    col((r) => r.port) + "i;" +                    // port
    fcol((r) => r.userPct) + ";" +                 // userPct
    fcol((r) => r.sysPct) + ";" +                  // sysPct
    fcol(() => 0) + ";" +                          // guestPct
    fcol(() => 0) + ";" +                          // waitPct
    fcol((r) => r.cpuPct) + ";" +                  // cpuPct
    col(() => -1) + "i;" +                         // cpuId
    fcol(() => 0) + ";" +                          // minflt
    fcol(() => 0) + ";" +                          // majflt
    col((r) => r.vsz) + "j;" +                     // vsz
    col((r) => r.rss) + "j;" +                     // rss
    fcol((r) => r.memPct) + ";" +                  // memPct
    col((r) => r.threads) + "i;" +                 // threads
    col((r) => r.fdnr) + "i;" +                    // fdnr
    "(" + rows.map((r) => qstr(r.command)).join(";") + ")" + // command (general list)
    ")]";

  q.asyn(stmt, (err) => {
    if (err) console.error("publish error:", err.message);
    else console.log(new Date().toISOString(), `published ${n} pidstats rows`);
  });
}

const q = new QConnection(TP);
q.connect((e) => {
  if (e) { console.error("cannot reach mon_tp", TP, e.message); process.exit(1); }
  console.log(`feeding pidstats -> mon_tp:${TP.port} every ${INTERVAL / 1000}s  (host=${HOST}, cores=${CORES})`);
  tick(q);
  const id = setInterval(() => tick(q), INTERVAL);
  process.on("SIGINT", () => { clearInterval(id); q.close(() => process.exit(0)); });
});
