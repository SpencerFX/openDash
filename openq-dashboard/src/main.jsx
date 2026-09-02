import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, Archive, ArrowDown, ArrowUp, BarChart3, Bell, BookText, Boxes, CandlestickChart, Check,
  ChevronRight, CircleDollarSign, Cpu, Database, FastForward, Gauge, HardDrive, KeyRound, LayoutDashboard,
  Library, ListChecks, ListFilter, Lock, MemoryStick, Network, Pause, Play, Power, RefreshCw, Rocket,
  Radar, RotateCw, ScrollText, Search, Settings, ShieldCheck, Square, Trash2, TrendingDown, TrendingUp,
  Unlock, Wifi, X, Zap
} from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, ZAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer, CartesianGrid, AreaChart, Area, ScatterChart, Scatter, Cell } from "recharts";
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType, CrosshairMode } from "lightweight-charts";
import "./index.css";

// Base URL of the openq-dashboard-gateway (see ../gateway). Falls back to the
// dev default; override with VITE_GATEWAY_URL in .env.
const GW = import.meta.env.VITE_GATEWAY_URL || "http://localhost:8899";

const baseOrders = [
  { id:"OQ-10482", sym:"EURUSD", side:"BUY", qty:"10.0m", filled:"7.6m", algo:"TWAP", status:"Working", bps:"+0.7" },
  { id:"OQ-10491", sym:"USDJPY", side:"SELL", qty:"8.0m", filled:"8.0m", algo:"VWAP", status:"Complete", bps:"-0.3" },
  { id:"OQ-10502", sym:"GBPUSD", side:"BUY", qty:"5.0m", filled:"2.4m", algo:"POV", status:"Working", bps:"+1.1" },
  { id:"OQ-10517", sym:"EURGBP", side:"SELL", qty:"3.0m", filled:"1.8m", algo:"LIQ", status:"Working", bps:"+0.2" },
  { id:"OQ-10526", sym:"USDCHF", side:"BUY", qty:"6.0m", filled:"6.0m", algo:"TWAP", status:"Complete", bps:"-0.6" }
];

const chart = Array.from({length: 24}, (_,i) => ({
  t:`${String(9+Math.floor(i/4)).padStart(2,"0")}:${String((i%4)*15).padStart(2,"0")}`,
  pnl: 1200 + i*185 + Math.sin(i/2)*450,
  impact: 0.2 + Math.sin(i/3)*0.35 + i/80
}));

// standalone entries + collapsible groups (ribbon-style: one group open at a time)
const NAV = [
  { kind: "item", name: "Overview", icon: LayoutDashboard },
  { kind: "group", name: "eFX", icon: Activity, children: [
      ["Charts", CandlestickChart], ["Market Impact", BarChart3], ["Markout", TrendingUp], ["Spreads", TrendingDown] ] },
  { kind: "group", name: "EQ", icon: CircleDollarSign, children: [
      ["EQ Charts", CandlestickChart], ["Desk Risk", ShieldCheck], ["Prime Finance", CircleDollarSign],
      ["Fee Calibration", Gauge], ["Position Risk", Archive], ["Crowding", Boxes] ] },
  { kind: "group", name: "Data", icon: Library, children: [
      ["Catalog", BookText], ["Explorer", Search] ] },
  { kind: "group", name: "SystemAdmin", icon: Settings, children: [
      ["Control", Power], ["Launcher", Rocket], ["Tests", ListChecks] ] },
  { kind: "group", name: "SystemMon", icon: Gauge, children: [
      ["HDB Health", HardDrive], ["Logs", ScrollText], ["Modules", Network], ["Process Mon", Activity], ["Resources", Cpu], ["Query Mon", Radar], ["Tables", Database] ] },
];

function NavLeaf({name,Icon,active,onClick,sub}) {
  return <button onClick={onClick}
    className={`flex w-full items-center gap-3 rounded px-3 ${sub?"py-2 text-xs":"py-2.5 text-sm"} ${
      active ? "bg-slate-800 text-cyan-300" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}>
    <Icon size={sub?14:16}/>{name}
  </button>;
}

function Nav({active,setActive}) {
  const groupOf = (nm) => NAV.find(n => n.kind === "group" && n.children.some(([c]) => c === nm));
  // collapsed by default; only auto-open the group that holds the active page
  const [open,setOpen] = useState(() => (groupOf(active) || {}).name || null);
  const toggle = (nm) => setOpen(o => o === nm ? null : nm);

  return <aside className="w-60 shrink-0 border-r border-slate-800 bg-[#08121a] p-4">
    <div className="mb-7 flex items-center gap-2 px-2">
      <div className="grid h-8 w-8 place-items-center rounded bg-cyan-400 text-black font-black">q</div>
      <div><div className="font-bold tracking-wide">openQ</div><div className="text-[10px] text-slate-500">TRADING PLATFORM</div></div>
    </div>
    <div className="space-y-1">
      {NAV.map(n => n.kind === "item"
        ? <NavLeaf key={n.name} name={n.name} Icon={n.icon} active={active===n.name} onClick={()=>setActive(n.name)}/>
        : <div key={n.name}>
            <button onClick={()=>toggle(n.name)}
              className={`flex w-full items-center gap-3 rounded px-3 py-2.5 text-sm ${
                n.children.some(([c])=>c===active) ? "text-cyan-300" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}>
              <n.icon size={16}/>
              <span className="flex-1 text-left font-medium tracking-wide">{n.name}</span>
              <ChevronRight size={14} className={`transition-transform ${open===n.name ? "rotate-90" : ""}`}/>
            </button>
            {open===n.name && <div className="mb-1 mt-0.5 space-y-0.5 border-l border-slate-800 pl-2">
              {n.children.map(([nm,Icon]) =>
                <NavLeaf key={nm} name={nm} Icon={Icon} sub active={active===nm} onClick={()=>setActive(nm)}/>)}
            </div>}
          </div>
      )}
    </div>
    <div className="mt-8 border-t border-slate-800 pt-4 text-xs text-slate-500">
      <div className="mb-2 flex items-center gap-2"><Database size={14}/> kdb+ gateway</div>
      <div className="flex items-center gap-2 text-emerald-400"><Wifi size={13}/> Live connection</div>
    </div>
  </aside>
}

// Shows on the eFX analytics pages while a paced tp-log replay is feeding
// that page's module CEP (see openQ/modules/replay/replay.q + the Control
// page's Replay panel). Polls /api/replay; renders nothing when idle.
function ReplayChip({ active }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let on = true;
    const load = () => fetch(new URL("/api/replay", GW), { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!on) return;
        const t = j && (j.targets || []).find(x =>
          (x.pages || []).includes(active) && x.running && x.status && x.status.playing);
        setInfo(t ? { speed: t.status.speed, simClock: t.status.simClock, module: t.module } : null);
      })
      .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => { on = false; clearInterval(id); };
  }, [active]);
  if (!info) return null;
  const clk = info.simClock ? new Date(info.simClock).toLocaleTimeString() : "";
  return <span
    title={`replaying captured ${info.module} tp-log at ${info.speed}× (sim clock ${clk}) - data on this page is a paced replay, not live`}
    className="flex items-center gap-1.5 rounded bg-fuchsia-950 px-2 py-0.5 text-xs font-semibold text-fuchsia-300">
    <FastForward size={11}/> REPLAY {info.speed}×{clk ? ` · ${clk}` : ""}
  </span>;
}

function Header({active}) {
  return <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-[#09141d] px-6">
    <div className="flex items-center gap-3">
      <div><div className="text-lg font-semibold">{active}</div><div className="text-xs text-slate-500">Friday, 28 Aug 2026 · Asia/Tokyo</div></div>
      <ReplayChip active={active}/>
    </div>
    <div className="flex items-center gap-3">
      <div className="hidden rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-400 md:flex"><Search size={13} className="mr-2"/> Search</div>
      <button className="rounded border border-slate-800 p-2 text-slate-400"><Bell size={16}/></button>
      <div className="flex items-center gap-2 rounded border border-slate-800 px-3 py-2 text-xs"><span className="h-2 w-2 rounded-full bg-emerald-400"/> LIVE</div>
    </div>
  </header>
}

function Metric({label,value,delta,icon:Icon}) {
  return <div className="metric"><div className="flex justify-between text-xs text-slate-500"><span>{label}</span><Icon size={14}/></div><div className="mt-2 text-2xl font-semibold">{value}</div><div className={`mt-1 text-xs ${delta?.startsWith("-")?"text-emerald-400":"text-cyan-300"}`}>{delta}</div></div>
}

function Overview({orders}) {
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Orders" value="1,284" delta="+84 today" icon={ListFilter}/>
      <Metric label="Executed" value="842" delta="65.6% fill rate" icon={Activity}/>
      <Metric label="Execution VWAP" value="+1.82 bps" delta="vs arrival" icon={TrendingUp}/>
      <Metric label="Net P&L" value="$184.6k" delta="+4.8% today" icon={CircleDollarSign}/>
    </div>
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <section className="panel p-4">
        <div className="mb-4 flex justify-between"><div><div className="font-semibold">Intraday Performance</div><div className="text-xs text-slate-500">Aggregated execution P&L</div></div><span className="badge bg-slate-800 text-slate-400">24H</span></div>
        <div className="h-72"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chart}><defs><linearGradient id="pnl" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity=".35"/><stop offset="100%" stopColor="#22d3ee" stopOpacity="0"/></linearGradient></defs><CartesianGrid stroke="#1e2b36" vertical={false}/><XAxis dataKey="t" stroke="#566673" fontSize={10}/><YAxis stroke="#566673" fontSize={10}/><Tooltip contentStyle={{background:"#0b151e",border:"1px solid #263746"}}/><Area type="monotone" dataKey="pnl" stroke="#22d3ee" fill="url(#pnl)" strokeWidth={2}/></AreaChart></ResponsiveContainer></div>
      </section>
      <section className="panel p-4">
        <div className="mb-4 font-semibold">Algo Utilisation</div>
        {[
          ["TWAP","72%",72],["VWAP","41%",41],["POV","89%",89],["Liquidity Seeking","56%",56]
        ].map(([n,v,p])=><div key={n} className="mb-5"><div className="mb-1 flex justify-between text-xs"><span>{n}</span><span className="text-slate-500">{v}</span></div><div className="h-1.5 rounded bg-slate-800"><div className="h-full rounded bg-cyan-400" style={{width:`${p}%`}}/></div></div>)}
      </section>
    </div>
    <Orders orders={orders}/>
  </div>
}

function Orders({orders}) {
  return <section className="panel overflow-hidden">
    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3"><div className="font-semibold">Active Orders</div><button className="text-xs text-cyan-300">View all <ChevronRight size={12} className="inline"/></button></div>
    <div className="overflow-auto"><table className="w-full text-left text-xs"><thead className="bg-[#0a121a] text-slate-500"><tr>{["Order","Symbol","Side","Qty","Filled","Algo","Status","Slippage"].map(x=><th className="px-4 py-3 font-medium" key={x}>{x}</th>)}</tr></thead><tbody>{orders.map(o=><tr key={o.id} className="border-t border-slate-800 hover:bg-slate-900"><td className="px-4 py-3 font-mono text-cyan-300">{o.id}</td><td className="px-4 py-3 font-semibold">{o.sym}</td><td className={`px-4 py-3 font-semibold ${o.side==="BUY"?"text-emerald-400":"text-rose-400"}`}>{o.side}</td><td className="px-4 py-3">{o.qty}</td><td className="px-4 py-3">{o.filled}</td><td className="px-4 py-3">{o.algo}</td><td className="px-4 py-3"><span className={`badge ${o.status==="Working"?"bg-cyan-950 text-cyan-300":"bg-emerald-950 text-emerald-300"}`}>{o.status}</span></td><td className="px-4 py-3">{o.bps}</td></tr>)}</tbody></table></div>
  </section>
}

// ---- System > Tests (openQ acceptance suite results) ---------------
const TEST_STATUS = {
  pass:  { badge: "bg-emerald-950 text-emerald-300", dot: "#34d399" },
  fail:  { badge: "bg-rose-950 text-rose-300",       dot: "#f43f5e" },
  error: { badge: "bg-amber-950 text-amber-300",     dot: "#f59e0b" },
};
function agoStr(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s) || s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s/60)}m ago`;
  if (s < 86400) return `${Math.round(s/3600)}h ago`;
  return `${Math.round(s/86400)}d ago`;
}

function Tests() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [open,setOpen] = useState(null);
  const [busy,setBusy] = useState(false);
  const [updated,setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/tests", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const runAll = () => {
    if (!window.confirm("Run the full openQ acceptance suite?\n\nEach suite stops q processes as it runs — this WILL tear down the running platform for a few minutes.")) return;
    setBusy(true);
    fetch(new URL("/api/tests/run", GW), { method: "POST" })
      .then(r => r.json()).then(() => setTimeout(load, 1500))
      .catch(e => setErr(e.message))
      .finally(() => setTimeout(() => setBusy(false), 3000));
  };

  const t = data?.totals || {};
  const suites = data?.suites || [];
  const running = data?.running || busy;
  const greenPct = t.suites ? (t.green / t.suites) * 100 : 0;

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">openQ acceptance suite · <span className="text-slate-500">tests/sh/run_*_test.sh</span></span>
      <button onClick={runAll} disabled={running}
        className={`flex items-center gap-1.5 rounded px-3 py-1.5 font-semibold ${running ? "bg-slate-800 text-slate-500" : "bg-cyan-400 text-slate-950 hover:bg-cyan-300"}`}>
        <Play size={13}/> {running ? "running…" : "Run all"}
      </button>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {running && <span className="flex items-center gap-1.5 text-amber-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-400"/> run in progress</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/tests — {err}</div>}

    {data && !data.present ? (
      <div className="panel p-8 text-center text-sm text-slate-500">
        No test run recorded yet.<br/>
        <span className="text-xs text-slate-600">Click <span className="text-slate-400">Run all</span> above, or run <span className="font-mono">bash openQ/tests/sh/run_all.sh</span>.</span>
      </div>
    ) : data && (
      <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Metric label="Suites passing" value={`${t.green ?? 0}/${t.suites ?? 0}`} delta={t.red ? `${t.red} not green` : "all green"} icon={ListChecks}/>
          <Metric label="Checks passed" value={String(t.pass ?? 0)} delta={`${t.fail ?? 0} failed`} icon={ShieldCheck}/>
          <Metric label="Last run" value={data.finishedAt ? agoStr(data.finishedAt) : running ? "in progress" : "—"} delta={data.finishedAt ? new Date(data.finishedAt).toLocaleString() : ""} icon={RefreshCw}/>
          <Metric label="Duration" value={suites.length ? `${suites.reduce((a,s)=>a+(s.durationSec||0),0)}s` : "—"} delta={`${suites.length} suites`} icon={Activity}/>
        </div>

        <div className="h-2 w-full overflow-hidden rounded bg-rose-950">
          <div className="h-full bg-emerald-500" style={{ width: `${greenPct}%` }}/>
        </div>

        <section className="panel divide-y divide-slate-800">
          {suites.map(s => {
            const st = TEST_STATUS[s.status] || TEST_STATUS.error;
            const isOpen = open === s.name;
            return <div key={s.name}>
              <button onClick={()=>setOpen(isOpen?null:s.name)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-900/50">
                <ChevronRight size={14} className={`shrink-0 text-slate-500 transition-transform ${isOpen ? "rotate-90" : ""}`}/>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: st.dot }}/>
                <span className="flex-1 font-mono font-semibold text-slate-200">{s.name}</span>
                <span className={`badge ${st.badge}`}>{s.status}</span>
                <span className="tabular-nums text-xs text-slate-500">{s.pass}✓ {s.fail ? <span className="text-rose-400">{s.fail}✗</span> : "0✗"}</span>
                <span className="w-10 text-right text-xs text-slate-600">{s.durationSec != null ? `${s.durationSec}s` : ""}</span>
              </button>
              {isOpen && <div className="space-y-3 border-t border-slate-800 bg-[#0a121a] px-4 py-3 text-xs">
                {s.errored && <div className="text-amber-400">suite exited {s.exitCode} without emitting checks — see output</div>}
                {s.checks.length > 0 && <div className="space-y-0.5 font-mono">
                  {s.checks.map((c,i) => <div key={i} className="flex gap-2">
                    <span className={c.ok ? "text-emerald-400" : "text-rose-400"}>{c.ok ? "PASS" : "FAIL"}</span>
                    <span className="text-slate-400">{c.name}</span>
                  </div>)}
                </div>}
                <div>
                  <div className="mb-1 text-slate-500">output tail</div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-slate-400">{s.tail}</pre>
                </div>
              </div>}
            </div>;
          })}
          {!suites.length && <div className="px-4 py-6 text-center text-slate-600">no suites in the last run</div>}
        </section>
      </>
    )}
  </div>;
}

// ---- System > Control (start / stop the platform) ----------------
const CTL_TOKEN_KEY = "openq.control.token";

function Dot({ up }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: up ? "#34d399" : "#64748b" }}/>;
}
function msAgo(ms) {
  if (ms == null || !isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function CtlBtn({ onClick, disabled, kind = "ghost", icon: Icon, children }) {
  const styles = {
    ghost: "border border-slate-700 text-slate-300 hover:bg-slate-800",
    go:    "bg-emerald-500 text-slate-950 hover:bg-emerald-400",
    stop:  "bg-rose-500 text-white hover:bg-rose-400",
    warn:  "bg-amber-500 text-slate-950 hover:bg-amber-400",
  };
  return <button onClick={onClick} disabled={disabled}
    className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold disabled:opacity-40 disabled:pointer-events-none ${styles[kind]}`}>
    {Icon && <Icon size={12}/>}{children}
  </button>;
}

