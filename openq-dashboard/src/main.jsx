import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, BarChart3, Bell, ChevronRight, CircleDollarSign, Cpu, Database,
  Gauge, LayoutDashboard, ListFilter, MemoryStick, Network, Play, RefreshCw,
  ScrollText, Search, Settings, ShieldCheck, TrendingDown, TrendingUp, Wifi
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer, CartesianGrid, AreaChart, Area } from "recharts";
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

const impact = Array.from({length: 31}, (_,i) => {
  const t = -10 + i*2.333;
  return { t: Number(t.toFixed(1)), value: 0.31 + (1.55-0.31)*Math.exp(-Math.max(t,0)/18.2) + (t<0 ? Math.abs(t)/100 : 0) };
});

function Nav({active,setActive}) {
  const items = [
    ["Overview",LayoutDashboard],["Logs",ScrollText],["Market Impact",BarChart3],
    ["Markout",TrendingUp],["Processes",Cpu],["Tables",Database]
  ];
  return <aside className="w-60 shrink-0 border-r border-slate-800 bg-[#08121a] p-4">
    <div className="mb-7 flex items-center gap-2 px-2">
      <div className="grid h-8 w-8 place-items-center rounded bg-cyan-400 text-black font-black">q</div>
      <div><div className="font-bold tracking-wide">openQ</div><div className="text-[10px] text-slate-500">TRADING PLATFORM</div></div>
    </div>
    <div className="space-y-1">
      {items.map(([name,Icon]) => <button key={name} onClick={()=>setActive(name)}
        className={`flex w-full items-center gap-3 rounded px-3 py-2.5 text-sm ${active===name?"bg-slate-800 text-cyan-300":"text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}>
        <Icon size={16}/>{name}
      </button>)}
    </div>
    <div className="mt-8 border-t border-slate-800 pt-4 text-xs text-slate-500">
      <div className="mb-2 flex items-center gap-2"><Database size={14}/> kdb+ gateway</div>
      <div className="flex items-center gap-2 text-emerald-400"><Wifi size={13}/> Live connection</div>
    </div>
  </aside>
}

function Header({active}) {
  return <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-[#09141d] px-6">
    <div><div className="text-lg font-semibold">{active}</div><div className="text-xs text-slate-500">Friday, 28 Aug 2026 · Asia/Tokyo</div></div>
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

function Impact() {
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metric label="Temporary Impact" value="1.24 bps" delta="current estimate" icon={TrendingUp}/>
      <Metric label="Permanent Impact" value="0.31 bps" delta="25.0% of total" icon={Activity}/>
      <Metric label="Decay τ" value="18.2s" delta="fit confidence 94%" icon={Gauge}/>
      <Metric label="Sample Size" value="82,416" delta="executions" icon={Database}/>
    </div>
    <section className="panel p-4">
      <div className="mb-1 font-semibold">Market Impact Decay</div><div className="mb-4 text-xs text-slate-500">Average impact around order arrival · bps</div>
      <div className="h-96"><ResponsiveContainer width="100%" height="100%"><LineChart data={impact}><CartesianGrid stroke="#1e2b36" vertical={false}/><XAxis dataKey="t" stroke="#566673" fontSize={10}/><YAxis stroke="#566673" fontSize={10}/><Tooltip contentStyle={{background:"#0b151e",border:"1px solid #263746"}}/><Line type="monotone" dataKey="value" stroke="#22d3ee" dot={false} strokeWidth={2}/></LineChart></ResponsiveContainer></div>
    </section>
    <div className="grid gap-4 xl:grid-cols-3">
      {["EURUSD","USDJPY","GBPUSD"].map((s,i)=><div className="panel p-4" key={s}><div className="flex justify-between"><span className="font-semibold">{s}</span><span className="badge bg-slate-800 text-slate-400">TODAY</span></div><div className="mt-4 text-xl">{[1.12,0.86,1.47][i]} <span className="text-xs text-slate-500">bps</span></div><div className="mt-1 text-xs text-slate-500">median impact · 1,000+ fills</div></div>)}
    </div>
  </div>
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
function tableStatus(t, sourceOnline) {
  if (!sourceOnline) return { label: "offline", cls: "bg-rose-950 text-rose-300" };
  if (!t.rows) return { label: "empty", cls: "bg-slate-900 text-slate-500" };
  const age = t.lastTs ? (Date.now() - Date.parse(t.lastTs)) / 1000 : Infinity;
  if (age < 30) return { label: "live", cls: "bg-emerald-950 text-emerald-300" };
  if (age < 600) return { label: "recent", cls: "bg-cyan-950 text-cyan-300" };
  return { label: "idle", cls: "bg-amber-950 text-amber-300" };
}

function Tables() {
  const [data,setData] = useState(null);
  const [err,setErr] = useState(null);
  const [auto,setAuto] = useState(true);
  const [updated,setUpdated] = useState(null);

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

  return <div className="space-y-4">
    <section className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-slate-400">in-memory table inventory · <span className="text-slate-500">one RDB per pipeline</span></span>
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
      <Metric label="Rows in memory" value={fmtCount(totals.rows)} delta="across all pipelines" icon={ListFilter}/>
      <Metric label="Resident size" value={fmtBytes(totals.bytes)} delta="serialized (-22!)" icon={Gauge}/>
      <Metric label="Pipelines" value={String(totals.sources ?? "—")} delta={`${(totals.tables && totals.online) ? "" : "some idle"}`} icon={Network}/>
    </div>

    <section className="panel overflow-hidden">
      <div className="max-h-[64vh] overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[#0a121a] text-slate-500">
            <tr>{["Pipeline / Table","Status","Rows","Cols","Size","Last update"].map(h=>
              <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {sources.map(src => {
              const tbls = [...(src.tables||[])].sort((a,b)=>b.rows-a.rows);
              return <React.Fragment key={src.name}>
                <tr className="border-t border-slate-800 bg-[#0b151e]">
                  <td className="px-4 py-2 font-semibold text-slate-200">
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
                  const st = tableStatus(t, src.connected);
                  return <tr key={src.name+"/"+t.table} className="border-t border-slate-800/60 hover:bg-slate-900/50">
                    <td className="px-4 py-1.5 pl-8 font-mono text-cyan-300">{t.table}</td>
                    <td className="px-4 py-1.5"><span className={`badge ${st.cls}`}>{st.label}</span></td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-200">{t.rows?.toLocaleString() ?? "—"}</td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-500">{t.columns ?? "—"}</td>
                    <td className="px-4 py-1.5 tabular-nums text-slate-400">{fmtBytes(t.bytes)}</td>
                    <td className="px-4 py-1.5 text-slate-500">{ago(t.lastTs)}</td>
                  </tr>;
                })}
                {src.connected && !tbls.length && <tr><td colSpan={6} className="px-4 py-2 pl-8 text-slate-600">no tables</td></tr>}
              </React.Fragment>;
            })}
            {!sources.length && data && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-600">no sources configured</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
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
    const u = new URL("/api/query", GW);
    u.searchParams.set("table","pidstats");
    u.searchParams.set("target","mon");
    u.searchParams.set("columns","timestamp,sym,host,pid,procType,port,userPct,sysPct,cpuPct,vsz,rss,memPct,threads,fdnr,command");
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
    if(active==="Market Impact") return <Impact/>;
    if(active==="Markout") return <Markout/>;
    if(active==="Processes") return <Processes/>;
    if(active==="Logs") return <Logs/>;
    return <Overview orders={orders}/>;
  },[active,orders]);
  return <div className="flex min-h-screen"><Nav active={active} setActive={setActive}/><main className="min-w-0 flex-1"><Header active={active}/><div className="p-4 md:p-6">{page}</div></main></div>
}
createRoot(document.getElementById("root")).render(<App/>);