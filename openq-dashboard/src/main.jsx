import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, BarChart3, Bell, ChevronRight, CircleDollarSign, Cpu, Database,
  Gauge, LayoutDashboard, ListFilter, MemoryStick, Network, Play, RefreshCw,
  ScrollText, Search, Settings, ShieldCheck, TrendingDown, TrendingUp, Wifi
} from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer, CartesianGrid, AreaChart, Area } from "recharts";
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

function Nav({active,setActive}) {
  const items = [
    ["Overview",LayoutDashboard],["Desk Risk",ShieldCheck],["Logs",ScrollText],
    ["Market Impact",BarChart3],["Markout",TrendingUp],["Prime Finance",CircleDollarSign],
    ["Processes",Cpu],["Spreads",TrendingDown],["Tables",Database]
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
      <Metric label="Short exposure" value={fmtCount(s.shortQty)} delta={`${fmtCount(s.availQty)} lendable`} icon={CircleDollarSign}/>
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
          <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Client","Symbol","Short","Located","Coverage","Bucket"].map(h=><th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {cov.map((r,i)=><tr key={i} className="border-t border-slate-800/60 hover:bg-slate-900/50">
              <td className="px-3 py-1.5 font-semibold text-slate-200">{r.client}</td>
              <td className="px-3 py-1.5 font-mono text-cyan-300">{r.sym}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-300">{r.shortQty.toLocaleString()}</td>
              <td className="px-3 py-1.5 tabular-nums text-slate-400">{r.locatedQty.toLocaleString()}</td>
              <td className="px-3 py-1.5 tabular-nums">{pct1(r.coverage*100)}</td>
              <td className="px-3 py-1.5"><span className={`badge ${PF_BUCKET_BADGE[r.bucket]||"bg-slate-800 text-slate-400"}`}>{r.bucket}</span></td>
            </tr>)}
            {data && !cov.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-600">no short positions</td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
      <section className="panel overflow-hidden">
        <div className="border-b border-slate-800 px-4 py-3 font-semibold">Inventory &amp; hard-to-borrow <span className="text-xs text-slate-500">by symbol</span></div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[#0a121a] text-slate-500"><tr>{["Symbol","Available","Fee","Recall risk","Lenders","HTB"].map(h=><th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {invSorted.map(r=>{
                const score = htbBySym[r.sym] || 0;
                return <tr key={r.sym} className="border-t border-slate-800/60 hover:bg-slate-900/50">
                  <td className="px-3 py-1.5 font-mono font-semibold text-slate-200">{r.sym}</td>
                  <td className="px-3 py-1.5"><div className="flex items-center gap-2"><span className="w-14 tabular-nums text-slate-300">{fmtCount(r.available)}</span><div className="h-1.5 w-14 rounded bg-slate-800"><div className="h-full rounded bg-cyan-500/70" style={{width:`${(r.available/maxAvail)*100}%`}}/></div></div></td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-300">{r.feeBp==null?"—":`${r.feeBp.toFixed(0)} bp`}</td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-400">{r.recallRisk==null?"—":`${(r.recallRisk*100).toFixed(0)}%`}</td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-500">{r.lenders}</td>
                  <td className="px-3 py-1.5"><div className="flex items-center gap-1.5"><div className="h-1.5 w-12 rounded bg-slate-800"><div className="h-full rounded" style={{width:`${score*100}%`, background: score>0.6?"#f43f5e":score>0.35?"#f59e0b":"#64748b"}}/></div><span className="tabular-nums text-slate-400">{score.toFixed(2)}</span></div></td>
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
    if(active==="Spreads") return <Spreads/>;
    if(active==="Prime Finance") return <PrimeFinance/>;
    if(active==="Desk Risk") return <DeskRisk/>;
    if(active==="Processes") return <Processes/>;
    if(active==="Logs") return <Logs/>;
    return <Overview orders={orders}/>;
  },[active,orders]);
  return <div className="flex min-h-screen"><Nav active={active} setActive={setActive}/><main className="min-w-0 flex-1"><Header active={active}/><div className="p-4 md:p-6">{page}</div></main></div>
}
createRoot(document.getElementById("root")).render(<App/>);