function Control() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem(CTL_TOKEN_KEY) || ""; } catch { return ""; } });
  const [tokInput, setTokInput] = useState("");
  const [pending, setPending] = useState(null);
  const [openRun, setOpenRun] = useState(null);
  const [rp, setRp] = useState(null);
  const [rpSpeed, setRpSpeed] = useState(10);

  const load = useCallback(() => {
    fetch(new URL("/api/control", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); })
      .catch(e => setErr(e.message));
  }, []);
  const loadRp = useCallback(() => {
    fetch(new URL("/api/replay", GW), { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null)).then(j => j && setRp(j)).catch(() => {});
  }, []);
  useEffect(() => { load(); loadRp(); }, [load, loadRp]);
  useEffect(() => { const id = setInterval(loadRp, 3000); return () => clearInterval(id); }, [loadRp]);
  useEffect(() => {
    const fast = !!(data && data.busy) || !!pending;
    const id = setInterval(load, fast ? 1500 : 4000);
    return () => clearInterval(id);
  }, [load, data, pending]);
  useEffect(() => {
    if (pending && data && !data.busy) { const t = setTimeout(() => setPending(null), 1200); return () => clearTimeout(t); }
  }, [pending, data]);

  const saveToken = (v) => { try { v ? sessionStorage.setItem(CTL_TOKEN_KEY, v) : sessionStorage.removeItem(CTL_TOKEN_KEY); } catch { /* ignore */ } setToken(v); };
  const readOnly = !data || data.readOnly || !data.enabled;
  const unlocked = !!token && !readOnly;
  const busy = !!(data && data.busy) || !!pending;

  const act = (label, path, body, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setPending(label); setErr(null);
    fetch(new URL(path, GW), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
    })
      .then(r => r.json().then(j => ({ ok: r.ok || r.status === 202, j })))
      .then(({ ok, j }) => { if (!ok || j.started === false) throw new Error(j.reason || j.error || "rejected"); setTimeout(load, 400); })
      .catch(e => { setErr(e.message); setPending(null); });
  };

  const rpAct = (path, body, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setErr(null);
    fetch(new URL(path, GW), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
    })
      .then(r => r.json().then(j => ({ ok: r.ok || r.status === 202, j })))
      .then(({ ok, j }) => { if (!ok || j.started === false) throw new Error(j.reason || j.error || "rejected"); setTimeout(loadRp, 400); })
      .catch(e => setErr(e.message));
  };

  const b = data || {};
  const plant = b.plant || {};
  const mods = b.modules || [];
  const feeds = b.feeders || [];
  const hist = b.history || [];

  return <div className="space-y-4">
    {/* auth bar */}
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <Power size={14} className="text-slate-500"/>
      <span className="text-slate-400">Platform control</span>
      {data && !data.enabled && <span className="badge bg-rose-950 text-rose-300">disabled on gateway</span>}
      {data && data.enabled && data.readOnly && <span className="badge bg-amber-950 text-amber-300">read-only</span>}
      {unlocked && <span className="badge bg-emerald-950 text-emerald-300">unlocked</span>}
      <span className="ml-auto flex items-center gap-2">
        {data && data.readOnly && data.enabled && (
          <span className="text-slate-500">set <span className="font-mono text-slate-400">OPENQ_CONTROL_TOKEN</span> in the gateway .env to enable actions</span>
        )}
        {data && !data.readOnly && !token && (
          <>
            <input type="password" value={tokInput} onChange={e => setTokInput(e.target.value)} placeholder="control token"
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 outline-none focus:border-cyan-500"/>
            <CtlBtn kind="go" icon={Unlock} onClick={() => { saveToken(tokInput.trim()); setTokInput(""); }}>Unlock</CtlBtn>
          </>
        )}
        {token && !readOnly && <CtlBtn icon={Lock} onClick={() => saveToken("")}>Lock</CtlBtn>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{err}</div>}

    {busy && (
      <section className="panel border border-amber-900/60 p-3 text-xs">
        <div className="flex items-center gap-2 text-amber-300">
          <span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-400"/>
          <span className="font-semibold">{b.busy ? `${b.busy.action} · ${b.busy.target}` : pending}</span>
          {b.busy && <span className="text-slate-500">started {agoStr(b.busy.startedAt)}</span>}
        </div>
        {b.busy && b.busy.steps && b.busy.steps.length > 0 && (
          <div className="mt-2 space-y-0.5 font-mono text-[11px] text-slate-400">
            {b.busy.steps.map((s, i) => <div key={i}>{s.ok === false ? "✗" : "✓"} {s.step}{s.note ? ` — ${s.note}` : ""}</div>)}
          </div>
        )}
      </section>
    )}

    {/* orchestrated */}
    <section className="panel flex flex-wrap items-center gap-3 p-3">
      <div className="text-sm font-semibold">Whole platform</div>
      <div className="ml-auto flex gap-2">
        <CtlBtn kind="go" icon={Play} disabled={!unlocked || busy}
          onClick={() => act("bring-up-all", "/api/control/up", {}, "Bring up the ENTIRE platform — core plant, all modules, mon_gw and every feeder? This takes ~2 minutes.")}>
          Bring up everything
        </CtlBtn>
        <CtlBtn kind="stop" icon={Power} disabled={!unlocked || busy}
          onClick={() => act("tear-down-all", "/api/control/down", {}, "Tear down the ENTIRE platform — every feeder, mon_gw, all modules and the core plant? Every dashboard will go dark.")}>
          Tear down everything
        </CtlBtn>
      </div>
    </section>

    {/* plant + mon_gw */}
    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold">Core plant</div>
        <span className="text-xs text-slate-500 font-mono">{b.dataDir}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Dot up={plant.up}/>
        <span className="font-semibold">{plant.up ? "running" : "stopped"}</span>
        <span className="text-xs text-slate-500">{plant.upCount ?? 0}/{plant.total ?? 0} roles</span>
        <span className="flex flex-wrap gap-1 font-mono text-[11px] text-slate-500">
          {(plant.procs || []).map(p => <span key={p.role} className={p.up ? "text-emerald-400" : "text-slate-600"}>{p.role}{p.port ? `:${p.port}` : ""}</span>)}
        </span>
        <span className="ml-auto flex gap-2">
          <CtlBtn kind="go" icon={Play} disabled={!unlocked || busy || plant.up}
            onClick={() => act("plant:start", "/api/control/plant", { action: "start" }, "Start the core plant (tp/rdb/hdb/gw)?")}>Start</CtlBtn>
          <CtlBtn kind="stop" icon={Square} disabled={!unlocked || busy || !plant.up}
            onClick={() => act("plant:stop", "/api/control/plant", { action: "stop" }, "Stop the core plant (tp/rdb/hdb/gw)? Every dashboard on the main gateway goes dark until it's restarted.")}>Stop</CtlBtn>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3 text-sm">
        <Dot up={b.monGw && b.monGw.up}/>
        <span className="font-semibold">{(b.monGw && b.monGw.name) || "mon_gw"}</span>
        <span className="text-xs text-slate-500">port {b.monGw && b.monGw.port} · the mon-module query gateway</span>
        <span className="ml-auto flex gap-2">
          <CtlBtn kind="ghost" icon={RotateCw} disabled={!unlocked || busy}
            onClick={() => act("mongw:restart", "/api/control/mongw", { action: "restart" }, "Restart mon_gw?")}>Restart</CtlBtn>
          <CtlBtn kind="go" icon={Play} disabled={!unlocked || busy || (b.monGw && b.monGw.up)}
            onClick={() => act("mongw:start", "/api/control/mongw", { action: "start" })}>Start</CtlBtn>
          <CtlBtn kind="stop" icon={Square} disabled={!unlocked || busy || !(b.monGw && b.monGw.up)}
            onClick={() => act("mongw:stop", "/api/control/mongw", { action: "stop" }, "Stop mon_gw? The Resources page loses its data source.")}>Stop</CtlBtn>
        </span>
      </div>
    </section>

    {/* modules */}
    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">Modules</div>
      <table className="w-full text-left text-sm">
        <thead className="bg-[#0a121a] text-xs text-slate-500">
          <tr>{["Module", "Status", "Roles", "Actions"].map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {mods.map(m => <tr key={m.name} className="border-t border-slate-800">
            <td className="px-4 py-2 font-mono font-semibold text-slate-200">{m.name}</td>
            <td className="px-4 py-2"><span className="flex items-center gap-2"><Dot up={m.up}/>{m.up ? "up" : "down"}</span></td>
            <td className="px-4 py-2 text-xs text-slate-500 tabular-nums">{m.procCount}/{m.total}</td>
            <td className="px-4 py-2">
              <span className="flex flex-wrap gap-2">
                <CtlBtn kind="ghost" icon={RotateCw} disabled={!unlocked || busy}
                  onClick={() => act(`module:restart:${m.name}`, "/api/control/module", { name: m.name, action: "restart" }, `Restart the ${m.name} module? Its dashboards will be empty for ~30–60s.`)}>Restart</CtlBtn>
                <CtlBtn kind="go" icon={Play} disabled={!unlocked || busy || m.up}
                  onClick={() => act(`module:start:${m.name}`, "/api/control/module", { name: m.name, action: "start" })}>Start</CtlBtn>
                <CtlBtn kind="stop" icon={Square} disabled={!unlocked || busy || !m.up}
                  onClick={() => act(`module:stop:${m.name}`, "/api/control/module", { name: m.name, action: "stop" }, `Stop the ${m.name} module?`)}>Stop</CtlBtn>
                <CtlBtn kind="warn" icon={Zap} disabled={!unlocked || busy || !m.up}
                  onClick={() => act(`eod:${m.name}`, "/api/control/eod", { module: m.name }, `Run EOD for ${m.name}? Promotes today's data into its HDB (one-shot — a second run for the same day errors). Live dashboards are unaffected.`)}>EOD</CtlBtn>
              </span>
            </td>
          </tr>)}
          {!mods.length && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-600">no modules configured</td></tr>}
        </tbody>
      </table>
    </section>

    {/* feeders */}
    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">Feeders <span className="ml-1 text-xs font-normal text-slate-500">synthetic data generators (Node)</span></div>
      <table className="w-full text-left text-sm">
        <thead className="bg-[#0a121a] text-xs text-slate-500">
          <tr>{["Feeder", "Status", "Last line", "Actions"].map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {feeds.map(f => <tr key={f.name} className="border-t border-slate-800 align-top">
            <td className="px-4 py-2 font-mono font-semibold text-slate-200">{f.name}</td>
            <td className="px-4 py-2">
              <span className="flex items-center gap-2"><Dot up={f.running}/>{f.running ? "running" : "stopped"}</span>
              {f.running && <span className="block text-[11px] text-slate-600">pid {f.pid} · {f.source}{f.logMtimeAgeMs != null ? ` · ${msAgo(f.logMtimeAgeMs)} since log` : ""}</span>}
            </td>
            <td className="px-4 py-2 max-w-[24rem]"><span className="block truncate font-mono text-[11px] text-slate-500" title={f.lastLine || ""}>{f.lastLine || "—"}</span></td>
            <td className="px-4 py-2">
              <span className="flex flex-wrap gap-2">
                <CtlBtn kind="ghost" icon={RotateCw} disabled={!unlocked || busy}
                  onClick={() => act(`feeder:restart:${f.name}`, "/api/control/feeder", { name: f.name, action: "restart" }, `Restart the ${f.name} feeder?`)}>Restart</CtlBtn>
                <CtlBtn kind="go" icon={Play} disabled={!unlocked || busy || f.running}
                  onClick={() => act(`feeder:start:${f.name}`, "/api/control/feeder", { name: f.name, action: "start" })}>Start</CtlBtn>
                <CtlBtn kind="stop" icon={Square} disabled={!unlocked || busy || !f.running}
                  onClick={() => act(`feeder:stop:${f.name}`, "/api/control/feeder", { name: f.name, action: "stop" }, `Stop the ${f.name} feeder?`)}>Stop</CtlBtn>
              </span>
            </td>
          </tr>)}
          {!feeds.length && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-600">no feeders configured</td></tr>}
        </tbody>
      </table>
    </section>

    {/* replay */}
    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">
        Replay <span className="ml-1 text-xs font-normal text-slate-500">paced tp-log replay into a module CEP — real captured data, wall-clock paced</span>
      </div>
      {rp && !rp.enabled && <div className="px-4 py-4 text-xs text-slate-500">replay disabled on the gateway (<span className="font-mono">OPENQ_REPLAY_ENABLED=0</span>)</div>}
      <div className="divide-y divide-slate-800">
        {(rp?.targets || []).map(t => {
          const st = t.status || {};
          const pct = Math.round((st.pct || 0) * 100);
          const sim = st.simClock ? new Date(st.simClock).toLocaleTimeString() : "—";
          const fdr = feeds.find(f => f.name === t.feeder);
          return <div key={t.module} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <Dot up={t.running && st.playing}/>
              <span className="font-mono font-semibold text-slate-200">{t.module}</span>
              <span className="text-xs text-slate-500">
                {t.running ? (st.playing ? `playing @ ${st.speed}×` : "paused") : "stopped"}
                {t.running && st.loops > 0 ? ` · loop ${st.loops}` : ""}
              </span>
              {(t.pages || []).map(p => <span key={p} className="badge bg-slate-800 text-slate-400">{p}</span>)}
              <span className="ml-auto flex flex-wrap items-center gap-2">
                {!t.running && <>
                  <select value={rpSpeed} onChange={e => setRpSpeed(Number(e.target.value))}
                    className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-200">
                    {[1, 5, 10, 25, 50, 100].map(s => <option key={s} value={s}>{s}×</option>)}
                  </select>
                  <CtlBtn kind="go" icon={Play} disabled={!unlocked || busy}
                    onClick={() => rpAct("/api/replay/start", { module: t.module, speed: rpSpeed },
                      `Start ${t.module} replay at ${rpSpeed}×?\n\nRe-publishes real captured ticks into ${t.tp} and stops the ${t.feeder} feeder so they don't interleave.`)}>Start</CtlBtn>
                </>}
                {t.running && <>
                  {st.playing
                    ? <CtlBtn kind="ghost" icon={Pause} disabled={!unlocked} onClick={() => rpAct("/api/replay/command", { module: t.module, verb: "pause" })}>Pause</CtlBtn>
                    : <CtlBtn kind="go" icon={Play} disabled={!unlocked} onClick={() => rpAct("/api/replay/command", { module: t.module, verb: "resume" })}>Resume</CtlBtn>}
                  <span className="flex items-center gap-1">
                    {[10, 25, 50, 100].map(s => <button key={s} disabled={!unlocked}
                      onClick={() => rpAct("/api/replay/command", { module: t.module, verb: "speed", value: s })}
                      className={`rounded px-1.5 py-1 text-xs font-semibold disabled:opacity-40 ${Math.round(st.speed) === s ? "bg-cyan-500 text-slate-950" : "border border-slate-700 text-slate-300 hover:bg-slate-800"}`}>{s}×</button>)}
                  </span>
                  <CtlBtn kind="ghost" icon={RotateCw} disabled={!unlocked} onClick={() => rpAct("/api/replay/command", { module: t.module, verb: "restart" })}>Restart</CtlBtn>
                  <CtlBtn kind="stop" icon={Square} disabled={!unlocked}
                    onClick={() => rpAct("/api/replay/stop", { module: t.module }, `Stop ${t.module} replay? Restart the ${t.feeder} feeder from the Feeders panel for live synthetic data again.`)}>Stop</CtlBtn>
                </>}
              </span>
            </div>
            {t.running && <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
              <div className="h-1.5 min-w-[8rem] flex-1 overflow-hidden rounded bg-slate-800">
                <div className="h-full rounded bg-fuchsia-500" style={{ width: `${pct}%` }}/>
              </div>
              <span className="tabular-nums">{pct}%</span>
              <span className="tabular-nums">sim {sim}</span>
              <span className="tabular-nums">{Number(st.sent || 0).toLocaleString()} rows</span>
              <span className="font-mono">{Array.isArray(st.tables) ? st.tables.join(",") : ""}</span>
            </div>}
            {!t.running && fdr && fdr.running &&
              <div className="mt-1.5 text-[11px] text-amber-400/80">the {t.feeder} feeder is running — starting replay will stop it</div>}
            <div className="mt-1 font-mono text-[10px] text-slate-600">{t.src} → {t.tp}</div>
          </div>;
        })}
        {rp && rp.enabled && !(rp.targets || []).length && <div className="px-4 py-4 text-xs text-slate-600">no replay targets configured</div>}
      </div>
    </section>

    {/* history */}
    <section className="panel divide-y divide-slate-800">
      <div className="px-4 py-3 font-semibold">Activity <span className="ml-1 text-xs font-normal text-slate-500">last {hist.length}</span></div>
      {hist.map((h, i) => {
        const isOpen = openRun === i;
        return <div key={i}>
          <button onClick={() => setOpenRun(isOpen ? null : i)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs hover:bg-slate-900/50">
            <ChevronRight size={13} className={`shrink-0 text-slate-500 transition-transform ${isOpen ? "rotate-90" : ""}`}/>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: h.ok ? "#34d399" : "#f43f5e" }}/>
            <span className="flex-1 font-mono text-slate-300">{h.action} · {h.target}</span>
            {h.exitCode != null && <span className="text-slate-600">exit {h.exitCode}</span>}
            <span className="text-slate-600">{agoStr(h.finishedAt)}</span>
          </button>
          {isOpen && <div className="space-y-2 border-t border-slate-800 bg-[#0a121a] px-4 py-3 text-[11px]">
            {h.steps && <div className="space-y-0.5 font-mono text-slate-400">
              {h.steps.map((s, j) => <div key={j}>{s.ok === false ? "✗" : "✓"} {s.step}{s.note ? ` — ${s.note}` : ""}{s.pid ? ` (pid ${s.pid})` : ""}</div>)}
            </div>}
            {h.output && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-black/30 p-2 font-mono text-[10px] text-slate-500">{h.output}</pre>}
          </div>}
        </div>;
      })}
      {!hist.length && <div className="px-4 py-6 text-center text-xs text-slate-600">no actions yet</div>}
    </section>
  </div>;
}

// ---- Data > Catalog (openQ schemas/catalog.json data dictionary) --
const CAT_TYPE_BADGE = {
  timestamp: "bg-sky-950 text-sky-300",
  date:      "bg-cyan-950 text-cyan-300",
  symbol:    "bg-violet-950 text-violet-300",
  float:     "bg-emerald-950 text-emerald-300",
  long:      "bg-amber-950 text-amber-300",
  int:       "bg-amber-950 text-amber-300",
  boolean:   "bg-rose-950 text-rose-300",
  string:    "bg-slate-800 text-slate-300",
  list:      "bg-slate-800 text-slate-300",
};

function Catalog() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);        // "<schema>::<name>"
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState({}); // group name -> true when collapsed
  const toggleGroup = (name) => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  const load = useCallback(() => {
    fetch(new URL("/api/catalog", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const keyOf = (t) => `${t.schema}::${t.name}`;
  const tables = data?.tables || [];
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? tables.filter(t =>
        t.name.toLowerCase().includes(needle) ||
        (t.group || "").toLowerCase().includes(needle) ||
        t.columns.some(c => c.name.toLowerCase().includes(needle) || c.desc.toLowerCase().includes(needle)))
    : tables;

  // ordered [{ name, tier, tables:[...] }] following catalog.json's `groups`
  const groups = useMemo(() => {
    const defs = data?.groups?.length
      ? data.groups
      : [...new Set(tables.map(t => t.group))].map(name => ({ name }));
    const byName = new Map();
    for (const t of shown) {
      if (!byName.has(t.group)) byName.set(t.group, []);
      byName.get(t.group).push(t);
    }
    const out = defs
      .filter(g => byName.has(g.name))
      .map(g => ({ name: g.name, tier: g.tier, tables: byName.get(g.name) }));
    // any group not declared in `groups` (shouldn't happen) appended at the end
    for (const [name, ts] of byName) if (!defs.some(g => g.name === name)) out.push({ name, tables: ts });
    return out;
  }, [shown, data]);

  const cur = tables.find(t => keyOf(t) === sel)
    || (shown.length === 1 ? shown[0] : null);

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <BookText size={14} className="text-slate-500"/>
      <span className="text-slate-400">data dictionary · <span className="font-mono text-slate-500">openQ/schemas/catalog.json</span></span>
      {data && <span className="badge bg-slate-800 text-slate-400">{data.counts.tables} tables · {data.counts.columns} columns · {data.counts.groups} groups</span>}
      <div className="ml-auto flex items-center gap-2">
        {data && groups.length > 0 && (() => {
          const allCollapsed = groups.every(g => collapsed[g.name]);
          return <button onClick={() => setCollapsed(allCollapsed ? {} : Object.fromEntries(groups.map(g => [g.name, true])))}
            className="rounded border border-slate-800 px-2 py-1 text-slate-400 hover:bg-slate-900">
            {allCollapsed ? "expand all" : "collapse all"}
          </button>;
        })()}
        <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> reload</button>
      </div>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/catalog — {err}</div>}

    {data && <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      {/* table list */}
      <section className="panel self-start overflow-hidden">
        <div className="border-b border-slate-800 p-2">
          <div className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-2">
            <Search size={12} className="text-slate-600"/>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter tables / columns"
              className="w-full bg-transparent py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600"/>
          </div>
        </div>
        <div className="max-h-[70vh] overflow-auto">
          {groups.map((g, gi) => {
            const firstOfTier = g.tier && !groups.slice(0, gi).some(x => x.tier === g.tier);
            const tierLabel = { hdb: "HDB", memory: "In-Memory", demo: "Demo" }[g.tier] || null;
            // a search keeps every matching group open regardless of collapse state
            const open = needle ? true : !collapsed[g.name];
            return <div key={g.name}>
              {firstOfTier && tierLabel && <div className="border-y border-slate-800 bg-slate-950 px-3 py-1 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">{tierLabel}</div>}
              <button onClick={() => toggleGroup(g.name)}
                className="flex w-full items-center gap-1.5 bg-[#0a121a] px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-widest text-slate-500 hover:text-slate-300">
                <ChevronRight size={11} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}/>
                <span className="flex-1">{g.name}</span>
                <span className="text-slate-600">{g.tables.length}</span>
              </button>
              {open && g.tables.map(t => {
                const on = cur && keyOf(cur) === keyOf(t);
                return <button key={keyOf(t)} onClick={() => setSel(keyOf(t))}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 pl-6 text-left text-xs ${on ? "bg-slate-800 text-cyan-300" : "text-slate-300 hover:bg-slate-900"}`}>
                  <Database size={12} className="shrink-0 text-slate-600"/>
                  <span className="flex-1 truncate font-mono">{t.name}</span>
                  <span className="shrink-0 text-[10px] text-slate-600">{t.columns.length}</span>
                </button>;
              })}
            </div>;
          })}
          {!shown.length && <div className="px-3 py-6 text-center text-xs text-slate-600">no matches</div>}
        </div>
      </section>

      {/* table detail */}
      <section className="panel p-4">
        {!cur ? (
          <div className="flex h-72 flex-col items-center justify-center gap-2 text-center text-slate-600">
            <BookText size={26} className="opacity-40"/>
            <div className="text-sm">Select a table</div>
            <div className="text-xs">its columns, types and descriptions show here</div>
          </div>
        ) : (() => {
          const keyset = new Set(cur.key || []);
          return <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-semibold text-slate-100">{cur.name}</span>
              <span className="badge bg-slate-800 text-slate-400">{cur.group}</span>
              <span className="badge bg-slate-800 text-slate-500 font-mono">{cur.schema}</span>
              <span className="text-xs text-slate-600">{cur.columns.length} columns</span>
              {(cur.key || []).length > 0 && <span className="flex items-center gap-1 text-[10px] text-slate-500">
                <KeyRound size={11}/> {cur.key.join(", ")}
              </span>}
            </div>
            {cur.desc && <p className="max-w-3xl text-xs leading-relaxed text-slate-400">{cur.desc}</p>}
            <div className="overflow-x-auto rounded border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#0a121a] text-slate-500">
                  <tr>{["Column", "Type", "Description"].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {cur.columns.map(c => <tr key={c.name} className="border-t border-slate-800 align-top">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-200">
                      <span className="flex items-center gap-1.5">
                        {keyset.has(c.name) && <KeyRound size={11} className="shrink-0 text-amber-400"/>}
                        {c.name}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`badge ${CAT_TYPE_BADGE[c.type] || "bg-slate-800 text-slate-400"}`}>{c.type || "?"}</span>
                      {c.kdb && <span className="ml-1.5 font-mono text-[10px] text-slate-600">`{c.kdb}$</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-400">{c.desc}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </div>;
        })()}
      </section>
    </div>}
  </div>;
}

// ---- Data > Explorer (ad-hoc guarded `select` via /api/explore) --------
const EXPLORER_DEFAULT = { source: "", table: "", columns: "", sym: "", start: "", end: "", order: "", dir: "asc", limit: 200 };

function exFmt(v) {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)) return v.replace("T", " ").replace("Z", "");
  return String(v);
}
function toCsv(cols, rows) {
  const cell = (v) => {
    const s = exFmt(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

function Explorer() {
  const [srcs, setSrcs] = useState([]);
  const [tblBySrc, setTblBySrc] = useState({});
  const [f, setF] = useState(() => {
    try { return { ...EXPLORER_DEFAULT, ...JSON.parse(localStorage.getItem("openq.explorer") || "{}") }; }
    catch { return { ...EXPLORER_DEFAULT }; }
  });
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState(() => {
    try { return JSON.parse(localStorage.getItem("openq.explorer.hist") || "[]"); } catch { return []; }
  });
  const set = (k, v) => setF((p) => { const n = { ...p, [k]: v }; try { localStorage.setItem("openq.explorer", JSON.stringify(n)); } catch {} return n; });

  useEffect(() => {
    fetch(new URL("/api/explore", GW)).then(r => r.json()).then(j => {
      const list = j.sources || [];
      setSrcs(list);
      setF(p => p.source || !list.length ? p : { ...p, source: list.find(s => s.endpoints.some(e => e.connected))?.name || list[0].name });
    }).catch(() => {});
    fetch(new URL("/api/tables", GW)).then(r => r.json()).then(j => {
      const m = {};
      for (const s of j.sources || []) m[s.name] = (s.tables || []).map(t => t.table);
      setTblBySrc(m);
    }).catch(() => {});
  }, []);

  const run = useCallback(() => {
    if (!f.source || !f.table) { setErr("pick a source and a table"); return; }
    setBusy(true); setErr(null);
    const u = new URL("/api/explore", GW);
    u.searchParams.set("source", f.source);
    u.searchParams.set("table", f.table.trim());
    if (f.columns.trim()) u.searchParams.set("columns", f.columns.trim());
    if (f.sym.trim()) u.searchParams.set("sym", f.sym.trim());
    if (f.start) u.searchParams.set("start", new Date(f.start).toISOString());
    if (f.end) u.searchParams.set("end", new Date(f.end).toISOString());
    if (f.order.trim()) { u.searchParams.set("order", f.order.trim()); u.searchParams.set("dir", f.dir); }
    u.searchParams.set("limit", String(Math.min(5000, Math.max(1, Number(f.limit) || 200))));
    fetch(u)
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => {
        setRes(j);
        setHist(h => {
          const label = `${f.source}·${f.table}${f.sym ? " ["+f.sym+"]" : ""}`;
          const next = [{ label, f: { ...f }, at: Date.now(), matched: j.matched }, ...h.filter(x => x.label !== label)].slice(0, 12);
          try { localStorage.setItem("openq.explorer.hist", JSON.stringify(next)); } catch {}
          return next;
        });
      })
      .catch(e => { setErr(e.message); setRes(null); })
      .finally(() => setBusy(false));
  }, [f]);

  const copy = (kind) => {
    if (!res?.rows?.length) return;
    const txt = kind === "csv" ? toCsv(res.columns, res.rows) : JSON.stringify(res.rows, null, 2);
    navigator.clipboard?.writeText(txt).catch(() => {});
  };

  const tableList = tblBySrc[f.source] || [];
  const curSrc = srcs.find(s => s.name === f.source);

  return <div className="space-y-4">
    <section className="panel p-3">
      <div className="mb-3 flex items-center gap-2 text-xs">
        <Search size={14} className="text-slate-500"/>
        <span className="text-slate-400">query any RDB / HDB source · guarded <span className="font-mono text-slate-500">select</span> (sym / time / order / limit filters — no free-text where)</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="text-[11px] text-slate-400">source
          <select value={f.source} onChange={e => set("source", e.target.value)}
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-sm text-slate-200">
            {srcs.map(s => <option key={s.name} value={s.name} disabled={!s.endpoints.some(e => e.connected)}>
              {s.name} · {s.kind}{s.endpoints.some(e => e.connected) ? "" : " (offline)"}
            </option>)}
          </select>
        </label>
        <label className="text-[11px] text-slate-400">table
          <input list="ex-tables" value={f.table} onChange={e => set("table", e.target.value)} placeholder="pidstats"
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-200"/>
          <datalist id="ex-tables">{tableList.map(t => <option key={t} value={t}/>)}</datalist>
        </label>
        <label className="text-[11px] text-slate-400">columns <span className="text-slate-600">(comma, blank = all)</span>
          <input value={f.columns} onChange={e => set("columns", e.target.value)} placeholder="timestamp,sym,cpuPct,rss"
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-200"/>
        </label>
        <label className="text-[11px] text-slate-400">sym filter <span className="text-slate-600">(comma)</span>
          <input value={f.sym} onChange={e => set("sym", e.target.value)} placeholder="EURUSD,GBPUSD"
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-200"/>
        </label>
        <label className="text-[11px] text-slate-400">from <span className="text-slate-600">(timestamp ≥)</span>
          <input type="datetime-local" step="1" value={f.start} onChange={e => set("start", e.target.value)}
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-sm text-slate-200"/>
        </label>
        <label className="text-[11px] text-slate-400">to <span className="text-slate-600">(timestamp &lt;)</span>
          <input type="datetime-local" step="1" value={f.end} onChange={e => set("end", e.target.value)}
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-sm text-slate-200"/>
        </label>
        <label className="text-[11px] text-slate-400">order by
          <div className="mt-1 flex gap-1">
            <input value={f.order} onChange={e => set("order", e.target.value)} placeholder="timestamp"
              className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-200"/>
            <select value={f.dir} onChange={e => set("dir", e.target.value)}
              className="rounded border border-slate-800 bg-slate-950 px-1 text-sm text-slate-300">
              <option value="asc">asc</option><option value="desc">desc</option>
            </select>
          </div>
        </label>
        <label className="text-[11px] text-slate-400">limit <span className="text-slate-600">(max 5000)</span>
          <input type="number" min="1" max="5000" value={f.limit} onChange={e => set("limit", e.target.value)}
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-sm text-slate-200"/>
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={run} disabled={busy}
          className="flex items-center gap-1.5 rounded bg-cyan-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50">
          <Play size={13}/> {busy ? "running…" : "run"}
        </button>
        <button onClick={() => { setF({ ...EXPLORER_DEFAULT, source: f.source }); }} className="rounded border border-slate-800 px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-900">clear</button>
        {curSrc && <span className="text-[10px] text-slate-600">{curSrc.endpoints.map(e => e.target).join(" / ")}</span>}
      </div>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{err}</div>}

    {hist.length > 0 && <section className="panel p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="px-1 text-slate-600">recent:</span>
        {hist.map((h, i) => <button key={i} onClick={() => { setF(f2 => ({ ...f2, ...h.f })); }}
          className="rounded border border-slate-800 px-1.5 py-0.5 font-mono text-slate-400 hover:bg-slate-900" title={`${h.matched} rows · ${new Date(h.at).toLocaleTimeString()}`}>
          {h.label}
        </button>)}
        <button onClick={() => { setHist([]); try { localStorage.removeItem("openq.explorer.hist"); } catch {} }}
          className="ml-auto text-slate-600 hover:text-slate-400"><Trash2 size={11}/></button>
      </div>
    </section>}

    {res && <section className="panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2.5 text-xs">
        <span className="font-semibold text-slate-200">{res.table}</span>
        <span className="badge bg-slate-800 text-slate-400">{res.source}</span>
        <span className="text-slate-500">{humanCount(res.matched)} matched · showing {res.count}{res.truncated && <span className="text-amber-400"> (truncated)</span>}</span>
        <span className="text-slate-600">{res.tookMs}ms · {res.target}</span>
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => copy("csv")} className="rounded border border-slate-800 px-2 py-1 text-slate-400 hover:bg-slate-900">copy CSV</button>
          <button onClick={() => copy("json")} className="rounded border border-slate-800 px-2 py-1 text-slate-400 hover:bg-slate-900">copy JSON</button>
        </div>
      </div>
      <div className="max-h-[65vh] overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500">
            <tr>{(res.columns || []).map(c => <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>)}</tr>
          </thead>
          <tbody className="font-mono">
            {(res.rows || []).map((r, i) => <tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/40">
              {(res.columns || []).map(c => <td key={c} className="whitespace-nowrap px-3 py-1 text-slate-300">{exFmt(r[c])}</td>)}
            </tr>)}
            {!res.rows?.length && <tr><td colSpan={(res.columns || []).length || 1} className="px-3 py-6 text-center text-slate-600">no rows matched</td></tr>}
          </tbody>
        </table>
      </div>
    </section>}
  </div>;
}

// ---- System > Launcher (compose a process flow, then launch it) ----
// Preview only: the flow is assembled client-side and the Launch button is
// deliberately a no-op for now.
function Launcher() {
  const [mods, setMods] = useState([]);
  const [topos, setTopos] = useState({});      // moduleName -> { nodes, edges }
  const [expanded, setExpanded] = useState(null);
  const [flow, setFlow] = useState([]);        // ordered [{ name, procs: [nodeId, ...] }]
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch(new URL("/api/modules", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setMods(j.modules || []); setErr(null); })
      .catch(e => setErr(e.message));
  }, []);

  const loadTopo = useCallback((name) => {
    return fetch(new URL(`/api/modules?name=${encodeURIComponent(name)}`, GW), { cache: "no-store" })
      .then(r => r.json())
      .then(j => { setTopos(t => ({ ...t, [name]: j })); return j; })
      .catch(e => { setErr(e.message); return null; });
  }, []);

  const toggleExpand = (name) => {
    setExpanded(x => (x === name ? null : name));
    if (!topos[name]) loadTopo(name);
  };

  // processes of a module, in canonical pipeline order (by column, then id)
  const procsOf = (name) => {
    const t = topos[name];
    if (!t) return [];
    return [...(t.nodes || [])].sort((a, b) => (a.col - b.col) || String(a.id).localeCompare(String(b.id)));
  };

  const groupIdx = (name) => flow.findIndex(f => f.name === name);
  const inFlow = (name, id) => {
    const g = flow[groupIdx(name)];
    return !!g && g.procs.includes(id);
  };

  const addModule = async (name) => {
    const t = topos[name] || (await loadTopo(name));
    const ids = (t?.nodes || []).map(n => n.id);
    setFlow(prev => {
      const i = prev.findIndex(f => f.name === name);
      if (i === -1) return [...prev, { name, procs: ids }];
      const next = [...prev];
      next[i] = { name, procs: [...new Set([...next[i].procs, ...ids])] };
      return next;
    });
  };

  const toggleProc = (name, id) => {
    setFlow(prev => {
      const i = prev.findIndex(f => f.name === name);
      if (i === -1) return [...prev, { name, procs: [id] }];
      const next = [...prev];
      const has = next[i].procs.includes(id);
      const procs = has ? next[i].procs.filter(p => p !== id) : [...next[i].procs, id];
      if (!procs.length) return next.filter((_, k) => k !== i);
      next[i] = { ...next[i], procs };
      return next;
    });
  };

  const removeGroup = (name) => setFlow(prev => prev.filter(f => f.name !== name));
  const move = (i, dir) => setFlow(prev => {
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const totalProcs = flow.reduce((a, f) => a + f.procs.length, 0);

  return <div className="space-y-3">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <Rocket size={14} className="text-slate-500"/>
      <span className="text-slate-400">compose a process flow, then launch it</span>
      <span className="badge bg-slate-800 text-slate-400">{flow.length} module{flow.length === 1 ? "" : "s"} · {totalProcs} process{totalProcs === 1 ? "" : "es"}</span>
      <div className="ml-auto flex items-center gap-2">
        <button onClick={() => setFlow([])} disabled={!flow.length}
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-40">
          <Trash2 size={12}/> Clear
        </button>
        <button onClick={() => { /* preview only - not wired up */ }}
          className="flex items-center gap-1.5 rounded bg-cyan-400 px-4 py-1.5 font-semibold text-slate-950 hover:bg-cyan-300">
          <Rocket size={13}/> Launch
        </button>
      </div>
    </section>
    <div className="px-1 text-[10px] text-slate-600">Preview — the flow is assembled here but the Launch button is not wired up yet.</div>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/modules — {err}</div>}

    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      {/* palette */}
      <section className="panel overflow-hidden self-start">
        <div className="border-b border-slate-800 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Modules</div>
        <div className="divide-y divide-slate-800">
          {mods.map(m => {
            const open = expanded === m.name;
            const gi = groupIdx(m.name);
            return <div key={m.name}>
              <div className="flex items-center gap-2 px-3 py-2 text-sm">
                <button onClick={() => toggleExpand(m.name)} className="flex flex-1 items-center gap-2 text-left hover:text-cyan-300">
                  <ChevronRight size={13} className={`shrink-0 text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}/>
                  <Boxes size={14} className="shrink-0 text-slate-500"/>
                  <span className="font-mono">{m.name}</span>
                  <span className="text-[10px] text-slate-600">{m.roles}</span>
                </button>
                <button onClick={() => addModule(m.name)}
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${gi >= 0 ? "bg-emerald-950 text-emerald-300" : "border border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
                  {gi >= 0 ? "in flow" : "+ all"}
                </button>
              </div>
              {open && <div className="space-y-0.5 bg-[#0a121a] px-3 pb-2 pl-9">
                {procsOf(m.name).map(n => {
                  const on = inFlow(m.name, n.id);
                  return <button key={n.id} onClick={() => toggleProc(m.name, n.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-900">
                    <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${on ? "border-cyan-500 bg-cyan-500 text-slate-950" : "border-slate-600"}`}>{on && <Check size={10}/>}</span>
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: MOD_ROLE_COLOR[n.role] || "#64748b" }}/>
                    <span className="truncate font-mono text-slate-300">{n.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-600">{n.role}{n.port ? ` :${n.port}` : ""}</span>
                  </button>;
                })}
                {!topos[m.name] && <div className="px-2 py-1 text-[10px] text-slate-600">loading…</div>}
                {topos[m.name] && !procsOf(m.name).length && <div className="px-2 py-1 text-[10px] text-slate-600">no processes</div>}
              </div>}
            </div>;
          })}
          {!mods.length && !err && <div className="px-4 py-6 text-center text-xs text-slate-600">loading modules…</div>}
        </div>
      </section>

      {/* flow canvas */}
      <section className="panel min-h-[24rem] p-4">
        {!flow.length ? (
          <div className="flex h-80 flex-col items-center justify-center gap-2 text-center text-slate-600">
            <Rocket size={28} className="opacity-40"/>
            <div className="text-sm">Your flow is empty</div>
            <div className="text-xs">pick modules or individual processes from the left to build a launch sequence</div>
          </div>
        ) : (
          <div className="space-y-1">
            {flow.map((f, i) => {
              const nodes = procsOf(f.name).filter(n => f.procs.includes(n.id));
              return <div key={f.name}>
                <div className="rounded-lg border border-slate-800 bg-[#0b151e] p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-800 text-[10px] font-bold text-slate-400">{i + 1}</span>
                    <Boxes size={14} className="text-slate-500"/>
                    <span className="font-mono text-sm font-semibold text-slate-100">{f.name}</span>
                    <span className="text-[10px] text-slate-600">{f.procs.length} process{f.procs.length === 1 ? "" : "es"}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300 disabled:opacity-30"><ArrowUp size={12}/></button>
                      <button onClick={() => move(i, 1)} disabled={i === flow.length - 1} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300 disabled:opacity-30"><ArrowDown size={12}/></button>
                      <button onClick={() => removeGroup(f.name)} className="rounded p-1 text-slate-500 hover:bg-rose-950 hover:text-rose-300"><X size={13}/></button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {nodes.map((n, k) => <React.Fragment key={n.id}>
                      {k > 0 && <ChevronRight size={12} className="text-slate-700"/>}
                      <span className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs">
                        <span className="h-2 w-2 rounded-sm" style={{ background: MOD_ROLE_COLOR[n.role] || "#64748b" }}/>
                        <span className="font-mono text-slate-200">{n.name}</span>
                        <span className="text-[10px] text-slate-600">{n.role}</span>
                        <button onClick={() => toggleProc(f.name, n.id)} className="text-slate-600 hover:text-rose-400"><X size={10}/></button>
                      </span>
                    </React.Fragment>)}
                    {!nodes.length && <span className="text-xs text-slate-600">expand this module on the left to pick processes</span>}
                  </div>
                </div>
                {i < flow.length - 1 && <div className="flex justify-center py-1"><ArrowDown size={16} className="text-slate-700"/></div>}
              </div>;
            })}
          </div>
        )}
      </section>
    </div>
  </div>;
}

// ---- System > HDB Health (C:\data\db1\mon table-health archives) ---
const HDB_STATUS = {
  HEALTHY: { badge: "bg-emerald-950 text-emerald-300", dot: "#34d399" },
  EMPTY:   { badge: "bg-amber-950 text-amber-300",     dot: "#f59e0b" },
};
const KIND_BADGE = { bar: "bg-sky-950 text-sky-300", tick: "bg-violet-950 text-violet-300" };
const HDB_LINE = ["#34d399", "#38bdf8", "#f59e0b", "#a78bfa", "#f43f5e", "#22d3ee"];

function humanCount(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}
function humanBytes(v) {
  if (v == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function humanAge(sec) {
  if (sec == null) return "—";
  const d = sec / 86400;
  if (d >= 1) return `${Math.round(d)}d`;
  const h = sec / 3600;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.round(sec / 60)}m`;
}

function HDBHealth() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [logScale, setLogScale] = useState(true);
  const [metric, setMetric] = useState("rows"); // rows | bytes
  const [recentKind, setRecentKind] = useState("bar");
  const [source, setSource] = useState(() => {
    try { return localStorage.getItem("openq.hdbhealth.source") || "archive"; } catch { return "archive"; }
  });

  const load = useCallback(() => {
    const u = new URL("/api/hdbhealth", GW);
    if (source) u.searchParams.set("source", source);
    fetch(u, { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, [source]);
  useEffect(() => { setData(null); setErr(null); load(); }, [load]);
  useEffect(() => { const id = setInterval(load, 20000); return () => clearInterval(id); }, [load]);
  const pickSource = (s) => { setSource(s); try { localStorage.setItem("openq.hdbhealth.source", s); } catch {} };

  const SRC_LABEL = { archive: "efx HDB", eq: "eq HDB", mon: "mon HDB" };
  const srcLabel = (n) => SRC_LABEL[n] || n;
  const sources = [...(data?.sources || [{ name: "archive", kind: "archive" }])]
    .sort((a, b) => srcLabel(a.name).localeCompare(srcLabel(b.name)));
  const isLive = !!data?.live;

  const t = data?.totals || {};
  const tabs = data?.tables || [];

  // monthly series pivoted to { month, <tab>: value } for the recharts line chart
  const series = useMemo(() => {
    const rows = (data?.monthly || []);
    const keys = [...new Set(rows.map(r => r.tab))];
    const byMonth = new Map();
    for (const r of rows) {
      const o = byMonth.get(r.month) || { month: r.month };
      o[r.tab] = metric === "rows" ? r.rows : r.bytes;
      byMonth.set(r.month, o);
    }
    return { keys, data: [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1)) };
  }, [data, metric]);

  const recent = useMemo(() => {
    const rows = (data?.recent || []).filter(r => r.kind === recentKind);
    const keys = [...new Set(rows.map(r => r.tab))];
    const byDate = new Map();
    for (const r of rows) {
      const o = byDate.get(r.date) || { date: r.date };
      o[r.tab] = r.rowsToday;
      byDate.set(r.date, o);
    }
    return { keys, data: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
  }, [data, recentKind]);

  // per-table monthly coverage cells (green = full, red = all-empty)
  const coverageRows = useMemo(() => {
    const byTab = new Map();
    for (const m of (data?.monthly || [])) {
      const arr = byTab.get(m.tab) || [];
      arr.push({ month: m.month, frac: m.days ? 1 - m.emptyDays / m.days : 0, days: m.days, emptyDays: m.emptyDays });
      byTab.set(m.tab, arr);
    }
    return [...byTab.entries()].map(([tab, cells]) => ({ tab, cells: cells.sort((a, b) => (a.month < b.month ? -1 : 1)) }));
  }, [data]);

  const covColor = (f) => {
    if (f <= 0) return "#7f1d1d";
    if (f >= 0.999) return "#059669";
    const g = Math.round(80 + f * 100), r = Math.round(220 - f * 160);
    return `rgb(${r},${g},60)`;
  };

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <HardDrive size={14} className="text-slate-500"/>
      <div className="flex gap-1">
        {sources.map(s => <button key={s.name} onClick={() => pickSource(s.name)}
          title={s.target || ""}
          className={`rounded px-2.5 py-1 ${source === s.name ? "bg-slate-700 text-slate-100" : "border border-slate-800 text-slate-400 hover:bg-slate-900"}`}>
          {srcLabel(s.name)}
        </button>)}
      </div>
      <span className="text-slate-500">
        {isLive
          ? <>live scan · <span className="font-mono">{data?.target}</span></>
          : <>table-health archive · <span className="font-mono">C:\data\db1\mon</span> via <span className="font-mono">mon_hdb</span></>}
      </span>
      <span className="ml-auto flex items-center gap-3 text-slate-600">
        {!isLive && data?.scanTs && <span>scanned {agoStr(data.scanTs)}</span>}
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-cyan-400"/>{updated ? updated.toLocaleTimeString() : "…"}</span>
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/hdbhealth — {err}</div>}

    {!data && !err && <div className="panel p-8 text-center text-sm text-slate-500">
      {isLive ? "Scanning the HDB…" : "Scanning the archive…"}<br/><span className="text-xs text-slate-600">first read walks every partition; subsequent loads are cached</span>
    </div>}

    {data && <>
      <div className={`grid grid-cols-2 gap-3 lg:grid-cols-3 ${isLive ? "xl:grid-cols-5" : "xl:grid-cols-6"}`}>
        <Metric label={isLive ? "Tables" : "Tables monitored"} value={String(t.tables ?? 0)} delta={isLive ? "partitioned" : `${t.bar ?? 0} bar · ${t.tick ?? 0} tick`} icon={Database}/>
        <Metric label={isLive ? "Total rows" : "Archive rows"} value={humanCount(t.rowsTotal)} delta="all partitions" icon={Archive}/>
        {!isLive && <Metric label="Archive size" value={humanBytes(t.bytesArchive)} delta="on disk" icon={HardDrive}/>}
        <Metric label="History span" value={`${t.spanDays ?? 0}d`} delta={`${t.oldestDate || "?"} → ${t.newestDate || "?"}`} icon={Gauge}/>
        <Metric label={isLive ? "Empty tables" : "Empty latest"} value={`${t.emptyLatest ?? 0}/${t.tables ?? 0}`} delta={`${t.healthyLatest ?? 0} healthy`} icon={ShieldCheck}/>
        <Metric label={isLive ? "Scanned" : "Last scan"} value={data.scanTs ? agoStr(data.scanTs) : "—"} delta={isLive ? "live" : (data.scanTs ? new Date(data.scanTs).toLocaleDateString() : "")} icon={RefreshCw}/>
      </div>

      <section className="panel overflow-x-auto">
        <div className="border-b border-slate-800 px-4 py-3 font-semibold">Per-table health</div>
        <table className="w-full text-left text-sm">
          <thead className="bg-[#0a121a] text-xs text-slate-500">
            <tr>{(isLive
              ? ["Table", "Latest", "Rows (total)", "Partitions", "Range", "Last data"]
              : ["Table", "Kind", "Latest", "Rows (total)", "Archive", "Partitions", "Coverage", "Range", "Last data"]
            ).map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {tabs.map(row => {
              const st = HDB_STATUS[row.status] || { badge: "bg-slate-800 text-slate-400", dot: "#64748b" };
              const cov = row.coveragePct == null ? 0 : row.coveragePct;
              return <tr key={row.kind + row.tab} className="border-t border-slate-800 align-middle">
                <td className="px-4 py-2 font-mono font-semibold text-slate-200">{row.tab}</td>
                {!isLive && <td className="px-4 py-2"><span className={`badge ${KIND_BADGE[row.kind] || "bg-slate-800 text-slate-400"}`}>{row.kind}</span></td>}
                <td className="px-4 py-2"><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: st.dot }}/><span className={`badge ${st.badge}`}>{row.status || "—"}</span></span></td>
                <td className="px-4 py-2 tabular-nums" title={row.rowsTotal?.toLocaleString()}>{humanCount(row.rowsTotal)}</td>
                {!isLive && <td className="px-4 py-2 tabular-nums text-slate-400">{humanBytes(row.bytesArchive)}</td>}
                <td className="px-4 py-2 tabular-nums text-slate-400">{row.partitionCnt?.toLocaleString()}{row.missingDays ? <span className="ml-1 text-rose-400" title="calendar days in range with no partition">(−{row.missingDays})</span> : null}</td>
                {!isLive && <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-28 overflow-hidden rounded bg-rose-950">
                      <div className="h-full bg-emerald-500" style={{ width: `${cov}%` }}/>
                    </div>
                    <span className="tabular-nums text-xs text-slate-500">{cov.toFixed(0)}%</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-600">{humanCount(row.healthyDays)} healthy · {humanCount(row.emptyDays)} empty</div>
                </td>}
                <td className="px-4 py-2 text-xs text-slate-500">{row.oldestDate}<br/>{row.newestDate}</td>
                <td className="px-4 py-2 tabular-nums text-xs">
                  {row.ageSec == null ? <span className="text-slate-600">—</span>
                    : <span className={row.ageSec > 30 * 86400 ? "text-amber-400" : "text-slate-400"}>{humanAge(row.ageSec)} ago</span>}
                  <div className="text-[10px] text-slate-600">{humanCount(row.rowsToday)} rows latest day</div>
                </td>
              </tr>;
            })}
            {!tabs.length && <tr><td colSpan={isLive ? 6 : 9} className="px-4 py-6 text-center text-slate-600">no health rows</td></tr>}
          </tbody>
        </table>
      </section>

      {isLive && <div className="panel px-4 py-3 text-xs text-slate-500">
        Live scan of <span className="font-mono text-slate-400">{data?.target}</span> — partition counts, row totals and staleness read straight off the running HDB. Monthly history / coverage strips are only available for the <button onClick={() => pickSource("archive")} className="underline hover:text-slate-300">efx HDB</button> source.
      </div>}

      {!isLive && <>
      <section className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold">{metric === "rows" ? "Rows written" : "Bytes on disk"} per month <span className="text-xs font-normal text-slate-500">whole archive</span></div>
          <div className="flex gap-1 text-xs">
            {[["rows", "rows"], ["bytes", "bytes"]].map(([k, lbl]) => <button key={k} onClick={() => setMetric(k)}
              className={`rounded px-2 py-1 ${metric === k ? "bg-slate-700 text-slate-100" : "border border-slate-800 text-slate-400 hover:bg-slate-900"}`}>{lbl}</button>)}
            <button onClick={() => setLogScale(v => !v)}
              className={`rounded px-2 py-1 ${logScale ? "bg-slate-700 text-slate-100" : "border border-slate-800 text-slate-400 hover:bg-slate-900"}`}>log</button>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={series.data} margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3"/>
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#64748b" }} minTickGap={40}/>
            <YAxis scale={logScale ? "log" : "linear"} domain={logScale ? [1, "auto"] : [0, "auto"]} allowDataOverflow
              tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={metric === "rows" ? humanCount : humanBytes} width={54}/>
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", fontSize: 12 }}
              formatter={(v, k) => [metric === "rows" ? humanCount(v) : humanBytes(v), k]}/>
            <Legend wrapperStyle={{ fontSize: 11 }}/>
            {series.keys.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={HDB_LINE[i % HDB_LINE.length]} dot={false} strokeWidth={1.5} connectNulls/>)}
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section className="panel p-4">
        <div className="mb-1 font-semibold">Archive completeness <span className="text-xs font-normal text-slate-500">green = every day has data · red = all-empty month</span></div>
        <div className="space-y-2 overflow-x-auto pt-2">
          {coverageRows.map(({ tab, cells }) => <div key={tab} className="flex items-center gap-3">
            <div className="w-40 shrink-0 truncate font-mono text-xs text-slate-400" title={tab}>{tab}</div>
            <div className="flex gap-px">
              {cells.map(c => <div key={c.month} title={`${c.month}: ${(c.frac * 100).toFixed(0)}% (${c.days - c.emptyDays}/${c.days} days)`}
                className="h-6 w-1.5 shrink-0" style={{ background: covColor(c.frac) }}/>)}
            </div>
          </div>)}
          {!coverageRows.length && <div className="py-4 text-center text-xs text-slate-600">no monthly data</div>}
        </div>
      </section>

      <section className="panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="font-semibold">Rows per day <span className="text-xs font-normal text-slate-500">last 180 days</span></div>
          <div className="flex gap-1 text-xs">
            {["bar", "tick"].map(k => <button key={k} onClick={() => setRecentKind(k)}
              className={`rounded px-2 py-1 ${recentKind === k ? "bg-slate-700 text-slate-100" : "border border-slate-800 text-slate-400 hover:bg-slate-900"}`}>{k}</button>)}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={recent.data} margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3"/>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} minTickGap={40}/>
            <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={humanCount} width={54}/>
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", fontSize: 12 }} formatter={(v, k) => [humanCount(v), k]}/>
            <Legend wrapperStyle={{ fontSize: 11 }}/>
            {recent.keys.map((k, i) => <Area key={k} type="monotone" dataKey={k} stroke={HDB_LINE[i % HDB_LINE.length]} fill={HDB_LINE[i % HDB_LINE.length]} fillOpacity={0.12} strokeWidth={1.5} connectNulls/>)}
          </AreaChart>
        </ResponsiveContainer>
      </section>
      </>}
    </>}
  </div>;
}

// ---- System > Modules (interactive architecture diagram) -----------
function NodeLogsPanel({ node }) {
  const proc = node?.logProc;
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  useEffect(() => {
    if (!proc) return;
    setData(null); setErr(null);
    let alive = true;
    const load = () => {
      const u = new URL("/api/logs", GW);
      u.searchParams.set("proc", proc);
      u.searchParams.set("limit", "200");
      fetch(u, { cache: "no-store" })
        .then(r => r.json())
        .then(j => { if (!alive) return; setData(j); setErr(j.error || null); })
        .catch(e => { if (alive) setErr(e.message); });
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [proc]);

  const rows = data?.rows || [];
  return <section className="panel overflow-hidden">
    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
      <div className="font-semibold">Process log <span className="ml-1 font-mono text-xs text-cyan-300">{node?.name}</span></div>
      <span className="text-xs text-slate-500">{data ? `${rows.length} of ${data.total} lines` : err ? "" : "loading…"}</span>
    </div>
    {err && <div className="px-4 py-2 text-xs text-rose-300">{GW}/api/logs — {err}</div>}
    <div className="max-h-[46vh] overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 z-10 bg-[#0a121a] text-slate-500">
          <tr>{["Time","Level","Function","Message"].map(h=><th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r,i)=>
            <tr key={i} className="border-t border-slate-800/70 align-top hover:bg-slate-900/60">
              <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">{r.time}</td>
              <td className="px-4 py-1.5"><span className={`badge ${LOG_LEVEL_STYLE[r.level] || LOG_LEVEL_STYLE.INFO}`}>{r.level}</span></td>
              <td className="whitespace-nowrap px-4 py-1.5 text-slate-400">{r.function}</td>
              <td className="px-4 py-1.5 text-slate-300"><pre className="whitespace-pre-wrap break-words font-mono text-xs">{r.message}</pre></td>
            </tr>)}
          {data && !rows.length && <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-600">no log lines for {proc}</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}

const MOD_COLS = ["Feed", "Tickerplant", "CEP", "RDB", "IDB", "HDB / EOD", "Gateway"];
const MOD_ROLE_COLOR = {
  fh: "#a78bfa", feed: "#a78bfa", tp: "#22d3ee", cep: "#f59e0b", rdb: "#34d399",
  idb: "#38bdf8", hdb: "#64748b", eod: "#475569", gw: "#f43f5e", housekeeping: "#64748b",
};
const NW = 168, NH = 56, COLGAP = 74, ROWGAP = 26, PADX = 24, HEADY = 34;
// edge look per kind: the pipeline is a solid line, gw queries are dashed,
// the idb->rdb flush is a faint dotted aside
const EDGE_STYLE = {
  flow:  { stroke: "#5eead4", width: 2,   dash: null,    marker: "mk-arrow-flow" },
  feed:  { stroke: "#a78bfa", width: 2,   dash: null,    marker: "mk-arrow-feed" },
  eod:   { stroke: "#64748b", width: 1.5, dash: null,    marker: "mk-arrow" },
  flush: { stroke: "#475569", width: 1.5, dash: "2 4",   marker: "mk-arrow" },
  query: { stroke: "#f472b6", width: 1.5, dash: "6 5",   marker: "mk-arrow-q" },
};

function Modules() {
  const [list,setList] = useState([]);
  const [mod,setMod] = useState("");
  const [topo,setTopo] = useState(null);
  const [sel,setSel] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

  useEffect(() => {
    fetch(new URL("/api/modules", GW), { cache: "no-store" })
      .then(r => r.json()).then(j => {
        setList(j.modules || []);
        if (!mod && j.modules?.length) setMod((j.modules.find(m=>m.name==="default") || j.modules[0]).name);
      }).catch(e => setErr(e.message));
  }, []); // eslint-disable-line

  const load = useCallback(() => {
    if (!mod) return;
    const u = new URL("/api/modules", GW); u.searchParams.set("name", mod);
    fetch(u, { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setTopo(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, [mod]);
  useEffect(() => { setSel(null); load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [auto, load]);

  // layout: place nodes in columns by `col`, stack within a column
  const { nodes, edges, W, H } = useMemo(() => {
    const ns = (topo?.nodes || []).map(n => ({ ...n }));
    const byCol = {};
    ns.forEach(n => { (byCol[n.col] ??= []).push(n); });
    let maxRows = 1;
    Object.values(byCol).forEach(arr => { maxRows = Math.max(maxRows, arr.length); });
    const H = HEADY + maxRows * (NH + ROWGAP) + 16;
    Object.entries(byCol).forEach(([col, arr]) => {
      const colX = PADX + Number(col) * (NW + COLGAP);
      const totalH = arr.length * NH + (arr.length - 1) * ROWGAP;
      const startY = HEADY + (H - HEADY - totalH) / 2;
      arr.forEach((n, i) => { n.x = colX; n.y = startY + i * (NH + ROWGAP); });
    });
    const pos = Object.fromEntries(ns.map(n => [n.id, n]));
    const W = PADX * 2 + MOD_COLS.length * NW + (MOD_COLS.length - 1) * COLGAP;
    return { nodes: ns, edges: (topo?.edges || []).map(e => ({ ...e, s: pos[e.from], t: pos[e.to] })).filter(e => e.s && e.t), W, H };
  }, [topo]);

  const selNode = topo?.nodes.find(n => n.id === sel);

  const edgeGeom = (s, t) => {
    const sx = s.x + (t.x >= s.x ? NW : 0), sy = s.y + NH / 2;
    const tx = t.x + (t.x >= s.x ? 0 : NW), ty = t.y + NH / 2;
    const dx = Math.max(30, Math.abs(tx - sx) * 0.4) * (tx >= sx ? 1 : -1);
    // cubic midpoint (t=0.5) with the control points below
    const c1x = sx + dx, c2x = tx - dx;
    const mx = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * tx;
    const my = 0.5 * sy + 0.5 * ty;
    return { d: `M${sx},${sy} C${c1x},${sy} ${c2x},${ty} ${tx},${ty}`, mx, my };
  };

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">process topology · from <span className="text-slate-500">openQ/cfg_proc</span></span>
      <select value={mod} onChange={e=>setMod(e.target.value)} className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-slate-200">
        {list.map(m => <option key={m.name} value={m.name}>{m.name} ({m.roles})</option>)}
      </select>
      {topo && <span className={`badge ${topo.up===topo.total ? "bg-emerald-950 text-emerald-300" : "bg-amber-950 text-amber-300"}`}>{topo.up}/{topo.total} up</span>}
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/modules — {err}</div>}

    <div className="grid gap-4 xl:grid-cols-[3fr_1fr]">
      <section className="panel overflow-auto p-3">
        <svg width={W} height={H} className="min-w-full">
          <defs>
            {[["mk-arrow","#475569"],["mk-arrow-flow","#5eead4"],["mk-arrow-feed","#a78bfa"],["mk-arrow-q","#f472b6"]].map(([id,fill]) =>
              <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill={fill}/>
              </marker>)}
          </defs>
          {MOD_COLS.map((c,i) => <text key={c} x={PADX + i*(NW+COLGAP) + NW/2} y={18} textAnchor="middle"
            className="fill-slate-600 text-[10px] uppercase tracking-widest">{c}</text>)}
          {edges.map((e,i) => {
            const st = EDGE_STYLE[e.kind] || EDGE_STYLE.flow;
            const g = edgeGeom(e.s, e.t);
            return <g key={i}>
              <path d={g.d} fill="none" stroke={st.stroke} strokeWidth={st.width}
                strokeDasharray={st.dash || undefined} markerEnd={`url(#${st.marker})`} opacity={0.9}/>
              {e.label && <text x={g.mx} y={g.my - 4} textAnchor="middle"
                className="fill-slate-500 text-[9px]" style={{ paintOrder: "stroke", stroke: "#0b151e", strokeWidth: 3 }}>{e.label}</text>}
            </g>;
          })}
          {nodes.map(n => {
            const up = n.live?.up;
            const col = MOD_ROLE_COLOR[n.role] || "#64748b";
            const active = sel === n.id;
            return <g key={n.id} transform={`translate(${n.x},${n.y})`} onClick={()=>setSel(active?null:n.id)} style={{cursor:"pointer"}}>
              <rect width={NW} height={NH} rx="8" fill="#0b151e"
                stroke={active ? "#22d3ee" : up ? col : "#7f1d1d"} strokeWidth={active ? 2 : 1.5}
                opacity={up ? 1 : 0.55}/>
              <rect width="4" height={NH} rx="2" fill={col} opacity={up ? 1 : 0.4}/>
              <circle cx={NW-12} cy={12} r="4" fill={up ? "#34d399" : "#f43f5e"}/>
              <text x="14" y="21" className="fill-slate-100 text-[12px] font-semibold">{n.name}</text>
              <text x="14" y="37" className="fill-slate-500 text-[10px]">{n.role}{n.port ? ` · :${n.port}` : ""}</text>
              <text x="14" y="50" className="fill-slate-600 text-[10px]">
                {up && n.live.tables ? `${Object.keys(n.live.tables).length} tbl · ${n.live.handles} conn` : up ? "up" : "down"}
              </text>
            </g>;
          })}
        </svg>
      </section>

      <section className="panel p-4 text-xs">
        {sel && topo ? (() => {
          const n = topo.nodes.find(x => x.id === sel);
          if (!n) return null;
          return <div className="space-y-3">
            <div>
              <div className="text-sm font-semibold text-slate-100">{n.name}</div>
              <div className="text-slate-500">{n.role}{n.port ? ` · port ${n.port}` : ""} · <span className={n.live?.up ? "text-emerald-400" : "text-rose-400"}>{n.live?.up ? "up" : "down"}</span></div>
            </div>
            {n.schema && <div><span className="text-slate-500">schema</span> <span className="font-mono text-slate-300">{n.schema}</span></div>}
            {n.cepscript && <div><span className="text-slate-500">cepscript</span> <span className="font-mono text-slate-300">{n.cepscript}</span></div>}
            {n.live?.up && n.live.tables && <div>
              <div className="mb-1 text-slate-500">tables</div>
              {Object.entries(n.live.tables).sort((a,b)=>b[1]-a[1]).map(([t,c]) =>
                <div key={t} className="flex justify-between py-0.5"><span className="font-mono text-cyan-300">{t}</span><span className="tabular-nums text-slate-300">{c.toLocaleString()}</span></div>)}
              {!Object.keys(n.live.tables).length && <div className="text-slate-600">none</div>}
            </div>}
            {n.live?.up && <div><span className="text-slate-500">open handles</span> <span className="tabular-nums text-slate-300">{n.live.handles}</span></div>}
            {n.libraries?.length > 0 && <div>
              <div className="mb-1 text-slate-500">libraries</div>
              <div className="font-mono text-[10px] text-slate-500">{n.libraries.join(", ")}</div>
            </div>}
            <div>
              <div className="mb-1 text-slate-500">wiring</div>
              {topo.edges.filter(e => e.from === n.id || e.to === n.id).map((e,i) =>
                <div key={i} className="text-slate-400">{e.from===n.id ? "→ " : "← "}{e.from===n.id ? e.to : e.from} <span className="text-slate-600">({e.label})</span></div>)}
            </div>
          </div>;
        })() : <div className="flex h-full items-center justify-center text-center text-slate-600">click a node<br/>for detail</div>}
      </section>
    </div>

    {selNode && <NodeLogsPanel node={selNode}/>}

    <section className="panel flex flex-wrap items-center gap-x-5 gap-y-1 p-3 text-[10px]">
      {Object.entries(MOD_ROLE_COLOR).filter(([r])=>!["feed","housekeeping"].includes(r)).map(([r,c]) =>
        <span key={r} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{background:c}}/><span className="text-slate-400 uppercase">{r}</span></span>)}
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400"/><span className="text-slate-400">up</span></span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-400"/><span className="text-slate-400">down</span></span>
      <span className="mx-1 h-3 w-px bg-slate-700"/>
      <span className="flex items-center gap-1.5"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#5eead4" strokeWidth="2"/></svg><span className="text-slate-400">data flow</span></span>
      <span className="flex items-center gap-1.5"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#f472b6" strokeWidth="1.5" strokeDasharray="6 5"/></svg><span className="text-slate-400">gateway query</span></span>
      <span className="flex items-center gap-1.5"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#475569" strokeWidth="1.5" strokeDasharray="2 4"/></svg><span className="text-slate-400">idb flush</span></span>
    </section>
  </div>;
}

// ---- eFX Charts (OHLC candlesticks) --------------------------------
const OHLC_BUCKETS = [["5s",5],["15s",15],["30s",30],["1m",60],["5m",300]];

// eFX > Charts indicator toolbar. `pane:true` => its own sub-pane (RSI/MACD/
// ATR); the rest overlay the price pane. `len` is user-tunable except MACD
// (fixed 12/26/9). Defaults chosen to match what most traders reach for.
const IND_DEFS = [
  { key: "sma",  label: "SMA",  len: true  },
  { key: "ema",  label: "EMA",  len: true  },
  { key: "bb",   label: "BB",   len: true  },
  { key: "rsi",  label: "RSI",  len: true,  pane: true },
  { key: "macd", label: "MACD", len: false, pane: true },
  { key: "atr",  label: "ATR",  len: true,  pane: true },
];
const IND_DEFAULT = {
  sma: { on: false, len: 20 },
  ema: { on: true,  len: 20 },
  bb:  { on: false, len: 20, mult: 2 },
  rsi: { on: true,  len: 14 },
  macd:{ on: false },
  atr: { on: false, len: 14 },
};

// ---- indicator math (pure; operate on number[] aligned to bars, null = warmup) --
function iSMA(v, n) {
  const out = Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function iEMA(v, n) {
  const out = Array(v.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) continue;
    if (i === n - 1) { let s = 0; for (let j = 0; j < n; j++) s += v[j]; prev = s / n; out[i] = prev; continue; }
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function iStdPop(v, n) {
  const out = Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    let s = 0, ss = 0;
    for (let j = i - n + 1; j <= i; j++) { s += v[j]; ss += v[j] * v[j]; }
    const m = s / n;
    out[i] = Math.sqrt(Math.max(0, ss / n - m * m));
  }
  return out;
}
function iRSI(c, n) {
  const out = Array(c.length).fill(null);
  if (c.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function iMACD(c, f = 12, s = 26, sig = 9) {
  const ef = iEMA(c, f), es = iEMA(c, s);
  const line = c.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const first = line.findIndex((x) => x != null);
  const sigOut = Array(c.length).fill(null);
  if (first >= 0) {
    const compact = iEMA(line.slice(first), sig);
    for (let i = 0; i < compact.length; i++) if (compact[i] != null) sigOut[first + i] = compact[i];
  }
  const hist = line.map((x, i) => (x == null || sigOut[i] == null ? null : x - sigOut[i]));
  return { line, signal: sigOut, hist };
}
function iATR(h, l, c, n) {
  const out = Array(c.length).fill(null);
  const tr = c.map((_, i) => (i === 0 ? h[0] - l[0]
    : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  if (tr.length <= n) return out;
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr[i];
  a /= n; out[n] = a;
  for (let i = n + 1; i < tr.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}
const iLine = (times, arr) => {
  const d = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] != null && Number.isFinite(arr[i])) d.push({ time: times[i], value: arr[i] });
  return d;
};

// TradingView Lightweight Charts candlestick for the eFX > Charts page.
// Imperative canvas lib, so the chart + every series live in refs. The
// chart is (re)built only when `precision` or the indicator SET changes
// (JSON key); every 3s poll just recomputes indicators from `bars` and
// calls setData. `bars` (from /api/ohlc) is bucket-aligned / ascending /
// de-duped, so time = t/1000 (UNIX sec) satisfies the lib's contract.
// Oscillators (RSI/MACD/ATR) go in native v5 sub-panes below price.
function LwCandles({ bars, precision = 5, indicators }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const mainRef = useRef(null);
  const extraRef = useRef({});               // name -> ISeriesApi
  const [ohlc, setOhlc] = useState(null);    // O/H/L/C under the crosshair, or last bar

  const ind = indicators || {};
  const indKey = JSON.stringify(ind);
  const oscN = ["rsi", "macd", "atr"].filter((k) => ind[k] && ind[k].on).length;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8", fontSize: 11,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        panes: { separatorColor: "#26323d", separatorHoverColor: "#334155" },
      },
      grid: { vertLines: { color: "#1e2b36" }, horzLines: { color: "#1e2b36" } },
      rightPriceScale: { borderColor: "#26323d" },
      timeScale: { borderColor: "#26323d", timeVisible: true, secondsVisible: true, rightOffset: 3 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const line = (color, extra) => ({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, ...extra });
    // oscillator panes hold FX-scale deltas (~1e-5); force fine precision or
    // they render as "0.00"
    const fine = { priceFormat: { type: "price", precision: 6, minMove: 1e-6 } };
    const main = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399", downColor: "#f43f5e",
      wickUpColor: "#34d399", wickDownColor: "#f43f5e",
      borderVisible: false,
      priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision },
    });
    const E = {};
    if (ind.sma && ind.sma.on) E.sma = chart.addSeries(LineSeries, line("#22d3ee"), 0);
    if (ind.ema && ind.ema.on) E.ema = chart.addSeries(LineSeries, line("#f59e0b"), 0);
    if (ind.bb && ind.bb.on) {
      E.bbU = chart.addSeries(LineSeries, line("#475569"), 0);
      E.bbM = chart.addSeries(LineSeries, line("#64748b", { lineStyle: 2 }), 0);
      E.bbL = chart.addSeries(LineSeries, line("#475569"), 0);
    }
    let p = 1;
    if (ind.rsi && ind.rsi.on) {
      const s = chart.addSeries(LineSeries, line("#a78bfa"), p++);
      s.createPriceLine({ price: 70, color: "#334155", lineWidth: 1, lineStyle: 2 });
      s.createPriceLine({ price: 30, color: "#334155", lineWidth: 1, lineStyle: 2 });
      E.rsi = s;
    }
    if (ind.macd && ind.macd.on) {
      const pane = p++;
      E.macdH = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, ...fine }, pane);
      E.macd = chart.addSeries(LineSeries, line("#22d3ee", fine), pane);
      E.macdS = chart.addSeries(LineSeries, line("#f43f5e", fine), pane);
    }
    if (ind.atr && ind.atr.on) E.atr = chart.addSeries(LineSeries, line("#f59e0b", fine), p++);

    try {
      const panes = chart.panes();
      if (panes[0]) panes[0].setStretchFactor(3);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    } catch { /* pane API absent on older builds */ }

    chart.subscribeCrosshairMove((param) => {
      const d = param && param.seriesData && param.seriesData.get(main);
      if (d) setOhlc({ o: d.open, h: d.high, l: d.low, c: d.close });
    });

    chartRef.current = chart;
    mainRef.current = main;
    extraRef.current = E;
    return () => { chart.remove(); chartRef.current = null; mainRef.current = null; extraRef.current = {}; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precision, indKey]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const rows = (bars || [])
      .map((b) => ({ t: Math.floor(b.t / 1000), o: b.open, h: b.high, l: b.low, c: b.close }))
      .filter((b) => Number.isFinite(b.o) && Number.isFinite(b.c));
    const times = rows.map((r) => r.t);
    const closes = rows.map((r) => r.c), highs = rows.map((r) => r.h), lows = rows.map((r) => r.l);
    main.setData(rows.map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c })));

    const E = extraRef.current;
    if (E.sma) E.sma.setData(iLine(times, iSMA(closes, ind.sma.len || 20)));
    if (E.ema) E.ema.setData(iLine(times, iEMA(closes, ind.ema.len || 20)));
    if (E.bbM) {
      const n = ind.bb.len || 20, m = ind.bb.mult || 2;
      const mid = iSMA(closes, n), sd = iStdPop(closes, n);
      E.bbM.setData(iLine(times, mid));
      E.bbU.setData(iLine(times, mid.map((x, i) => (x == null || sd[i] == null ? null : x + m * sd[i]))));
      E.bbL.setData(iLine(times, mid.map((x, i) => (x == null || sd[i] == null ? null : x - m * sd[i]))));
    }
    if (E.rsi) E.rsi.setData(iLine(times, iRSI(closes, ind.rsi.len || 14)));
    if (E.macd) {
      const { line, signal, hist } = iMACD(closes);
      E.macd.setData(iLine(times, line));
      E.macdS.setData(iLine(times, signal));
      E.macdH.setData(hist.reduce((acc, v, i) => {
        if (v != null && Number.isFinite(v)) acc.push({ time: times[i], value: v, color: v >= 0 ? "#14532d" : "#7f1d1d" });
        return acc;
      }, []));
    }
    if (E.atr) E.atr.setData(iLine(times, iATR(highs, lows, closes, ind.atr.len || 14)));

    const last = rows[rows.length - 1];
    setOhlc(last ? { o: last.o, h: last.h, l: last.l, c: last.c } : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, indKey]);

  const px = (v) => (v == null ? "—" : v.toFixed(precision));
  const up = ohlc && ohlc.c >= ohlc.o;
  return (
    <div className="relative w-full" style={{ height: 384 + oscN * 132 }}>
      <div ref={boxRef} className="absolute inset-0"/>
      {ohlc && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex gap-3 rounded bg-[#0b151e]/80 px-2 py-1 font-mono text-[11px] tabular-nums">
          {[["O", ohlc.o], ["H", ohlc.h], ["L", ohlc.l], ["C", ohlc.c]].map(([k, v]) => (
            <span key={k}><span className="text-slate-500">{k}</span> <span className={up ? "text-emerald-400" : "text-rose-400"}>{px(v)}</span></span>
          ))}
        </div>
      )}
    </div>
  );
}

function Charts() {
  const [sym,setSym] = useState("");
  const [bucket,setBucket] = useState(15);
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);
  const [ind,setInd] = useState(() => {
    try { const s = localStorage.getItem("openq.charts.ind"); if (s) return { ...IND_DEFAULT, ...JSON.parse(s) }; } catch { /* ignore */ }
    return IND_DEFAULT;
  });
  useEffect(() => { try { localStorage.setItem("openq.charts.ind", JSON.stringify(ind)); } catch { /* ignore */ } }, [ind]);
  const setIndKey = (k, patch) => setInd(v => ({ ...v, [k]: { ...v[k], ...patch } }));

  const load = useCallback(() => {
    const u = new URL("/api/ohlc", GW);
    if (sym) u.searchParams.set("sym", sym);
    u.searchParams.set("bucket", String(bucket));
    u.searchParams.set("count", "90");
    fetch(u, { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); if(!sym && j.sym) setSym(j.sym); })
      .catch(e => setErr(e.message));
  }, [sym, bucket]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const nBars = (data?.bars || []).length;
  const lo = data?.lo, hi = data?.hi;
  const chg = data?.changePct;

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <select value={sym} onChange={e=>setSym(e.target.value)}
        className="rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-slate-200">
        {(data?.syms || (sym ? [sym] : [])).map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <div className="flex overflow-hidden rounded border border-slate-800">
        {OHLC_BUCKETS.map(([lab,sec]) => <button key={sec} onClick={()=>setBucket(sec)}
          className={`px-2 py-1 ${bucket===sec ? "bg-slate-800 text-cyan-300" : "text-slate-400 hover:bg-slate-900"}`}>{lab}</button>)}
      </div>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">feed disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>

      <div className="flex w-full flex-wrap items-center gap-1.5 border-t border-slate-800 pt-2">
        <span className="text-slate-500">indicators</span>
        {IND_DEFS.map(d => {
          const cur = ind[d.key] || {};
          return <span key={d.key} className="flex items-center">
            <button onClick={() => setIndKey(d.key, { on: !cur.on })}
              className={`rounded px-2 py-1 font-semibold ${cur.on ? "bg-cyan-500 text-slate-950" : "border border-slate-700 text-slate-400 hover:bg-slate-800"}`}
              title={d.pane ? "oscillator — own pane" : "price overlay"}>{d.label}</button>
            {cur.on && d.len && <input type="number" min={2} max={200} value={cur.len ?? 20}
              onChange={e => setIndKey(d.key, { len: Math.max(2, Math.min(200, Number(e.target.value) || cur.len || 20)) })}
              className="ml-1 w-12 rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-slate-200 outline-none focus:border-cyan-500"/>}
          </span>;
        })}
      </div>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/ohlc — {err}
      <div className="mt-1 text-rose-400/70">needs the markout module + feeder running and OPENQ_OHLC_STREAM set.</div></div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Last" value={data?.last != null ? data.last.toFixed(5) : "—"} delta={`${nBars} bars`} icon={CandlestickChart}/>
      <Metric label="Change" value={chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(3)}%`} delta="over window" icon={chg >= 0 ? TrendingUp : TrendingDown}/>
      <Metric label="High" value={hi != null ? hi.toFixed(5) : "—"} delta="session" icon={TrendingUp}/>
      <Metric label="Low" value={lo != null ? lo.toFixed(5) : "—"} delta="session" icon={TrendingDown}/>
    </div>

    <section className="panel p-4">
      <div className="mb-3 flex justify-between">
        <div className="font-semibold">{sym || "—"} <span className="text-xs text-slate-500">mid OHLC · {OHLC_BUCKETS.find(b=>b[1]===bucket)?.[0]} bars</span></div>
      </div>
      <LwCandles bars={data?.bars || []} precision={5} indicators={ind}/>
      {data && !nBars && <div className="pt-4 text-center text-sm text-slate-500">no ticks buffered yet — the gateway accumulates from the live feed on startup</div>}
    </section>
  </div>;
}

// EQ > Charts — 1-minute candlesticks for eq_m1_yfinance (Asian equities,
// HKEX + Tokyo/Nikkei) read straight off eq_hdb via /api/eq/*. Reuses the
// eFX chart's <LwCandles> (indicators and all), just a different feed.
const EQ_DAYS = [1, 3, 5, 10];
function eqPricePrec(v) {
  const a = Math.abs(Number(v) || 0);
  if (a >= 1000) return 1;
  if (a >= 100) return 2;
  if (a >= 1) return 3;
  return 4;
}
function EqCharts() {
  const [uni, setUni] = useState(null);            // { count, exchanges, syms:[{sym,exchange}] }
  const [exch, setExch] = useState("");
  const [q, setQ] = useState("");
  const [sym, setSym] = useState(() => { try { return localStorage.getItem("openq.eqcharts.sym") || ""; } catch { return ""; } });
  const [days, setDays] = useState(3);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [uniErr, setUniErr] = useState(null);
  const [auto, setAuto] = useState(true);
  const [updated, setUpdated] = useState(null);
  const [ind, setInd] = useState(() => {
    try { const s = localStorage.getItem("openq.eqcharts.ind"); if (s) return { ...IND_DEFAULT, ...JSON.parse(s) }; } catch { /* ignore */ }
    return IND_DEFAULT;
  });
  useEffect(() => { try { localStorage.setItem("openq.eqcharts.ind", JSON.stringify(ind)); } catch { /* ignore */ } }, [ind]);
  const setIndKey = (k, patch) => setInd(v => ({ ...v, [k]: { ...v[k], ...patch } }));
  useEffect(() => { try { sym && localStorage.setItem("openq.eqcharts.sym", sym); } catch { /* ignore */ } }, [sym]);

  // symbol universe (once; refresh button re-pulls)
  const loadUni = useCallback(() => {
    fetch(new URL("/api/eq/syms", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setUni(j); setUniErr(null); setSym(s => s || (j.syms[0] && j.syms[0].sym) || ""); })
      .catch(e => setUniErr(e.message));
  }, []);
  useEffect(() => { loadUni(); }, [loadUni]);

  const load = useCallback(() => {
    if (!sym) return;
    const u = new URL("/api/eq/bars", GW);
    u.searchParams.set("sym", sym);
    u.searchParams.set("days", String(days));
    fetch(u, { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, [sym, days]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [auto, load]);

  const shown = useMemo(() => {
    if (!uni) return [];
    const needle = q.trim().toLowerCase();
    return uni.syms
      .filter(s => (!exch || s.exchange === exch) && (!needle || s.sym.toLowerCase().includes(needle)))
      .slice(0, 80);
  }, [uni, exch, q]);

  const prec = eqPricePrec(data?.last);
  const chg = data?.changePct;
  const nBars = data?.bars?.length || 0;

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">Asian equities · <span className="text-slate-500">eq_m1_yfinance via eq_hdb</span></span>
      <span className="flex overflow-hidden rounded border border-slate-800">
        {[["All", ""], ...(uni?.exchanges || []).map(e => [e.exchange, e.exchange])].map(([lab, v]) =>
          <button key={v || "all"} onClick={() => setExch(v)}
            className={`px-2 py-1 ${exch === v ? "bg-slate-800 text-cyan-300" : "text-slate-400 hover:bg-slate-900"}`}>{lab}</button>)}
      </span>
      <span className="relative">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={sym || "search symbol…"}
          className="w-40 rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-slate-200 outline-none focus:border-cyan-500"/>
        {q.trim() && shown.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-64 w-48 overflow-auto rounded border border-slate-700 bg-[#0b151e] py-1 shadow-lg">
            {shown.map(s => <button key={s.sym} onClick={() => { setSym(s.sym); setQ(""); }}
              className="flex w-full items-center justify-between px-2 py-1 text-left font-mono hover:bg-slate-800">
              <span className="text-slate-200">{s.sym}</span><span className="text-[10px] text-slate-500">{s.exchange}</span>
            </button>)}
          </div>
        )}
      </span>
      <span className="flex overflow-hidden rounded border border-slate-800">
        {EQ_DAYS.map(d => <button key={d} onClick={() => setDays(d)}
          className={`px-2 py-1 ${days === d ? "bg-slate-800 text-cyan-300" : "text-slate-400 hover:bg-slate-900"}`}>{d}d</button>)}
      </span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/> auto</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {uni && <span>{uni.count.toLocaleString()} symbols</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>

      <div className="flex w-full flex-wrap items-center gap-1.5 border-t border-slate-800 pt-2">
        <span className="text-slate-500">indicators</span>
        {IND_DEFS.map(d => {
          const cur = ind[d.key] || {};
          return <span key={d.key} className="flex items-center">
            <button onClick={() => setIndKey(d.key, { on: !cur.on })}
              className={`rounded px-2 py-1 font-semibold ${cur.on ? "bg-cyan-500 text-slate-950" : "border border-slate-700 text-slate-400 hover:bg-slate-800"}`}
              title={d.pane ? "oscillator — own pane" : "price overlay"}>{d.label}</button>
            {cur.on && d.len && <input type="number" min={2} max={200} value={cur.len ?? 20}
              onChange={e => setIndKey(d.key, { len: Math.max(2, Math.min(200, Number(e.target.value) || cur.len || 20)) })}
              className="ml-1 w-12 rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-slate-200 outline-none focus:border-cyan-500"/>}
          </span>;
        })}
      </div>
    </section>

    {uniErr && <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">{GW}/api/eq — {uniErr}
      <div className="mt-1 text-amber-400/70">start the <span className="font-mono">eq</span> module from SystemAdmin → Control (or <span className="font-mono">scripts/startupAllByModule.sh eq</span>).</div></div>}
    {err && !uniErr && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/eq/bars — {err}</div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Last" value={data?.last != null ? data.last.toFixed(prec) : "—"} delta={`${nBars} 1-min bars`} icon={CandlestickChart}/>
      <Metric label="Change" value={chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`} delta={`last ${data?.days ?? days} sessions`} icon={chg >= 0 ? TrendingUp : TrendingDown}/>
      <Metric label="High" value={data?.hi != null ? data.hi.toFixed(prec) : "—"} delta="window" icon={TrendingUp}/>
      <Metric label="Volume" value={data?.vol != null ? humanCount(data.vol) : "—"} delta="window total" icon={BarChart3}/>
    </div>

    <section className="panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-semibold">{sym || "—"} <span className="text-xs text-slate-500">{data?.exchange ? `${data.exchange} · ` : ""}1-minute OHLC</span></div>
        {data?.lo != null && <div className="text-xs text-slate-500">low {data.lo.toFixed(prec)}</div>}
      </div>
      <LwCandles bars={data?.bars || []} precision={prec} indicators={ind}/>
      {data && !nBars && <div className="pt-4 text-center text-sm text-slate-500">no minute data for {sym} in the last {days} sessions</div>}
    </section>
  </div>;
}

function Impact() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/markout", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const im = data?.impact || {};
  const s = data?.summary || {};
  const curve = (im.curve || []).map(r => ({ ...r, label: fmtOffset(r.offsetSec) }));
  const bySym = im.bySym || [];

  // decay tau: from the peak, first offset where |impact| falls to |peak|/e
  const tau = (() => {
    const pts = curve.filter(r => r.offsetSec >= 0 && r.impactBps != null);
    if (pts.length < 3) return null;
    let peak = pts[0];
    for (const p of pts) if (Math.abs(p.impactBps) > Math.abs(peak.impactBps)) peak = p;
    const target = Math.abs(peak.impactBps) / Math.E;
    for (const p of pts) if (p.offsetSec > peak.offsetSec && Math.abs(p.impactBps) <= target) return p.offsetSec - peak.offsetSec;
    return null;
  })();
  const pctPerm = (im.peakBps && im.permanentBps != null && im.peakBps !== 0)
    ? Math.abs(im.permanentBps / im.peakBps) * 100 : null;

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">order / execution impact · <span className="text-slate-500">markout module CEP via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/markout — {err}
      <div className="mt-1 text-rose-400/70">needs the markout module + a feeder running.</div></div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Temporary impact" value={bps1(im.peakBps)} delta="peak, 0–10s" icon={TrendingUp}/>
      <Metric label="Permanent impact" value={bps1(im.permanentBps)} delta={pctPerm==null?"≥30s tail":`${pctPerm.toFixed(0)}% of peak`} icon={Activity}/>
      <Metric label="Decay τ" value={tau==null?"—":`${tau.toFixed(1)}s`} delta="to peak / e" icon={Gauge}/>
      <Metric label="Grid samples" value={s.imSamples!=null?Number(s.imSamples).toLocaleString():"—"} delta={`${s.imOrders ?? 0} orders`} icon={Database}/>
    </div>

    <section className="panel p-4">
      <div className="mb-1 font-semibold">Market impact decay</div>
      <div className="mb-3 text-xs text-slate-500">mid move in the order's direction around arrival, −10s to +60s · bps (adverse +)</div>
      <DecayChart data={curve} dataKey="impactBps" color="#22d3ee" label="impact"/>
    </section>

    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">By symbol <span className="text-xs text-slate-500">recent order flow</span></div>
      <table className="w-full text-left text-xs">
        <thead className="bg-[#0a121a] text-slate-500"><tr>{["Symbol","Temporary","Permanent","Orders"].map(h=><th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {bySym.map(r=><tr key={r.sym} className="border-t border-slate-800/60 hover:bg-slate-900/50">
            <td className="px-4 py-1.5 font-semibold text-slate-200">{r.sym}</td>
            <td className="px-4 py-1.5 tabular-nums text-cyan-300">{bps1(r.peakBps)}</td>
            <td className="px-4 py-1.5 tabular-nums text-slate-300">{bps1(r.permanentBps)}</td>
            <td className="px-4 py-1.5 tabular-nums text-slate-400">{r.orders}</td>
          </tr>)}
          {data && !bySym.length && <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-600">no completed impact offsets yet</td></tr>}
        </tbody>
      </table>
    </section>
  </div>;
}

// ---- Spreads (build-up attribution) --------------------------------
const SPREAD_COMPONENTS = [
  { key: "refSprd",      label: "Reference",   color: "#22d3ee" },
  { key: "baseSprd",     label: "Base markup", color: "#34d399" },
  { key: "clientSprd",   label: "Client tier", color: "#a78bfa" },
  { key: "volSprd",      label: "Volatility",  color: "#f59e0b" },
  { key: "smoothSprd",   label: "Smoothing",   color: "#38bdf8" },
  { key: "fallbackSprd", label: "Fallback",    color: "#fb923c" },
  { key: "alphaSprd",    label: "Alpha / signal", color: "#f43f5e" },
];
const bps2 = (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(2)} bps`);

function Spreads() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/spread", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const s = data?.summary || {};
  const attr = data?.attribution || [];
  const bySym = data?.bySym || [];
  const byRegime = data?.byRegime || [];
  const widest = data?.widest || [];

  const attrMaxPct = Math.max(1, ...attr.map(a => Math.abs(a.pctOfTotal || 0)));
  const symChartData = bySym.map(r => ({ sym: r.sym, ...r.components }));
  const dominant = attr.reduce((m,a)=> (Math.abs(a.valueBps||0) > Math.abs(m?.valueBps||0) ? a : m), null);

  // regime grid
  const aggs = [...new Set(byRegime.map(r=>r.aggression))];
  const mkts = [...new Set(byRegime.map(r=>r.marketStatus))];
  const cell = (a,m) => byRegime.find(r=>r.aggression===a && r.marketStatus===m)?.totalBps;
  const regMax = Math.max(1, ...byRegime.map(r=>r.totalBps||0));

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">quoted-spread build-up &amp; attribution · <span className="text-slate-500">spread module CEP via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400">
        <input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh
      </label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900">
        <RefreshCw size={12}/> refresh
      </button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
      {GW}/api/spread — {err}
      <div className="mt-1 text-rose-400/70">needs the spread module running + a feeder (gateway/tools/spread-feeder.js) and OPENQ_SPREAD_CEP set.</div>
    </div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Keys quoting" value={String(s.keys ?? "—")} delta={`${s.syms ?? 0} symbols`} icon={TrendingDown}/>
      <Metric label="Mean spread" value={bps2(s.meanBps)} delta="weighted, all keys" icon={Activity}/>
      <Metric label="Widest key" value={bps2(s.widestBps)} delta="current snapshot" icon={TrendingUp}/>
      <Metric label="Largest component" value={dominant ? SPREAD_COMPONENTS.find(c=>c.key===dominant.component)?.label ?? dominant.component : "—"} delta={dominant ? `${bps2(dominant.valueBps)} · ${dominant.pctOfTotal?.toFixed(0)}%` : ""} icon={Gauge}/>
    </div>

    <section className="panel p-4">
      <div className="mb-3 font-semibold">Spread build-up <span className="text-xs text-slate-500">weighted across all keys — reference → quoted</span></div>
      <div className="space-y-2.5">
        {SPREAD_COMPONENTS.map(c => {
          const a = attr.find(x => x.component === c.key) || {};
          const pct = a.pctOfTotal ?? 0;
          const w = Math.min(100, (Math.abs(pct) / attrMaxPct) * 100);
          return <div key={c.key} className="flex items-center gap-3 text-xs">
            <div className="w-28 shrink-0 text-slate-400">{c.label}</div>
            <div className="relative h-3 flex-1 rounded bg-slate-800">
              <div className="absolute inset-y-0 rounded" style={{width:`${w}%`, background:c.color, opacity: pct<0?0.45:1, left: pct<0?`${100-w}%`:0}}/>
            </div>
            <div className="w-20 shrink-0 text-right tabular-nums text-slate-300">{a.valueBps==null?"—":a.valueBps.toFixed(3)}</div>
            <div className="w-14 shrink-0 text-right tabular-nums text-slate-500">{pct==null?"":`${pct.toFixed(1)}%`}</div>
          </div>;
        })}
      </div>
    </section>

    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <section className="panel p-4">
        <div className="mb-3 flex justify-between"><div className="font-semibold">By symbol</div><span className="badge bg-slate-800 text-slate-400">bps · stacked</span></div>
        <div className="h-72"><ResponsiveContainer width="100%" height="100%">
          <BarChart data={symChartData} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#1e2b36" vertical={false}/>
            <XAxis dataKey="sym" stroke="#566673" fontSize={10}/>
            <YAxis stroke="#566673" fontSize={10} width={40}/>
            <Tooltip contentStyle={{background:"#0b151e",border:"1px solid #263746",fontSize:12}}
              formatter={(v,n)=>[`${Number(v).toFixed(3)} bps`, SPREAD_COMPONENTS.find(c=>c.key===n)?.label ?? n]}/>
            {SPREAD_COMPONENTS.map(c=>
              <Bar key={c.key} dataKey={c.key} stackId="s" fill={c.color} isAnimationActive={false}/>)}
          </BarChart>
        </ResponsiveContainer></div>
      </section>

      <section className="panel p-4">
        <div className="mb-3 font-semibold">By regime</div>
        <div className="text-xs">
          <div className="grid" style={{gridTemplateColumns:`5rem repeat(${mkts.length}, 1fr)`}}>
            <div/>
            {mkts.map(m => <div key={m} className="pb-1 text-center text-[10px] uppercase tracking-wider text-slate-500">{m}</div>)}
            {aggs.map(a => <React.Fragment key={a}>
              <div className="flex items-center text-[10px] uppercase tracking-wider text-slate-500">{a}</div>
              {mkts.map(m => {
                const v = cell(a,m);
                return <div key={a+m} className="m-0.5 rounded px-2 py-3 text-center tabular-nums text-slate-100"
                  style={{background:`rgba(34,211,238,${v==null?0:0.12+0.6*(v/regMax)})`}}>
                  {v==null ? "—" : v.toFixed(2)}
                </div>;
              })}
            </React.Fragment>)}
          </div>
          <div className="mt-2 text-[10px] text-slate-600">weighted total spread (bps) per aggression × market status</div>
        </div>
      </section>
    </div>

    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">Widest right now</div>
      <table className="w-full text-left text-xs">
        <thead className="bg-[#0a121a] text-slate-500"><tr>{["Symbol","Aggression","Market status","Total","Age"].map(h=><th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {widest.map((w,i)=>
            <tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="px-4 py-1.5 font-semibold text-slate-200">{w.sym}</td>
              <td className="px-4 py-1.5"><span className="badge bg-slate-800 text-slate-400">{w.aggression}</span></td>
              <td className="px-4 py-1.5"><span className={`badge ${w.marketStatus==="stressed"?"bg-rose-950 text-rose-300":"bg-slate-800 text-slate-400"}`}>{w.marketStatus}</span></td>
              <td className="px-4 py-1.5 tabular-nums text-cyan-300">{bps2(w.totalBps)}</td>
              <td className="px-4 py-1.5 text-slate-500">{w.ageSec==null?"—":`${w.ageSec.toFixed(1)}s`}</td>
            </tr>)}
          {data && !widest.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-600">no spread quotes yet — is the feeder running?</td></tr>}
        </tbody>
      </table>
    </section>
  </div>;
}

// ---- Desk Risk & TCA (report module) ------------------------------
const DR_COMPONENTS = [
  { key: "spreadCostBp",   label: "Spread",    color: "#22d3ee" },
  { key: "markoutBp",      label: "Markout",   color: "#a78bfa" },
  { key: "impactBp",       label: "Impact",    color: "#f59e0b" },
  { key: "financingFeeBp", label: "Financing", color: "#f43f5e" },
];
const DR_BUCKET_BADGE = {
  FULL: "bg-emerald-950 text-emerald-300", PARTIAL: "bg-cyan-950 text-cyan-300",
  AT_RISK: "bg-amber-950 text-amber-300", UNLOCATED: "bg-rose-950 text-rose-300",
};
const bpCell = (v) => (v == null ? <span className="text-slate-600">—</span> : <span className={v < 0 ? "text-emerald-400" : "text-slate-300"}>{v.toFixed(2)}</span>);

function DeskRisk() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/report", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const rows = data?.rows || [];
  const t = data?.totals || {};
  const byBucket = data?.byBucket || [];

  // top symbols by all-in cost, magnitude of each component for the stacked bar
  const chartRows = rows
    .filter(r => r.allInBp != null)
    .slice(0, 10)
    .map(r => ({ sym: r.sym, ...Object.fromEntries(DR_COMPONENTS.map(c => [c.key, Math.abs(r[c.key] || 0)])) }));

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">desk risk &amp; TCA · spread + markout + financing per symbol · <span className="text-slate-500">report module CEP (60s recompute)</span></span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/report — {err}
      <div className="mt-1 text-rose-400/70">needs the report module running (startupAllByModule.sh report) and OPENQ_REPORT_CEP set.</div></div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Symbols" value={String(t.syms ?? "—")} delta="in the desk report" icon={ListFilter}/>
      <Metric label="Short exposure" value={fmtCount(t.shortQty)} delta={`${fmtCount(t.locatedQty)} located`} icon={CircleDollarSign}/>
      <Metric label="Avg all-in cost" value={t.avgAllInBp==null?"—":`${t.avgAllInBp.toFixed(1)} bps`} delta={t.maxAllInBp==null?"":`max ${t.maxAllInBp.toFixed(0)} bps`} icon={Gauge}/>
      <Metric label="At-risk names" value={String(t.atRisk ?? 0)} delta="AT_RISK / UNLOCATED" icon={ShieldCheck}/>
    </div>

    <section className="panel p-4">
      <div className="mb-3 flex justify-between"><div className="font-semibold">All-in cost by symbol</div><span className="badge bg-slate-800 text-slate-400">|bps| · stacked</span></div>
      <div className="h-72"><ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartRows} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
          <CartesianGrid stroke="#1e2b36" horizontal={false}/>
          <XAxis type="number" stroke="#566673" fontSize={10}/>
          <YAxis type="category" dataKey="sym" stroke="#566673" fontSize={10} width={56}/>
          <Tooltip contentStyle={{background:"#0b151e",border:"1px solid #263746",fontSize:12}}
            formatter={(v,n)=>[`${Number(v).toFixed(2)} bps`, DR_COMPONENTS.find(c=>c.key===n)?.label ?? n]}/>
          <Legend wrapperStyle={{fontSize:10}}/>
          {DR_COMPONENTS.map(c=><Bar key={c.key} dataKey={c.key} name={c.key} stackId="c" fill={c.color} isAnimationActive={false}/>)}
        </BarChart>
      </ResponsiveContainer></div>
      <div className="mt-1 text-[10px] text-slate-600">financing fee dominates the borrow-heavy names; execution costs (spread/markout/impact) are single-digit bps</div>
    </section>

    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">Desk risk report <span className="text-xs text-slate-500">per symbol</span></div>
      <div className="max-h-[52vh] overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Symbol","Spread","Markout","Impact","Financing","All-in","Short","Coverage","Bucket"].map(h=><th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody className="tabular-nums">
            {rows.map(r=><tr key={r.sym} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="px-3 py-1.5 font-mono font-semibold text-slate-200">{r.sym}</td>
              <td className="px-3 py-1.5">{bpCell(r.spreadCostBp)}</td>
              <td className="px-3 py-1.5">{bpCell(r.markoutBp)}</td>
              <td className="px-3 py-1.5">{bpCell(r.impactBp)}</td>
              <td className="px-3 py-1.5">{bpCell(r.financingFeeBp)}</td>
              <td className="px-3 py-1.5 font-semibold text-cyan-300">{r.allInBp==null?"—":r.allInBp.toFixed(1)}</td>
              <td className="px-3 py-1.5 text-slate-400">{r.shortQty==null?"—":r.shortQty.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-slate-300">{r.coverage==null?"—":`${(r.coverage*100).toFixed(0)}%`}</td>
              <td className="px-3 py-1.5">{r.bucket ? <span className={`badge ${DR_BUCKET_BADGE[r.bucket]||"bg-slate-800 text-slate-400"}`}>{r.bucket}</span> : <span className="text-slate-600">—</span>}</td>
            </tr>)}
            {data && !rows.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-600">report is empty — is any upstream module feeding data?</td></tr>}
          </tbody>
        </table>
      </div>
      {byBucket.length > 0 && <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-800 px-4 py-2 text-xs">
        {byBucket.map(b => <span key={b.bucket} className="flex items-center gap-1.5">
          <span className={`badge ${DR_BUCKET_BADGE[b.bucket]||"bg-slate-800 text-slate-500"}`}>{b.bucket}</span>
          <span className="tabular-nums text-slate-300">{b.syms}</span>
          <span className="tabular-nums text-slate-600">{fmtCount(b.shortQty)}</span>
        </span>)}
      </div>}
    </section>
  </div>;
}

// ---- Prime Finance (securities lending) ----------------------------
const PF_BUCKETS = [
  { key: "FULL",      label: "Full",      color: "#34d399" },
  { key: "PARTIAL",   label: "Partial",   color: "#22d3ee" },
  { key: "AT_RISK",   label: "At risk",   color: "#f59e0b" },
  { key: "UNLOCATED", label: "Unlocated", color: "#f43f5e" },
];
const PF_BUCKET_BADGE = {
  FULL: "bg-emerald-950 text-emerald-300", PARTIAL: "bg-cyan-950 text-cyan-300",
  AT_RISK: "bg-amber-950 text-amber-300", UNLOCATED: "bg-rose-950 text-rose-300",
};
const PF_SEV_BADGE = {
  CRITICAL: "bg-rose-950 text-rose-300", HIGH: "bg-amber-950 text-amber-300",
  MEDIUM: "bg-slate-800 text-slate-300", LOW: "bg-slate-900 text-slate-500",
};
const pct1 = (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(1)}%`);

function PrimeFinance() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/prime", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const s = data?.summary || {};
  const cov = [...(data?.coverage || [])].sort((a,b)=>a.coverage-b.coverage);
  const byBucket = data?.coverageByBucket || [];
  const inv = [...(data?.inventory || [])];
  const htb = data?.htb || [];
  const htbBySym = Object.fromEntries(htb.map(h=>[h.sym,h.score]));
  const invSorted = inv.sort((a,b)=>(htbBySym[b.sym]||0)-(htbBySym[a.sym]||0));
  const alerts = data?.alerts || [];
  const recalls = data?.recalls || [];
  const buyins = data?.buyins || [];

  const bucketTotal = Math.max(1, byBucket.reduce((a,b)=>a+b.shortQty,0));
  const maxAvail = Math.max(1, ...inv.map(r=>r.available));

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">securities finance · locate coverage &amp; borrow economics · <span className="text-slate-500">primefinance CEP via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/prime — {err}
      <div className="mt-1 text-rose-400/70">needs the primefinance module running + a feeder (gateway/tools/prime-feeder.js) and OPENQ_PRIME_CEP set.</div></div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Short exposure" value={s.shortValue != null ? fmtUsd(s.shortValue) : fmtCount(s.shortQty)} delta={s.shortValue != null ? `${fmtCount(s.shortQty)} shares · real mark` : `${fmtCount(s.availQty)} lendable`} icon={CircleDollarSign}/>
      <Metric label="Locate coverage" value={pct1(s.coveragePct)} delta="located ÷ short" icon={ShieldCheck}/>
      <Metric label="Locate fill" value={pct1(s.locateFillPct)} delta={`${s.openLocates ?? 0} open locates`} icon={ListFilter}/>
      <Metric label="Risk events" value={String((s.openBuyins ?? 0) + (s.alerts ?? 0))} delta={`${s.openBuyins ?? 0} buy-ins · ${s.alerts ?? 0} alerts`} icon={ShieldCheck}/>
    </div>

    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold">Locate coverage <span className="text-xs text-slate-500">short quantity by coverage bucket</span></div>
      </div>
      <div className="mb-3 flex h-4 w-full overflow-hidden rounded">
        {PF_BUCKETS.map(b => {
          const row = byBucket.find(x=>x.bucket===b.key);
          const w = row ? (row.shortQty / bucketTotal) * 100 : 0;
          return w > 0 ? <div key={b.key} style={{width:`${w}%`, background:b.color}} title={`${b.label}: ${row.shortQty.toLocaleString()}`}/> : null;
        })}
      </div>
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        {PF_BUCKETS.map(b => {
          const row = byBucket.find(x=>x.bucket===b.key) || { pairs:0, shortQty:0 };
          return <div key={b.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{background:b.color}}/>
            <span className="text-slate-400">{b.label}</span>
            <span className="tabular-nums text-slate-300">{row.pairs}</span>
            <span className="tabular-nums text-slate-600">{fmtCount(row.shortQty)}</span>
          </div>;
        })}
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Client","Symbol","Short","Located","Coverage","Bucket","Ccy","Short value (real)","Unrealized P&L"].map(h=><th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {cov.map((r,i)=><tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="px-3 py-1.5 font-semibold text-slate-200">{r.client}</td>
              <td className="px-3 py-1.5 font-mono text-cyan-300">{r.sym}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-300">{r.shortQty.toLocaleString()}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{r.locatedQty.toLocaleString()}</td>
              <td className="px-3 py-1.5 tabular-nums">{pct1(r.coverage*100)}</td>
              <td className="px-3 py-1.5"><span className={`badge ${PF_BUCKET_BADGE[r.bucket]||"bg-slate-800 text-slate-400"}`}>{r.bucket}</span></td>
              <td className="px-3 py-1.5 text-slate-500">{r.ccy || "—"}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{fmtMoney(r.shortValue, r.ccy)}</td>
              <td className={`px-3 py-1.5 tabular-nums font-semibold ${pnlTone(r.unrealizedPnl)}`}>{fmtMoney(r.unrealizedPnl, r.ccy, { plus: true })}</td>
            </tr>)}
            {data && !cov.length && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-600">no short positions</td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
      <section className="panel overflow-hidden">
        <div className="border-b border-slate-800 px-4 py-3 font-semibold">Inventory &amp; hard-to-borrow <span className="text-xs text-slate-500">by symbol · HTB blends real market data when available</span></div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Symbol","Available","Fee","Real vol pctile","Real ADV pctile","Lenders","HTB"].map(h=><th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {invSorted.map(r=>{
                const score = htbBySym[r.sym] || 0;
                const real = r.volPctile != null && r.advPctile != null;
                return <tr key={r.sym} className="border-t border-slate-800/60 hover:bg-slate-900/50">
                  <td className="px-3 py-1.5 font-mono font-semibold text-slate-200">{r.sym}</td>
                  <td className="px-3 py-1.5"><div className="flex items-center gap-2"><span className="w-14 tabular-nums text-slate-300">{fmtCount(r.available)}</span><div className="h-1.5 w-14 rounded bg-slate-800"><div className="h-full rounded bg-cyan-500/70" style={{width:`${(r.available/maxAvail)*100}%`}}/></div></div></td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-300">{r.feeBp==null?"—":`${r.feeBp.toFixed(0)} bp`}</td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-400">{r.volPctile==null?"—":pct0(r.volPctile)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-400">{r.advPctile==null?"—":pct0(r.advPctile)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-500">{r.lenders}</td>
                  <td className="px-3 py-1.5"><div className="flex items-center gap-1.5"><div className="h-1.5 w-12 rounded bg-slate-800"><div className="h-full rounded" style={{width:`${score*100}%`, background: score>0.6?"#f43f5e":score>0.35?"#f59e0b":"#64748b"}}/></div><span className="tabular-nums text-slate-400">{score.toFixed(2)}</span>{real && <span title="blended with real eq_d1_yfinance vol/ADV" className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>}</div></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel p-4">
        <div className="mb-3 font-semibold">Recalls &amp; buy-ins</div>
        <div className="space-y-3 text-xs">
          <div>
            <div className="mb-1 text-slate-500">Recalls by severity</div>
            {recalls.length ? recalls.map(r=><div key={r.severity} className="flex justify-between py-0.5">
              <span><span className={`badge ${PF_SEV_BADGE[r.severity]||"bg-slate-800 text-slate-400"}`}>{r.severity}</span></span>
              <span className="tabular-nums text-slate-300">{fmtCount(r.qty)} <span className="text-slate-600">/ {r.n}</span></span>
            </div>) : <div className="text-slate-600">none</div>}
          </div>
          <div className="border-t border-slate-800 pt-3">
            <div className="mb-1 text-slate-500">Buy-ins</div>
            {buyins.length ? buyins.map(b=><div key={b.status} className="flex justify-between py-0.5">
              <span className="text-slate-300">{b.status}</span>
              <span className="tabular-nums text-slate-300">{fmtCount(b.qty)} <span className="text-slate-600">/ {b.n}</span></span>
            </div>) : <div className="text-slate-600">none open</div>}
          </div>
        </div>
      </section>
    </div>

    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">Alerts <span className="text-xs text-slate-500">recent</span></div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Time","Severity","Kind","Client","Symbol","Qty","Message"].map(h=><th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {alerts.map((a,i)=><tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{a.timestamp ? String(a.timestamp).slice(11,19) : "—"}</td>
              <td className="px-3 py-1.5"><span className={`badge ${PF_SEV_BADGE[a.severity]||"bg-slate-800 text-slate-400"}`}>{a.severity}</span></td>
              <td className="px-3 py-1.5 font-mono text-slate-300">{a.kind}</td>
              <td className="px-3 py-1.5 text-slate-300">{a.client}</td>
              <td className="px-3 py-1.5 font-mono text-cyan-300">{a.sym}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{a.qty?.toLocaleString?.() ?? a.qty}</td>
              <td className="px-3 py-1.5 text-slate-500">{a.message}</td>
            </tr>)}
            {data && !alerts.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-600">no alerts</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

// ---- Borrow Fee Calibration (feeBp vs. real vol/ADV) -----------------
const CAL_FLAG_COLOR = { RICH: "#f43f5e", CHEAP: "#22d3ee", FAIR: "#64748b" };
const CAL_FLAG_BADGE = {
  RICH: "bg-rose-950 text-rose-300", CHEAP: "bg-cyan-950 text-cyan-300", FAIR: "bg-slate-800 text-slate-400",
};
const bp0 = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString());
const bpSigned = (v) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString()}`);
const pct0 = (v) => (v == null || !isFinite(v) ? "—" : `${Math.round(v * 100)}%`);

function CalRankList({ title, rows, tone }) {
  return <div>
    <div className="mb-1.5 flex items-center justify-between text-xs">
      <span className="text-slate-500">{title}</span>
      <span className="text-slate-600">vs. model-implied fee</span>
    </div>
    <div className="space-y-1">
      {rows.length ? rows.map((r, i) => <div key={i} className="flex items-center justify-between rounded bg-slate-900/50 px-2 py-1.5 text-xs">
        <span className="flex items-center gap-2">
          <span className="font-mono font-semibold text-slate-200">{r.sym}</span>
          <span className="text-slate-600">{r.lender}</span>
        </span>
        <span className="flex items-center gap-2 tabular-nums">
          <span className="text-slate-500">{bp0(r.feeBp)}bp vs {bp0(r.expectedFeeBp)}bp</span>
          <span className={tone === "rich" ? "font-semibold text-rose-400" : "font-semibold text-cyan-400"}>{bpSigned(r.richCheapBp)}bp</span>
        </span>
      </div>) : <div className="rounded bg-slate-900/50 px-2 py-3 text-center text-xs text-slate-600">none</div>}
    </div>
  </div>;
}

function CalScatterTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const r = payload[0].payload;
  return <div className="rounded border border-slate-700 bg-[#0b151e] px-3 py-2 text-xs shadow-lg">
    <div className="mb-1 flex items-center gap-2 font-mono font-semibold text-slate-100">{r.sym} <span className="font-sans font-normal text-slate-500">{r.lender}</span></div>
    <div className="space-y-0.5 text-slate-400">
      <div>quoted <span className="tabular-nums text-slate-200">{bp0(r.feeBp)}bp</span> vs model <span className="tabular-nums text-slate-200">{bp0(r.expectedFeeBp)}bp</span></div>
      <div>realized vol pctile <span className="tabular-nums text-slate-200">{pct0(r.volPctile)}</span> · ADV pctile <span className="tabular-nums text-slate-200">{pct0(r.advPctile)}</span></div>
      <div className={r.flag === "RICH" ? "text-rose-400" : r.flag === "CHEAP" ? "text-cyan-400" : "text-slate-500"}>{r.flag} · {bpSigned(r.richCheapBp)}bp vs model</div>
    </div>
  </div>;
}

function BorrowFeeCalibration() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [auto, setAuto] = useState(true);
  const [updated, setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/prime", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [auto, load]);

  const cal = data?.calibration || [];
  const rich = [...cal].filter(r => r.flag === "RICH").sort((a, b) => b.richCheapBp - a.richCheapBp);
  const cheap = [...cal].filter(r => r.flag === "CHEAP").sort((a, b) => a.richCheapBp - b.richCheapBp);
  const fair = cal.filter(r => r.flag === "FAIR").length;
  const avgRichCheap = cal.length ? cal.reduce((a, r) => a + r.richCheapBp, 0) / cal.length : null;
  const domain = useMemo(() => {
    const vals = cal.flatMap(r => [r.feeBp, r.expectedFeeBp]).filter(v => isFinite(v));
    if (!vals.length) return [0, 100];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max(10, (hi - lo) * 0.08);
    return [Math.max(0, lo - pad), hi + pad];
  }, [cal]);

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">borrow-fee calibration · quoted feeBp vs. realized-vol/ADV model, real market data · <span className="text-slate-500">primefinance CEP via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/> auto-refresh</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/prime — {err}</div>}
    {data && !cal.length && <div className="panel p-8 text-center text-sm text-slate-500">
      No calibration data yet.<br/>
      <span className="text-xs text-slate-600">Needs .prime.inventory populated and the CEP's periodic refresh (or eq_hdb at -eqhdbaddr) to have run at least once.</span>
    </div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Calibrated lines" value={String(cal.length)} delta={`${new Set(cal.map(r=>r.sym)).size} symbol(s)`} icon={Gauge}/>
      <Metric label="Rich (overpriced)" value={String(rich.length)} delta="above model fee" icon={TrendingUp}/>
      <Metric label="Cheap (underpriced)" value={String(cheap.length)} delta="below model fee" icon={TrendingDown}/>
      <Metric label="Avg vs. model" value={bpSigned(avgRichCheap)} delta={`${fair} within threshold`} icon={CircleDollarSign}/>
    </div>

    <section className="panel p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="font-semibold">Quoted fee vs. model-implied fee <span className="text-xs text-slate-500">bubble size = ADV</span></div>
      </div>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {Object.entries(CAL_FLAG_COLOR).map(([k, c]) => <div key={k} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: c }}/><span className="text-slate-400">{k}</span>
        </div>)}
        <div className="flex items-center gap-1.5 text-slate-600"><span className="h-px w-4 border-t border-dashed border-slate-500"/> parity (quoted = model)</div>
      </div>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1e2b36"/>
            <XAxis type="number" dataKey="expectedFeeBp" name="Model fee" unit="bp" domain={domain} stroke="#566673" fontSize={10}/>
            <YAxis type="number" dataKey="feeBp" name="Quoted fee" unit="bp" domain={domain} stroke="#566673" fontSize={10}/>
            <ZAxis type="number" dataKey="adv" range={[50, 500]} name="ADV"/>
            <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<CalScatterTooltip/>}/>
            <ReferenceLine segment={[{ x: domain[0], y: domain[0] }, { x: domain[1], y: domain[1] }]} stroke="#566673" strokeDasharray="4 4"/>
            <Scatter data={cal} fillOpacity={0.85}>
              {cal.map((r, i) => <Cell key={i} fill={CAL_FLAG_COLOR[r.flag] || "#64748b"}/>)}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </section>

    <div className="grid gap-4 xl:grid-cols-2">
      <section className="panel p-4"><CalRankList title="Richest — most overpriced vs. model" rows={rich.slice(0, 8)} tone="rich"/></section>
      <section className="panel p-4"><CalRankList title="Cheapest — most underpriced vs. model" rows={cheap.slice(0, 8)} tone="cheap"/></section>
    </div>

    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">All calibrated lines <span className="text-xs text-slate-500">by (symbol, lender)</span></div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Symbol", "Ccy", "Lender", "Quoted", "Model", "vs. Model", "Vol pctile", "ADV pctile", "Flag"].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {[...cal].sort((a, b) => b.richCheapBp - a.richCheapBp).map((r, i) => <tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="px-3 py-1.5 font-mono font-semibold text-slate-200">{r.sym}</td>
              <td className="px-3 py-1.5 text-slate-500">{r.ccy || "—"}</td>
              <td className="px-3 py-1.5 text-slate-400">{r.lender}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-300">{bp0(r.feeBp)}bp</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-500">{bp0(r.expectedFeeBp)}bp</td>
              <td className={`px-3 py-1.5 tabular-nums font-semibold ${r.richCheapBp > 0 ? "text-rose-400" : r.richCheapBp < 0 ? "text-cyan-400" : "text-slate-500"}`}>{bpSigned(r.richCheapBp)}bp</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-500">{pct0(r.volPctile)}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-500">{pct0(r.advPctile)}</td>
              <td className="px-3 py-1.5"><span className={`badge ${CAL_FLAG_BADGE[r.flag] || "bg-slate-800 text-slate-400"}`}>{r.flag}</span></td>
            </tr>)}
            {data && !cal.length && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-600">no calibration data</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

// ---- Position Risk / P&L (real mark-to-market) ------------------------
const fmtUsd = (v, opts = {}) => {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  const s = abs >= 1e9 ? `${(abs / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(abs / 1e6).toFixed(2)}M`
    : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}k` : abs.toFixed(0);
  return `${v < 0 ? "-" : opts.plus ? "+" : ""}$${s}`;
};
const pnlTone = (v) => (v == null ? "text-slate-500" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-slate-400");
// Currency-aware money formatter - HKD/JPY are real (from eq_m1_yfinance),
// never converted to USD (no real FX-rate feed in this repo), so they get
// their own symbol rather than being silently prefixed with "$".
const CCY_SYMBOL = { USD: "$", HKD: "HK$", JPY: "¥" };
const fmtMoney = (v, ccy, opts = {}) => {
  if (v == null || !isFinite(v)) return "—";
  const sym = CCY_SYMBOL[ccy] || "";
  const abs = Math.abs(v);
  const s = abs >= 1e9 ? `${(abs / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(abs / 1e6).toFixed(2)}M`
    : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}k` : abs.toFixed(0);
  return `${v < 0 ? "-" : opts.plus ? "+" : ""}${sym}${s}`;
};

function PositionRisk() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [auto, setAuto] = useState(true);
  const [updated, setUpdated] = useState(null);
  const [groupBy, setGroupBy] = useState("client"); // "client" | "sym"

  const load = useCallback(() => {
    fetch(new URL("/api/prime", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [auto, load]);

  const rows = data?.positionRisk || [];
  const withMark = rows.filter(r => r.currentPx != null);
  // $ aggregates are USD-only: this book now holds real HKD (HKEX) / JPY
  // (Nikkei) positions alongside USD ones, and there's no real FX-rate feed
  // here to convert them with - summing raw HKD/JPY numbers into a "$"
  // total would silently misstate it. Non-USD positions still show fully
  // in the table below, each in its own real currency.
  const usd = withMark.filter(r => r.ccy === "USD");
  const nonUsd = withMark.filter(r => r.ccy && r.ccy !== "USD");
  const grossShort = usd.filter(r => r.qty < 0).reduce((a, r) => a + Math.abs(r.marketValue), 0);
  const grossLong = usd.filter(r => r.qty > 0).reduce((a, r) => a + Math.abs(r.marketValue), 0);
  const netExposure = usd.reduce((a, r) => a + (r.marketValue || 0), 0);
  const totalPnl = usd.reduce((a, r) => a + (r.unrealizedPnl || 0), 0);
  const winners = withMark.filter(r => r.unrealizedPnl > 0).length;
  const losers = withMark.filter(r => r.unrealizedPnl < 0).length;

  const pnlByGroup = useMemo(() => {
    const key = groupBy === "client" ? "client" : "sym";
    const m = new Map();
    for (const r of usd) m.set(r[key], (m.get(r[key]) || 0) + (r.unrealizedPnl || 0));
    return [...m.entries()].map(([name, pnl]) => ({ name, pnl })).sort((a, b) => b.pnl - a.pnl);
  }, [usd, groupBy]);

  const sorted = [...rows].sort((a, b) => (a.unrealizedPnl ?? 0) - (b.unrealizedPnl ?? 0));

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">position risk · real mark-to-market vs. avgPx · <span className="text-slate-500">primefinance CEP via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/> auto-refresh</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/prime — {err}</div>}
    {data && !rows.length && <div className="panel p-8 text-center text-sm text-slate-500">
      No positions yet.<br/>
      <span className="text-xs text-slate-600">Needs .prime.positions populated and the CEP's periodic market-data refresh (or eq_hdb at -eqhdbaddr) to have run at least once.</span>
    </div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Unrealized P&L (USD)" value={fmtUsd(totalPnl, { plus: true })} delta={`${winners} up · ${losers} down`} icon={totalPnl >= 0 ? TrendingUp : TrendingDown}/>
      <Metric label="Gross short (USD)" value={fmtUsd(grossShort)} delta={`${usd.filter(r=>r.qty<0).length} position(s)`} icon={TrendingDown}/>
      <Metric label="Gross long (USD)" value={fmtUsd(grossLong)} delta={`${usd.filter(r=>r.qty>0).length} position(s)`} icon={TrendingUp}/>
      <Metric label="Net exposure (USD)" value={fmtUsd(netExposure, { plus: true })} delta="long − short, $" icon={CircleDollarSign}/>
    </div>
    {nonUsd.length > 0 && <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-500">
      {nonUsd.length} position(s) in HKD/JPY not included above (no real FX-rate feed to convert with) — shown in their own currency in the table below.
    </div>}

    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold">Unrealized P&L (USD) <span className="text-xs text-slate-500">by {groupBy === "client" ? "client" : "symbol"}</span></div>
        <div className="flex gap-1 rounded border border-slate-800 p-0.5 text-xs">
          {["client", "sym"].map(k => <button key={k} onClick={() => setGroupBy(k)}
            className={`rounded px-2 py-1 font-semibold ${groupBy === k ? "bg-cyan-400 text-slate-950" : "text-slate-400 hover:bg-slate-900"}`}>{k === "client" ? "Client" : "Symbol"}</button>)}
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={pnlByGroup} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1e2b36" vertical={false}/>
            <XAxis dataKey="name" stroke="#566673" fontSize={10}/>
            <YAxis stroke="#566673" fontSize={10} tickFormatter={(v) => fmtUsd(v)}/>
            <Tooltip formatter={(v) => fmtUsd(v, { plus: true })} contentStyle={{ background: "#0b151e", border: "1px solid #263746" }}/>
            <ReferenceLine y={0} stroke="#3a4b58"/>
            <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
              {pnlByGroup.map((r, i) => <Cell key={i} fill={r.pnl >= 0 ? "#34d399" : "#f43f5e"}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>

    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">Positions <span className="text-xs text-slate-500">by (client, symbol) · worst P&L first</span></div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Client", "Symbol", "Ccy", "Side", "Qty", "Avg px", "Current px", "Market value", "Unrealized P&L", "P&L %"].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {sorted.map((r, i) => <tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="px-3 py-1.5 font-semibold text-slate-200">{r.client}</td>
              <td className="px-3 py-1.5 font-mono text-cyan-300">{r.sym}</td>
              <td className="px-3 py-1.5 text-slate-500">{r.ccy || "—"}</td>
              <td className={`px-3 py-1.5 font-semibold ${r.side === "SHORT" ? "text-rose-400" : "text-emerald-400"}`}>{r.side}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-300">{r.qty.toLocaleString()}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{r.avgPx == null ? "—" : r.avgPx.toFixed(2)}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-300">{r.currentPx == null ? "—" : r.currentPx.toFixed(2)}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{fmtMoney(r.marketValue, r.ccy)}</td>
              <td className={`px-3 py-1.5 tabular-nums font-semibold ${pnlTone(r.unrealizedPnl)}`}>{fmtMoney(r.unrealizedPnl, r.ccy, { plus: true })}</td>
              <td className={`px-3 py-1.5 tabular-nums font-semibold ${pnlTone(r.pnlPct)}`}>{r.pnlPct == null ? "—" : `${r.pnlPct > 0 ? "+" : ""}${(r.pnlPct * 100).toFixed(1)}%`}</td>
            </tr>)}
            {data && !rows.length && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-600">no positions</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

// ---- Short-Interest Concentration / Crowding ---------------------------
const CROWD_BUCKET_COLOR = { LOW: "#34d399", MODERATE: "#22d3ee", HIGH: "#f59e0b", EXTREME: "#f43f5e", UNKNOWN: "#64748b" };
const CROWD_BUCKET_BADGE = {
  LOW: "bg-emerald-950 text-emerald-300", MODERATE: "bg-cyan-950 text-cyan-300",
  HIGH: "bg-amber-950 text-amber-300", EXTREME: "bg-rose-950 text-rose-300", UNKNOWN: "bg-slate-800 text-slate-500",
};
const dtcStr = (v) => (v == null || !isFinite(v) ? "—" : v < 0.01 ? "<0.01d" : `${v.toFixed(v < 10 ? 2 : 0)}d`);

function CrowdTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const r = payload[0].payload;
  return <div className="rounded border border-slate-700 bg-[#0b151e] px-3 py-2 text-xs shadow-lg">
    <div className="mb-1 font-mono font-semibold text-slate-100">{r.sym}</div>
    <div className="space-y-0.5 text-slate-400">
      <div>short <span className="tabular-nums text-slate-200">{r.shortQty.toLocaleString()}</span> across <span className="tabular-nums text-slate-200">{r.numClients}</span> client(s)</div>
      <div>{fmtMoney(r.shortValue, r.ccy)} · ADV {fmtCount(r.adv)}</div>
      <div className="font-semibold" style={{ color: CROWD_BUCKET_COLOR[r.bucket] }}>{dtcStr(r.daysToCover)} to cover · {r.bucket}</div>
    </div>
  </div>;
}

function Crowding() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [auto, setAuto] = useState(true);
  const [updated, setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/prime", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [auto, load]);

  const rows = [...(data?.crowding || [])].sort((a, b) => (b.daysToCover ?? -1) - (a.daysToCover ?? -1));
  // USD-only, same no-real-FX-feed reasoning as Position Risk - HKD/JPY
  // rows still appear individually below, in their own currency.
  const totalShortValue = rows.filter(r => r.ccy === "USD").reduce((a, r) => a + (r.shortValue || 0), 0);
  const nonUsdCount = rows.filter(r => r.ccy && r.ccy !== "USD").length;
  const elevated = rows.filter(r => r.bucket === "HIGH" || r.bucket === "EXTREME").length;
  const multiClient = rows.filter(r => r.numClients > 1).length;
  const mostCrowded = rows[0];

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">short-interest concentration · aggregate shorts vs. real ADV, across all clients · <span className="text-slate-500">primefinance CEP via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/> auto-refresh</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/prime — {err}</div>}
    {data && !rows.length && <div className="panel p-8 text-center text-sm text-slate-500">
      No short positions yet.<br/>
      <span className="text-xs text-slate-600">Needs .prime.positions populated and the CEP's periodic market-data refresh (or eq_hdb at -eqhdbaddr) to have run at least once.</span>
    </div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Names shorted" value={String(rows.length)} delta={`${multiClient} held by 2+ clients`} icon={Boxes}/>
      <Metric label="Elevated risk" value={String(elevated)} delta="HIGH + EXTREME days-to-cover" icon={ShieldCheck}/>
      <Metric label="Total short value (USD)" value={fmtUsd(totalShortValue)} delta={nonUsdCount ? `+ ${nonUsdCount} in HKD/JPY (see table)` : "across the book"} icon={CircleDollarSign}/>
      <Metric label="Most crowded" value={mostCrowded ? mostCrowded.sym : "—"} delta={mostCrowded ? `${dtcStr(mostCrowded.daysToCover)} to cover` : ""} icon={TrendingDown}/>
    </div>

    <section className="panel p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="font-semibold">Crowding map <span className="text-xs text-slate-500">days to cover × clients exposed, bubble = short value</span></div>
      </div>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {Object.entries(CROWD_BUCKET_COLOR).map(([k, c]) => <div key={k} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: c }}/><span className="text-slate-400">{k}</span>
        </div>)}
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1e2b36"/>
            <XAxis type="number" dataKey="daysToCover" name="Days to cover" stroke="#566673" fontSize={10} tickFormatter={(v) => dtcStr(v)}/>
            <YAxis type="number" dataKey="numClients" name="Clients exposed" allowDecimals={false} stroke="#566673" fontSize={10}
              domain={[0, (dataMax) => Math.max(2, dataMax + 1)]}/>
            <ZAxis type="number" dataKey="shortValue" range={[80, 600]} name="Short value"/>
            <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<CrowdTooltip/>}/>
            <Scatter data={rows} fillOpacity={0.8}>
              {rows.map((r, i) => <Cell key={i} fill={CROWD_BUCKET_COLOR[r.bucket] || "#64748b"}/>)}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </section>

    <section className="panel overflow-hidden">
      <div className="border-b border-slate-800 px-4 py-3 font-semibold">All shorted symbols <span className="text-xs text-slate-500">most crowded first</span></div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Symbol", "Ccy", "Short qty", "Clients", "Close", "ADV", "Short value", "Days to cover", "Bucket"].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="px-3 py-1.5 font-mono font-semibold text-slate-200">{r.sym}</td>
              <td className="px-3 py-1.5 text-slate-500">{r.ccy || "—"}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-300">{r.shortQty.toLocaleString()}</td>
              <td className="px-3 py-1.5"><span className={`tabular-nums ${r.numClients > 1 ? "font-semibold text-amber-400" : "text-slate-400"}`}>{r.numClients}</span></td>
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{r.close == null ? "—" : r.close.toFixed(2)}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-500">{fmtCount(r.adv)}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-300">{fmtMoney(r.shortValue, r.ccy)}</td>
              <td className="px-3 py-1.5 tabular-nums font-semibold" style={{ color: CROWD_BUCKET_COLOR[r.bucket] }}>{dtcStr(r.daysToCover)}</td>
              <td className="px-3 py-1.5"><span className={`badge ${CROWD_BUCKET_BADGE[r.bucket] || "bg-slate-800 text-slate-400"}`}>{r.bucket}</span></td>
            </tr>)}
            {data && !rows.length && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-600">no short positions</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

// ---- Tables (in-memory inventory) ------------------------------------
function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtCount(n) {
  if (n == null) return "—";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
function ago(iso) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return "—";
  if (s < 0) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function tableStatus(t, sourceOnline, kind) {
  if (!sourceOnline) return { label: "offline", cls: "bg-rose-950 text-rose-300" };
  if (!t.rows) return { label: "empty", cls: "bg-slate-900 text-slate-500" };
  // idb sources report rows staged to -idbroot since EOD, no per-row timestamp
  if (kind === "idb") return { label: "staged", cls: "bg-violet-950 text-violet-300" };
  const age = t.lastTs ? (Date.now() - Date.parse(t.lastTs)) / 1000 : Infinity;
  if (age < 30) return { label: "live", cls: "bg-emerald-950 text-emerald-300" };
  if (age < 600) return { label: "recent", cls: "bg-cyan-950 text-cyan-300" };
  return { label: "idle", cls: "bg-amber-950 text-amber-300" };
}

// System > Tables grouping. Base tier is Demo vs Live; Live sources are then
// split by storage kind — "Live — HDB" (on-disk), "Live — Real-time" (RDB
// in-memory working set) and "Live — Real-time (IDB)" (rows the idb has
// staged to -idbroot since the last EOD). Within a tier, sources sharing a
// data group (e.g. every yfinance pipeline) collapse under one sub-header.
const TABLE_TIERS = {
  default: "Demo", markout: "Demo", primefinance: "Demo", spread: "Demo",
  mon: "Live", massive: "Live",
  eq_m1_yfinance: "Live", eq_hdb: "Live", efxReplay: "Live",
};
const TABLE_GROUPS = {
  eq_m1_yfinance: "yfinance", eq_hdb: "yfinance", efxReplay: "yfinance",
  eq_m1_yfinance_idb: "yfinance",
};
// storage kind for a source when it's offline and /api/tables can't report `role`
const TABLE_KIND = {
  eq_hdb: "hdb", efxReplay: "hdb",
  mon_idb: "idb", markout_idb: "idb", spread_idb: "idb",
  primefinance_idb: "idb", massive_idb: "idb", eq_m1_yfinance_idb: "idb",
};
const TABLE_TIER_ORDER = [
  "Demo", "Live — Real-time", "Live — Real-time (IDB)", "Live — HDB", "Other",
];

function tableTierOf(src) {
  const kind = src.role || TABLE_KIND[src.name] || "rdb";
  const base = TABLE_TIERS[src.name] || (["rdb", "idb", "hdb"].includes(kind) ? "Live" : "Other");
  if (base !== "Live") return base;
  if (kind === "hdb") return "Live — HDB";
  if (kind === "idb") return "Live — Real-time (IDB)";
  return "Live — Real-time";
}

function Tables() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);
  const [collapsed,setCollapsed] = useState({});
  const toggleTier = (t) => setCollapsed(c => ({ ...c, [t]: !c[t] }));

  const load = useCallback(() => {
    fetch(new URL("/api/tables", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const sources = data?.sources || [];
  const totals = data?.totals || {};

  // [ [tier, units[]] ] — a unit is either { kind:"group", group, sources[] }
  // (collapsible sub-header) or { kind:"source", src }. Units and the sources
  // inside a group are ordered alphabetically by name.
  const tiers = useMemo(() => {
    const byTier = {};
    for (const src of sources) (byTier[tableTierOf(src)] ??= []).push(src);
    const order = [...TABLE_TIER_ORDER, ...Object.keys(byTier).filter(t => !TABLE_TIER_ORDER.includes(t))];
    return order.filter(t => byTier[t]).map(t => {
      const groups = new Map();
      const loose = [];
      for (const src of byTier[t]) {
        const g = TABLE_GROUPS[src.name];
        if (g) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(src); }
        else loose.push({ kind: "source", src, key: src.name });
      }
      const groupUnits = [...groups.entries()].map(([group, gs]) => ({
        kind: "group", group, key: group,
        sources: gs.slice().sort((a, b) => a.name.localeCompare(b.name)),
      }));
      const units = [...groupUnits, ...loose].sort((a, b) => a.key.localeCompare(b.key));
      return [t, units];
    });
  }, [sources]);

  const renderSource = (src) => {
    const tbls = [...(src.tables||[])].sort((a,b)=>String(a.table).localeCompare(String(b.table)));
    return <React.Fragment key={src.name}>
      <tr className="border-t border-slate-800 bg-[#0b151e]">
        <td className="px-4 py-2 pl-8 font-semibold text-slate-200">
          {src.name}
          <span className="ml-2 text-[10px] font-normal text-slate-500">{src.process || src.target} · {src.role || "?"}</span>
        </td>
        <td className="px-4 py-2">
          <span className={`badge ${src.connected ? "bg-emerald-950 text-emerald-300" : "bg-rose-950 text-rose-300"}`}>
            {src.connected ? "online" : "offline"}
          </span>
        </td>
        <td className="px-4 py-2 tabular-nums text-slate-400">{fmtCount((tbls).reduce((s,t)=>s+(t.rows||0),0))}</td>
        <td/><td className="px-4 py-2 tabular-nums text-slate-500">{fmtBytes((tbls).reduce((s,t)=>s+(t.bytes||0),0))}</td>
        <td className="px-4 py-2 text-slate-600">{src.error ? <span className="text-rose-400">{src.error}</span> : ""}</td>
      </tr>
      {tbls.map(t => {
        const st = tableStatus(t, src.connected, src.role || TABLE_KIND[src.name]);
        return <tr key={src.name+"/"+t.table} className="border-t border-slate-800/60 hover:bg-slate-900/50">
          <td className="px-4 py-1.5 pl-12 font-mono text-cyan-300">{t.table}</td>
          <td className="px-4 py-1.5"><span className={`badge ${st.cls}`}>{st.label}</span></td>
          <td className="px-4 py-1.5 tabular-nums text-slate-200">{t.rows?.toLocaleString() ?? "—"}</td>
          <td className="px-4 py-1.5 tabular-nums text-slate-500">{t.columns ?? "—"}</td>
          <td className="px-4 py-1.5 tabular-nums text-slate-400">{fmtBytes(t.bytes)}</td>
          <td className="px-4 py-1.5 text-slate-500">{ago(t.lastTs)}</td>
        </tr>;
      })}
      {src.connected && !tbls.length && <tr><td colSpan={6} className="px-4 py-2 pl-12 text-slate-600">no tables</td></tr>}
    </React.Fragment>;
  };

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">table inventory · <span className="text-slate-500">RDB + IDB + HDB sources, grouped by tier</span></span>
      <label className="flex items-center gap-1.5 text-slate-400">
        <input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh
      </label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900">
        <RefreshCw size={12}/> refresh
      </button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/tables — {err}</div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Tables" value={String(totals.tables ?? "—")} delta={`${totals.online ?? 0}/${totals.sources ?? 0} sources online`} icon={Database}/>
      <Metric label="Rows" value={fmtCount(totals.rows)} delta="across all sources" icon={ListFilter}/>
      <Metric label="Resident size" value={fmtBytes(totals.bytes)} delta="serialized (-22!)" icon={Gauge}/>
      <Metric label="Sources" value={String(totals.sources ?? "—")} delta={`${(totals.tables && totals.online) ? "" : "some idle"}`} icon={Network}/>
    </div>

    <section className="panel overflow-hidden">
      <div className="max-h-[64vh] overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[#0a121a] text-slate-500">
            <tr>{["Pipeline / Table","Status","Rows","Cols","Size","Last update"].map(h=>
              <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {tiers.map(([tier, units]) => {
              const tierSrcs = units.flatMap(u => u.kind === "group" ? u.sources : [u.src]);
              const open = !collapsed[tier];
              const onlineN = tierSrcs.filter(s => s.connected).length;
              return <React.Fragment key={tier}>
                <tr className="border-t-2 border-slate-700 bg-[#0a121a]">
                  <td colSpan={6} className="px-3 py-1.5">
                    <button onClick={() => toggleTier(tier)} className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-slate-300 hover:text-slate-100">
                      <ChevronRight size={13} className={`text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}/>
                      {tier}
                      <span className="font-normal normal-case tracking-normal text-slate-500">
                        {tierSrcs.length} source{tierSrcs.length !== 1 ? "s" : ""} · {onlineN} online
                      </span>
                    </button>
                  </td>
                </tr>
                {open && units.map(u => {
                  if (u.kind === "source") return renderSource(u.src);
                  const gk = `${tier}/${u.group}`;
                  const gopen = !collapsed[gk];
                  const gon = u.sources.filter(s => s.connected).length;
                  return <React.Fragment key={gk}>
                    <tr className="border-t border-slate-800 bg-[#0b1620]">
                      <td colSpan={6} className="px-3 py-1">
                        <button onClick={() => toggleTier(gk)} className="ml-3 flex items-center gap-2 text-[11px] font-semibold text-slate-400 hover:text-slate-200">
                          <ChevronRight size={12} className={`text-slate-600 transition-transform ${gopen ? "rotate-90" : ""}`}/>
                          {u.group}
                          <span className="font-normal text-slate-600">{u.sources.length} source{u.sources.length !== 1 ? "s" : ""} · {gon} online</span>
                        </button>
                      </td>
                    </tr>
                    {gopen && u.sources.map(renderSource)}
                  </React.Fragment>;
                })}
              </React.Fragment>;
            })}
            {!sources.length && data && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-600">no sources configured</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

// ---- System > Query Mon ----------------------------------------------
// Query behaviour off each gateway's .util.gw.queue / .util.gw.servers
// (openQ core/utils/gateway.q). One tab per gateway target (gw0, mon_gw).
function QueryMon() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [auto, setAuto] = useState(true);
  const [updated, setUpdated] = useState(null);
  const [tgt, setTgt] = useState("");
  const [showSlow, setShowSlow] = useState(false);

  const load = useCallback(() => {
    fetch(new URL("/api/querymon", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); setTgt(t => t || (j.targets[0] && j.targets[0].name) || ""); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!auto) return; const id = setInterval(load, 3000); return () => clearInterval(id); }, [auto, load]);

  const targets = data?.targets || [];
  const cur = targets.find(t => t.name === tgt) || targets[0];

  const ms = (v) => v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 2 : 0)} ms`;
  const route = (st) => Array.isArray(st) ? st.join("+") : String(st ?? "?");
  const secAgo = (s) => s == null ? "—" : s < 90 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
  const qStatus = (r) => r.pending ? { label: "pending", cls: "bg-amber-950 text-amber-300" }
    : r.discard ? { label: "discarded", cls: "bg-slate-800 text-slate-400" }
    : r.error ? { label: "error", cls: "bg-rose-950 text-rose-300" }
    : { label: "ok", cls: "bg-emerald-950 text-emerald-300" };

  const chartData = (cur?.series || []).map(s => ({
    t: s.minute ? new Date(s.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
    n: s.n || 0, errs: s.errs || 0, avgMs: s.avgMs != null ? Number(s.avgMs.toFixed(2)) : 0,
  }));
  const rows = (showSlow ? cur?.slowest : cur?.recent) || [];

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">query behaviour · <span className="text-slate-500">.util.gw.queue per gateway</span></span>
      <span className="flex overflow-hidden rounded border border-slate-800">
        {targets.map(t => <button key={t.name} onClick={() => setTgt(t.name)}
          className={`px-2 py-1 ${cur?.name === t.name ? "bg-slate-800 text-cyan-300" : "text-slate-400 hover:bg-slate-900"}`}>
          {t.name}{!t.connected ? " ·offline" : !t.hasGw ? " ·no gw" : ""}
        </button>)}
      </span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/> auto</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/querymon — {err}</div>}
    {cur && !cur.connected && <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">gateway <span className="font-mono">{cur.name}</span> ({cur.target}) is offline</div>}
    {cur && cur.connected && !cur.hasGw && <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">{cur.target} has no <span className="font-mono">.util.gw.queue</span> — {cur.error || "not a gateway process"}</div>}

    {cur && cur.hasGw && <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="Queries" value={fmtCount(cur.totalQueries)} delta={`${cur.doneCnt} completed`} icon={Radar}/>
        <Metric label="In-flight" value={String(cur.queued ?? 0)} delta={`${cur.discardCnt || 0} discarded`} icon={Activity}/>
        <Metric label="p95 latency" value={ms(cur.latencyMs?.p95)} delta={`p50 ${ms(cur.latencyMs?.p50)} · max ${ms(cur.latencyMs?.max)}`} icon={Gauge}/>
        <Metric label={`Error rate (${cur.winMin}m)`} value={`${((cur.errRateWindow || 0) * 100).toFixed(1)}%`} delta={`${cur.errCnt || 0} err · ${(cur.qpsWindow || 0).toFixed(2)} q/s`} icon={cur.errCnt ? TrendingUp : TrendingDown}/>
      </div>

      <section className="panel p-4">
        <div className="mb-2 font-semibold">Throughput <span className="text-xs text-slate-500">queries &amp; errors per minute · last {cur.histMin}m</span></div>
        <div className="h-52"><ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#1e2b36" vertical={false}/>
            <XAxis dataKey="t" stroke="#566673" fontSize={10} minTickGap={28}/>
            <YAxis stroke="#566673" fontSize={10} width={34} allowDecimals={false}/>
            <Tooltip contentStyle={{ background: "#0b151e", border: "1px solid #263746", fontSize: 12 }}
              formatter={(v, k) => [v, k === "avgMs" ? "avg ms" : k]}/>
            <Bar dataKey="n" name="queries" fill="#22d3ee" isAnimationActive={false} stackId="a"/>
            <Bar dataKey="errs" name="errors" fill="#f43f5e" isAnimationActive={false} stackId="a"/>
          </BarChart>
        </ResponsiveContainer></div>
        {!chartData.length && <div className="pt-2 text-center text-xs text-slate-500">no completed queries in the window yet</div>}
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="panel overflow-hidden">
          <div className="border-b border-slate-800 px-4 py-2 font-semibold">By route</div>
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0a121a] text-slate-500"><tr>{["Route", "Queries", "Avg", "Max", "Errors"].map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {(cur.byType || []).map((r, i) => <tr key={i} className="border-t border-slate-800">
                <td className="px-4 py-1.5 font-mono text-slate-300">{route(r.serverType)}</td>
                <td className="px-4 py-1.5 tabular-nums text-slate-200">{fmtCount(r.n)}</td>
                <td className="px-4 py-1.5 tabular-nums text-slate-400">{ms(r.avgMs)}</td>
                <td className="px-4 py-1.5 tabular-nums text-slate-400">{ms(r.maxMs)}</td>
                <td className={`px-4 py-1.5 tabular-nums ${r.errs ? "text-rose-400" : "text-slate-500"}`}>{r.errs || 0}</td>
              </tr>)}
              {!(cur.byType || []).length && <tr><td colSpan={5} className="px-4 py-3 text-center text-slate-600">no data</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="panel overflow-hidden">
          <div className="border-b border-slate-800 px-4 py-2 font-semibold">Backend handles <span className="ml-1 text-xs font-normal text-slate-500">.util.gw.servers</span></div>
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0a121a] text-slate-500"><tr>{["Type", "State", "Queries", "Busy time", "Last"].map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {(cur.servers || []).map((s, i) => <tr key={i} className="border-t border-slate-800">
                <td className="px-4 py-1.5 font-mono text-slate-300">{s.serverType}</td>
                <td className="px-4 py-1.5"><span className="flex items-center gap-1.5"><Dot up={s.active}/>{s.inuse ? "in use" : s.active ? "idle" : "down"}</span></td>
                <td className="px-4 py-1.5 tabular-nums text-slate-200">{fmtCount(s.querycount)}</td>
                <td className="px-4 py-1.5 tabular-nums text-slate-400">{ms(s.usageMs)}</td>
                <td className="px-4 py-1.5 tabular-nums text-slate-500">{secAgo(s.lastAgoSec)} ago</td>
              </tr>)}
              {!(cur.servers || []).length && <tr><td colSpan={5} className="px-4 py-3 text-center text-slate-600">no backends</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
          <div className="font-semibold">{showSlow ? "Slowest queries" : "Recent queries"} <span className="ml-1 text-xs font-normal text-slate-500">{rows.length}</span></div>
          <button onClick={() => setShowSlow(s => !s)} className="rounded border border-slate-800 px-2 py-1 text-xs text-slate-400 hover:bg-slate-900">
            {showSlow ? "show recent" : "show slowest"}
          </button>
        </div>
        <div className="max-h-[48vh] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["#", "Age", "Route", "Table", "Latency", "Status"].map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const s = qStatus(r);
                return <tr key={i} className={`border-t border-slate-800/60 ${r.error ? "bg-rose-950/20" : r.pending ? "bg-amber-950/10" : ""}`}>
                  <td className="px-4 py-1.5 tabular-nums text-slate-600">{r.queryID}</td>
                  <td className="px-4 py-1.5 tabular-nums text-slate-500">{secAgo(r.sinceSec)}</td>
                  <td className="px-4 py-1.5 font-mono text-slate-400">{route(r.serverType)}</td>
                  <td className="px-4 py-1.5 font-mono text-cyan-300">{r.qtable || "—"}</td>
                  <td className="px-4 py-1.5 tabular-nums text-slate-200">{r.pending ? "…" : ms(r.tookMs)}</td>
                  <td className="px-4 py-1.5"><span className={`badge ${s.cls}`}>{s.label}</span></td>
                </tr>;
              })}
              {!rows.length && <tr><td colSpan={6} className="px-4 py-4 text-center text-slate-600">no queries recorded</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>}
  </div>;
}

// ---- Markout / impact --------------------------------------------------
function fmtOffset(sec) {
  if (sec == null) return "";
  const a = Math.abs(sec), sign = sec < 0 ? "-" : "";
  if (a === 0) return "0";
  if (a < 60) return `${sign}${a % 1 ? a.toFixed(1) : a}s`;
  const m = a / 60;
  return `${sign}${m % 1 ? m.toFixed(1) : m}m`;
}
const bps1 = (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(2)} bps`);

function DecayChart({ data, dataKey, color, label }) {
  return (
    <div className="h-72"><ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="#1e2b36" vertical={false}/>
        <XAxis dataKey="label" stroke="#566673" fontSize={10} minTickGap={16}/>
        <YAxis stroke="#566673" fontSize={10} width={44} tickFormatter={(v)=>v.toFixed(1)}/>
        <Tooltip
          contentStyle={{background:"#0b151e",border:"1px solid #263746",fontSize:12}}
          formatter={(v)=>[v==null?"—":`${Number(v).toFixed(3)} bps`, label]}
          labelFormatter={(l)=>`offset ${l}`}/>
        <ReferenceLine y={0} stroke="#37505f"/>
        <ReferenceLine x="0" stroke="#37505f" strokeDasharray="3 3"/>
        <Line type="monotone" dataKey={dataKey} stroke={color} dot={false} strokeWidth={2} connectNulls isAnimationActive={false}/>
      </LineChart>
    </ResponsiveContainer></div>
  );
}

function Markout() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

  const load = useCallback(() => {
    fetch(new URL("/api/markout", GW), { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const mk = (data?.markout?.curve || []).map(r => ({ ...r, label: fmtOffset(r.offsetSec) }));
  const im = (data?.impact?.curve || []).map(r => ({ ...r, label: fmtOffset(r.offsetSec) }));
  const s = data?.summary || {};
  const at = (curve, sec, key) => {
    const row = curve.reduce((best,r)=> Math.abs(r.offsetSec-sec) < Math.abs((best?.offsetSec ?? 1e9)-sec) ? r : best, null);
    return row ? row[key] : null;
  };
  const mkFar = at(mk, 600, "markoutBps");
  const mkMin = at(mk, 60, "markoutBps");

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">deal markout &amp; order impact · <span className="text-slate-500">markout module CEP via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400">
        <input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh
      </label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900">
        <RefreshCw size={12}/> refresh
      </button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {data?.connected === false && <span className="text-amber-400">CEP disconnected</span>}
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
      {GW}/api/markout — {err}
      <div className="mt-1 text-rose-400/70">needs the markout module running + a feeder (gateway/tools/markout-feeder.js) and OPENQ_MARKOUT_CEP set.</div>
    </div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Trades measured" value={String(s.mkTrades ?? "—")} delta={`${s.mkSamples ?? 0} grid samples`} icon={TrendingUp}/>
      <Metric label="Orders measured" value={String(s.imOrders ?? "—")} delta={`${s.imSamples ?? 0} grid samples`} icon={Activity}/>
      <Metric label="Peak impact" value={bps1(data?.impact?.peakBps)} delta="0–10s, adverse +" icon={TrendingUp}/>
      <Metric label="Permanent impact" value={bps1(data?.impact?.permanentBps)} delta="≥30s tail" icon={ShieldCheck}/>
    </div>

    <section className="panel p-4">
      <div className="mb-1 flex justify-between">
        <div><div className="font-semibold">Deal markout</div><div className="text-xs text-slate-500">mid drift vs execution rate, by offset from the trade · bps</div></div>
        <div className="text-right text-xs text-slate-500">@+1m {bps1(mkMin)}<br/>@+10m {bps1(mkFar)}</div>
      </div>
      <DecayChart data={mk} dataKey="markoutBps" color="#22d3ee" label="markout"/>
    </section>

    <section className="panel p-4">
      <div className="mb-1 font-semibold">Order / execution impact</div>
      <div className="mb-2 text-xs text-slate-500">mid move in the order's direction, −10s to +60s · bps</div>
      <DecayChart data={im} dataKey="impactBps" color="#34d399" label="impact"/>
    </section>

    {data && !mk.length && !err && <div className="panel p-6 text-center text-sm text-slate-500">
      No completed markout offsets yet — the curve fills left-to-right as rate ticks reach each offset (near offsets in seconds, the +10m tail after ~10 min).
    </div>}
  </div>;
}

// ---- Processes / pidstats ------------------------------------------------
const MB = 1024 * 1024;
const SERIES_COLORS = ["#22d3ee","#34d399","#f59e0b","#a78bfa","#f43f5e","#38bdf8","#fb923c","#4ade80"];
const PT_STYLE = {
  tp:"bg-cyan-950 text-cyan-300", rdb:"bg-emerald-950 text-emerald-300",
  hdb:"bg-violet-950 text-violet-300", gw:"bg-amber-950 text-amber-300",
  cep:"bg-sky-950 text-sky-300", idb:"bg-slate-800 text-slate-300",
  gateway:"bg-amber-950 text-amber-300", webdev:"bg-slate-800 text-slate-400",
  feeder:"bg-slate-800 text-slate-400"
};
const ptStyle = (t) => PT_STYLE[t] || "bg-slate-800 text-slate-400";

function pctBar(v, max, cls) {
  const w = Math.max(0, Math.min(100, max > 0 ? (v / max) * 100 : 0));
  return <div className="h-1.5 w-full rounded bg-slate-800"><div className={`h-full rounded ${cls}`} style={{width:`${w}%`}}/></div>;
}

const PROC_HISTORY_MS = 3 * 60 * 1000; // client-side rolling window

function Processes() {
  const [rows,setRows] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

  const load = useCallback(() => {
    // /api/pidstats reads mon_rdb directly - mon_gw fans to mon_hdb, whose
    // shared C:/data/db1/mon root can't cheaply serve "latest samples".
    const u = new URL("/api/pidstats", GW);
    fetch(u)
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => {
        setErr(null); setUpdated(new Date());
        // mon_rdb only retains a short window (it flushes to the idb on a
        // timer), so accumulate samples client-side for a stable chart.
        setRows(prev => {
          const seen = new Set((prev||[]).map(r => `${r.host}/${r.pid}/${r.timestamp}`));
          const merged = (prev||[]).concat((j.rows||[]).filter(r => !seen.has(`${r.host}/${r.pid}/${r.timestamp}`)));
          const cutoff = Date.now() - PROC_HISTORY_MS;
          return merged.filter(r => Date.parse(r.timestamp) >= cutoff);
        });
      })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [auto, load]);

  const { procs, cpuData, memData, cpuKeys, memKeys, totals } = useMemo(() => {
    const all = rows || [];
    const byKey = new Map();
    for (const r of all) {
      const key = `${r.host}/${r.pid}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    // disambiguate display labels when two processes share a sym
    const symCount = {};
    for (const [, hist] of byKey) { const s = hist[hist.length-1].sym; symCount[s] = (symCount[s]||0)+1; }

    const procs = [];
    for (const [key, hist] of byKey) {
      hist.sort((a,b) => a.timestamp < b.timestamp ? -1 : 1);
      const last = hist[hist.length - 1];
      const label = symCount[last.sym] > 1 ? `${last.sym}:${last.pid}` : last.sym;
      procs.push({ key, label, hist, ...last });
    }
    procs.sort((a,b) => b.cpuPct - a.cpuPct);

    const topByCpu = [...procs].sort((a,b)=>Math.max(...b.hist.map(h=>h.cpuPct)) - Math.max(...a.hist.map(h=>h.cpuPct))).slice(0,6);
    const topByMem = [...procs].sort((a,b)=>b.rss - a.rss).slice(0,6);
    const cpuKeys = topByCpu.map(p=>p.label);
    const memKeys = topByMem.map(p=>p.label);

    const pivot = (keyed, valFn) => {
      const byT = new Map();
      for (const p of keyed) for (const h of p.hist) {
        if (!byT.has(h.timestamp)) byT.set(h.timestamp, {});
        byT.get(h.timestamp)[p.label] = valFn(h);
      }
      return [...byT.keys()].sort().slice(-32).map(t => {
        const o = { t: t.slice(11,19) };
        for (const p of keyed) o[p.label] = byT.get(t)?.[p.label] ?? null;
        return o;
      });
    };
    const cpuData = pivot(topByCpu, h => Number(h.cpuPct.toFixed(2)));
    const memData = pivot(topByMem, h => Number((h.rss / MB).toFixed(1)));

    const totals = {
      procs: procs.length,
      cpu: procs.reduce((s,p)=>s+p.cpuPct,0),
      rss: procs.reduce((s,p)=>s+p.rss,0),
      threads: procs.reduce((s,p)=>s+(p.threads||0),0),
      hosts: new Set(procs.map(p=>p.host)).size,
    };
    return { procs, cpuData, memData, cpuKeys, memKeys, totals };
  }, [rows]);

  const cpuMax = Math.max(1, ...procs.map(p=>p.cpuPct));
  const rssMax = Math.max(1, ...procs.map(p=>p.rss));

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">openQ process telemetry · <span className="text-slate-500">mon.pidstats via gateway</span></span>
      <label className="flex items-center gap-1.5 text-slate-400">
        <input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh
      </label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900">
        <RefreshCw size={12}/> refresh
      </button>
      <span className="ml-auto text-slate-600">{updated ? `updated ${updated.toLocaleTimeString()}` : err ? "" : "loading…"}</span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
      {GW}/api/query?table=pidstats&target=mon — {err}
      <div className="mt-1 text-rose-400/70">needs the mon module + a feeder running (see gateway/README).</div>
    </div>}

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Processes" value={String(totals.procs)} delta={`${totals.hosts} host${totals.hosts===1?"":"s"}`} icon={Cpu}/>
      <Metric label="Total CPU" value={`${totals.cpu.toFixed(1)}%`} delta="sum across processes" icon={Activity}/>
      <Metric label="Resident Memory" value={`${(totals.rss/MB/1024).toFixed(2)} GB`} delta={`${(totals.rss/MB).toFixed(0)} MB`} icon={MemoryStick}/>
      <Metric label="Threads" value={String(totals.threads)} delta="OS threads" icon={Network}/>
    </div>

    <div className="grid gap-4 xl:grid-cols-2">
      <section className="panel p-4">
        <div className="mb-3 flex justify-between"><div className="font-semibold">CPU % over time</div><span className="badge bg-slate-800 text-slate-400">TOP 6</span></div>
        <div className="h-64"><ResponsiveContainer width="100%" height="100%">
          <LineChart data={cpuData}>
            <CartesianGrid stroke="#1e2b36" vertical={false}/>
            <XAxis dataKey="t" stroke="#566673" fontSize={10} minTickGap={24}/>
            <YAxis stroke="#566673" fontSize={10} width={34}/>
            <Tooltip contentStyle={{background:"#0b151e",border:"1px solid #263746",fontSize:12}}/>
            <Legend wrapperStyle={{fontSize:10}}/>
            {cpuKeys.map((k,i)=><Line key={k} type="monotone" dataKey={k} stroke={SERIES_COLORS[i%SERIES_COLORS.length]} dot={false} strokeWidth={1.5} isAnimationActive={false}/>)}
          </LineChart>
        </ResponsiveContainer></div>
      </section>
      <section className="panel p-4">
        <div className="mb-3 flex justify-between"><div className="font-semibold">Resident memory (MB)</div><span className="badge bg-slate-800 text-slate-400">TOP 6</span></div>
        <div className="h-64"><ResponsiveContainer width="100%" height="100%">
          <AreaChart data={memData}>
            <CartesianGrid stroke="#1e2b36" vertical={false}/>
            <XAxis dataKey="t" stroke="#566673" fontSize={10} minTickGap={24}/>
            <YAxis stroke="#566673" fontSize={10} width={40}/>
            <Tooltip contentStyle={{background:"#0b151e",border:"1px solid #263746",fontSize:12}}/>
            <Legend wrapperStyle={{fontSize:10}}/>
            {memKeys.map((k,i)=><Area key={k} type="monotone" dataKey={k} stackId="1" stroke={SERIES_COLORS[i%SERIES_COLORS.length]} fill={SERIES_COLORS[i%SERIES_COLORS.length]} fillOpacity={0.25} isAnimationActive={false}/>)}
          </AreaChart>
        </ResponsiveContainer></div>
      </section>
    </div>

    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="font-semibold">Processes <span className="text-xs text-slate-500">latest sample</span></div>
        <span className="text-xs text-slate-500">{procs.length} shown</span>
      </div>
      <div className="max-h-[52vh] overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500">
            <tr>{["Process","Type","PID","Port","CPU %","Mem %","RSS","Threads","Handles","Command"].map(h=>
              <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {procs.map(p=>
              <tr key={p.key} className="border-t border-slate-800/70 hover:bg-slate-900/60">
                <td className="px-4 py-2 font-semibold text-slate-200">{p.label}</td>
                <td className="px-4 py-2"><span className={`badge ${ptStyle(p.procType)}`}>{p.procType}</span></td>
                <td className="px-4 py-2 font-mono text-slate-400">{p.pid}</td>
                <td className="px-4 py-2 font-mono text-slate-400">{p.port || "—"}</td>
                <td className="px-4 py-2"><div className="flex items-center gap-2"><span className="w-10 tabular-nums text-slate-300">{p.cpuPct.toFixed(1)}</span><div className="w-16">{pctBar(p.cpuPct,cpuMax,"bg-cyan-400")}</div></div></td>
                <td className="px-4 py-2"><div className="flex items-center gap-2"><span className="w-10 tabular-nums text-slate-300">{p.memPct.toFixed(2)}</span><div className="w-16">{pctBar(p.rss,rssMax,"bg-emerald-400")}</div></div></td>
                <td className="px-4 py-2 tabular-nums text-slate-300">{(p.rss/MB).toFixed(0)} MB</td>
                <td className="px-4 py-2 tabular-nums text-slate-400">{p.threads}</td>
                <td className="px-4 py-2 tabular-nums text-slate-400">{p.fdnr}</td>
                <td className="max-w-[22rem] truncate px-4 py-2 font-mono text-[11px] text-slate-500" title={String(p.command)}>{String(p.command)}</td>
              </tr>)}
            {rows && procs.length===0 && <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-600">no pidstats rows — is the feeder running?</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

// ---- System > Process Mon (every openQ process, one view) --------------
const PM_STATUS = {
  up:      { label: "up",      cls: "bg-emerald-950 text-emerald-300", dot: "#10b981" },
  standby: { label: "standby", cls: "bg-slate-800 text-slate-400",     dot: "#64748b" },
  down:    { label: "down",    cls: "bg-rose-950 text-rose-300",       dot: "#f43f5e" },
  batch:   { label: "batch",   cls: "bg-slate-900 text-slate-500",     dot: "#475569" },
};
const PM_ROLE_CLS = {
  fh: "bg-fuchsia-950 text-fuchsia-300", feed: "bg-fuchsia-950 text-fuchsia-300",
  tp: "bg-sky-950 text-sky-300", cep: "bg-violet-950 text-violet-300",
  rdb: "bg-cyan-950 text-cyan-300", idb: "bg-teal-950 text-teal-300",
  hdb: "bg-emerald-950 text-emerald-300", gw: "bg-amber-950 text-amber-300",
  eod: "bg-slate-900 text-slate-500", housekeeping: "bg-slate-800 text-slate-400",
};

function ProcMon() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [auto, setAuto] = useState(true);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [opened, setOpened] = useState({}); // module key -> true when expanded; collapsed by default
  const toggle = (k) => setOpened((c) => ({ ...c, [k]: !c[k] }));

  const load = useCallback(() => {
    fetch(new URL("/api/procmon", GW), { cache: "no-store" })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then((j) => { setData(j); setErr(null); setUpdated(new Date()); })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!auto) return; const id = setInterval(load, 5000); return () => clearInterval(id); }, [auto, load]);

  const t = data?.totals || {};
  const mods = useMemo(() => {
    let ms = data?.modules || [];
    if (issuesOnly) ms = ms.filter((m) => m.offline || m.up < m.total || m.error);
    return ms;
  }, [data, issuesOnly]);
  const totalRss = useMemo(() => {
    let s = 0;
    for (const m of data?.modules || []) for (const p of m.procs) s += p.rss || 0;
    for (const x of data?.infra || []) s += x.rss || 0;
    return s;
  }, [data]);

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <Activity size={14} className="text-slate-500"/>
      <span className="text-slate-400">every openQ process across every pipeline · <span className="text-slate-500">cfg_proc topology + live IPC probe + pidstats</span></span>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)}/> issues only</label>
      <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)}/> auto</label>
      <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-900"><RefreshCw size={12}/> refresh</button>
      <span className="ml-auto flex items-center gap-2 text-slate-600">
        {auto && <span className="flex items-center gap-1.5 text-emerald-400"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live</span>}
        {updated && <span className="tabular-nums">{updated.toLocaleTimeString()}</span>}
      </span>
    </section>

    {err && <div className="rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{GW}/api/procmon — {err}</div>}

    {data && <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Processes up" value={`${t.up ?? 0}/${t.processes ?? 0}`} delta={`${t.down ?? 0} down`} icon={Cpu}/>
        <Metric label="Pipelines healthy" value={`${t.modulesFullyUp ?? 0}/${t.modules ?? 0}`} delta="all roles up" icon={Network}/>
        <Metric label="Down" value={String(t.down ?? 0)} delta={t.down ? "needs attention" : "all clear"} icon={ShieldCheck}/>
        <Metric label="Resident memory" value={humanBytes(totalRss)} delta="q + infra" icon={MemoryStick}/>
      </div>

      <section className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#0a121a] text-xs text-slate-500">
            <tr>{["Process", "Role", "Port", "Status", "Handles", "Rows", "CPU %", "RSS", "Thr", "PID"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {mods.map((m) => {
              const key = `pm/${m.name}`;
              const open = !!opened[key];
              const badge = m.error || m.offline ? "bg-rose-950 text-rose-300" : m.up < m.total ? "bg-amber-950 text-amber-300" : "bg-emerald-950 text-emerald-300";
              return <React.Fragment key={m.name}>
                <tr className="border-t border-slate-800 bg-[#0b151e] cursor-pointer" onClick={() => toggle(key)}>
                  <td className="px-4 py-2 font-semibold text-slate-200" colSpan={3}>
                    <ChevronRight size={13} className={`mr-1 inline transition-transform ${open ? "rotate-90" : ""}`}/>
                    {m.name}
                    {m.name !== m.label && <span className="ml-2 text-[10px] font-normal text-slate-500">{m.label}</span>}
                  </td>
                  <td className="px-4 py-2"><span className={`badge ${badge}`}>{m.error ? "error" : m.offline ? "offline" : `${m.up}/${m.total}`}</span></td>
                  <td className="px-4 py-2 text-[10px] text-slate-600" colSpan={6}>{m.error || ""}</td>
                </tr>
                {open && m.procs.map((p) => {
                  const st = PM_STATUS[p.status] || PM_STATUS.down;
                  return <tr key={`${m.name}/${p.name}/${p.port}`} className="border-t border-slate-800/60 hover:bg-slate-900/40">
                    <td className="px-4 py-1.5 pl-9 font-mono text-slate-300">{p.name}{p.instance ? <span className="text-slate-600"> ·{p.instance}</span> : ""}</td>
                    <td className="px-4 py-1.5"><span className={`badge ${PM_ROLE_CLS[p.role] || "bg-slate-800 text-slate-400"}`}>{p.role}</span></td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-500">{p.port || "—"}</td>
                    <td className="px-4 py-1.5">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: st.dot }}/>
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                        {p.error && p.status === "down" && !p.batch && <span className="text-[10px] text-rose-400/70">{p.error.replace(/^connect /, "")}</span>}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-400">{p.handles ?? "—"}</td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-400">{p.rowsTotal ? humanCount(p.rowsTotal) : "—"}</td>
                    <td className={`px-4 py-1.5 tabular-nums ${p.cpuPct > 25 ? "text-amber-400" : "text-slate-400"}`}>{p.cpuPct == null ? "—" : p.cpuPct.toFixed(1)}</td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-400">{p.rss == null ? "—" : humanBytes(p.rss)}</td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-500">{p.threads ?? "—"}</td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-600">{p.pid ?? "—"}</td>
                  </tr>;
                })}
              </React.Fragment>;
            })}
            {!mods.length && <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-600">{issuesOnly ? "no issues — every pipeline is healthy" : "no modules"}</td></tr>}
          </tbody>
        </table>
      </section>

      {!!data.infra?.length && <section className="panel overflow-x-auto">
        <div className="border-b border-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-300">Infra &amp; feeders <span className="font-normal text-slate-600">(from pidstats, not openQ pipeline processes)</span></div>
        <table className="w-full text-left text-sm">
          <thead className="bg-[#0a121a] text-xs text-slate-500"><tr>{["Process", "Type", "CPU %", "RSS", "Thr", "PID"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {data.infra.map((x) => <tr key={x.name} className="border-t border-slate-800/60 hover:bg-slate-900/40">
              <td className="px-4 py-1.5 font-mono text-slate-300">{x.name}</td>
              <td className="px-4 py-1.5"><span className="badge bg-slate-800 text-slate-400">{x.procType}</span></td>
              <td className={`px-4 py-1.5 tabular-nums ${x.cpuPct > 25 ? "text-amber-400" : "text-slate-400"}`}>{x.cpuPct == null ? "—" : x.cpuPct.toFixed(1)}</td>
              <td className="px-4 py-1.5 tabular-nums text-slate-400">{x.rss == null ? "—" : humanBytes(x.rss)}</td>
              <td className="px-4 py-1.5 tabular-nums text-slate-500">{x.threads ?? "—"}</td>
              <td className="px-4 py-1.5 tabular-nums text-slate-600">{x.pid ?? "—"}</td>
            </tr>)}
          </tbody>
        </table>
      </section>}
    </>}
  </div>;
}

const LOG_LEVELS = ["ERROR","WARN","INFO","DEBUG"];
const LOG_LEVEL_STYLE = {
  ERROR:"bg-rose-950 text-rose-300", WARN:"bg-amber-950 text-amber-300",
  INFO:"bg-slate-800 text-slate-300", DEBUG:"bg-slate-900 text-slate-500",
  RAW:"bg-slate-900 text-slate-500"
};

const LOGS_REFRESH_MS = 3000;

function Logs() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [levels,setLevels] = useState(() => new Set()); // empty = all
  const [proc,setProc] = useState("");
  const [q,setQ] = useState("");
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);
  const [tick,setTick] = useState(0); // bumps each poll so the "live" dot blinks
  const limit = 300;

  const load = useCallback(() => {
    const u = new URL("/api/logs", GW);
    u.searchParams.set("limit", String(limit));
    if (levels.size) u.searchParams.set("level", [...levels].join(","));
    if (proc) u.searchParams.set("proc", proc);
    if (q.trim()) u.searchParams.set("q", q.trim());
    u.searchParams.set("_", String(Date.now())); // defeat any intermediary cache
    fetch(u, { cache: "no-store" })
      .then(r => r.json().then(j => { if(!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(j => { setData(j); setErr(null); setUpdated(new Date()); setTick(t => t + 1); })
      .catch(e => setErr(e.message));
  }, [levels, proc, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, LOGS_REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, load]);

  const toggleLevel = (lv) => setLevels(s => {
    const n = new Set(s); n.has(lv) ? n.delete(lv) : n.add(lv); return n;
  });
  const shown = (lv) => levels.size === 0 || levels.has(lv);

  return <div className="space-y-4">
    <section className="panel p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {LOG_LEVELS.map(lv =>
            <button key={lv} onClick={()=>toggleLevel(lv)}
              className={`badge ${shown(lv) ? LOG_LEVEL_STYLE[lv] : "bg-slate-900 text-slate-600"}`}>
              {lv}
            </button>)}
        </div>
        <select value={proc} onChange={e=>setProc(e.target.value)}
          className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-300">
          <option value="">all processes</option>
          {(data?.processes || []).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="flex items-center gap-2 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs">
          <Search size={12} className="text-slate-500"/>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="search message / function"
            className="w-52 bg-transparent text-slate-200 outline-none placeholder:text-slate-600"/>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> auto-refresh
        </label>
        <button onClick={load} className="flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-900">
          <RefreshCw size={12}/> refresh
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          {data && <span>{data.count} of {data.total} lines</span>}
          {auto
            ? <span key={tick} className="flex items-center gap-1.5 text-emerald-400">
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400"/> live
              </span>
            : <span className="text-slate-600">paused</span>}
          {updated && <span className="tabular-nums text-slate-600">{updated.toLocaleTimeString()}</span>}
          {!data && !err && <span>loading…</span>}
        </div>
      </div>
      {err && <div className="mt-3 rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
        {GW}/api/logs — {err}
      </div>}
      {data && <div className="mt-2 text-[10px] text-slate-600">source: {data.dir}</div>}
    </section>

    <section className="panel overflow-hidden">
      <div className="max-h-[68vh] overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[#0a121a] text-slate-500">
            <tr>{["Time","Process","Level","Function","Message"].map(h =>
              <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="font-mono">
            {(data?.rows || []).map((r,i) =>
              <tr key={i} className="border-t border-slate-800/70 align-top hover:bg-slate-900/60">
                <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">{r.time}</td>
                <td className="px-4 py-1.5 text-cyan-300">{r.process}</td>
                <td className="px-4 py-1.5"><span className={`badge ${LOG_LEVEL_STYLE[r.level] || LOG_LEVEL_STYLE.INFO}`}>{r.level}</span></td>
                <td className="whitespace-nowrap px-4 py-1.5 text-slate-400">{r.function}</td>
                <td className="px-4 py-1.5 text-slate-300"><pre className="whitespace-pre-wrap break-words font-mono text-xs">{r.message}</pre></td>
              </tr>)}
            {data && data.rows.length === 0 &&
              <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-600">no matching log lines</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}

function SimplePage({title,subtitle,icon:Icon}) {
  return <div className="panel flex min-h-[520px] flex-col items-center justify-center p-8 text-center"><Icon size={42} className="mb-4 text-cyan-400"/><div className="text-xl font-semibold">{title}</div><div className="mt-2 max-w-md text-sm text-slate-500">{subtitle}</div><button className="mt-6 flex items-center gap-2 rounded bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950"><Play size={14}/> Connect to openQ</button></div>
}

function App() {
  const [active,setActive] = useState("Overview");
  const [orders,setOrders] = useState(baseOrders);
  useEffect(() => {
    const id=setInterval(()=>setOrders(x=>x.map((o,i)=>i===0 && o.status==="Working" ? {...o,filled:"7.7m"}:o)),3000);
    return ()=>clearInterval(id);
  },[]);
  const page = useMemo(()=>{
    if(active==="Tables") return <Tables/>;
    if(active==="Query Mon") return <QueryMon/>;
    if(active==="Tests") return <Tests/>;
    if(active==="Control") return <Control/>;
    if(active==="HDB Health") return <HDBHealth/>;
    if(active==="Launcher") return <Launcher/>;
    if(active==="Catalog") return <Catalog/>;
    if(active==="Explorer") return <Explorer/>;
    if(active==="Modules") return <Modules/>;
    if(active==="Charts") return <Charts/>;
    if(active==="EQ Charts") return <EqCharts/>;
    if(active==="Market Impact") return <Impact/>;
    if(active==="Markout") return <Markout/>;
    if(active==="Spreads") return <Spreads/>;
    if(active==="Prime Finance") return <PrimeFinance/>;
    if(active==="Fee Calibration") return <BorrowFeeCalibration/>;
    if(active==="Position Risk") return <PositionRisk/>;
    if(active==="Crowding") return <Crowding/>;
    if(active==="Desk Risk") return <DeskRisk/>;
    if(active==="Process Mon") return <ProcMon/>;
    if(active==="Resources") return <Processes/>;
    if(active==="Logs") return <Logs/>;
    return <Overview orders={orders}/>;
  },[active,orders]);
  return <div className="flex min-h-screen"><Nav active={active} setActive={setActive}/><main className="min-w-0 flex-1"><Header active={active}/><div className="p-4 md:p-6">{page}</div></main></div>
}
createRoot(document.getElementById("root")).render(<App/>);