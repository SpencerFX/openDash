"use strict";

// spread-feeder - synthetic spreadQuote rows for openQ's spread module, so
// analytics/spread.q's build-up attribution has something to compose.
//
// A quote in schema_spread.q is already broken into 7 named components
// (refSprd..alphaSprd) that sum to the quoted spread. A real pricing engine
// emits these; here we synthesise plausible sub-bps values across a fixed
// symbol x aggression x marketStatus grid, drifting each tick. Published to
// spread_tp as a q `upd[...]` string. Unlike markout there's no future data
// to wait for - every quote is fully explainable on arrival.
//
//   node tools/spread-feeder.js
//
// Env: SPREAD_TP_HOST (127.0.0.1), SPREAD_TP_PORT (5055). Ctrl-C to stop.

const { QConnection } = require("jkdb");

const TP = {
  host: process.env.SPREAD_TP_HOST || "127.0.0.1",
  port: Number(process.env.SPREAD_TP_PORT) || 5055,
};
const TICK_MS = 800;

const SYMS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "EURGBP"];
const AGG = ["low", "medium", "high"];
const MKT = ["normal", "stressed"];

// per-key drifting state, keyed "sym|agg|mkt"
const state = new Map();
const key = (s, a, m) => `${s}|${a}|${m}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const jit = (v, d) => v + (Math.random() - 0.5) * d;

function baseFor(a, m) {
  const aggMul = a === "low" ? 0.8 : a === "high" ? 1.5 : 1.0;
  const stressed = m === "stressed";
  return {
    refSprd: 0.75 * aggMul,
    baseSprd: 0.30 * aggMul,
    clientSprd: (a === "high" ? 0.15 : a === "low" ? -0.05 : 0.05),
    volSprd: stressed ? 0.55 : 0.12,
    smoothSprd: 0.04,
    fallbackSprd: stressed ? 0.22 : 0.03,
    alphaSprd: 0.0,
  };
}

function step(s, a, m) {
  const k = key(s, a, m);
  let st = state.get(k);
  if (!st) { st = baseFor(a, m); state.set(k, st); }
  st.refSprd = clamp(jit(st.refSprd, 0.03), 0.4, 2.0);
  st.baseSprd = clamp(jit(st.baseSprd, 0.02), 0.1, 1.0);
  st.clientSprd = clamp(jit(st.clientSprd, 0.02), -0.2, 0.3);
  st.volSprd = clamp(jit(st.volSprd, m === "stressed" ? 0.08 : 0.03), 0, 1.2);
  st.smoothSprd = clamp(jit(st.smoothSprd, 0.01), 0, 0.15);
  st.fallbackSprd = clamp(jit(st.fallbackSprd, 0.03), 0, 0.5);
  st.alphaSprd = clamp(jit(st.alphaSprd, 0.03), -0.25, 0.25);
  return st;
}

function qts(ms) {
  const d = new Date(ms), p = (x, w = 2) => String(x).padStart(w, "0");
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}D${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000`;
}
// component state above is tracked in bps units for readability; the schema
// stores price-fraction values (analytics/spread.q reports bps as 1e4*value)
const f = (v) => (v * 1e-4).toFixed(10);

let ticks = 0;

function stmt() {
  // a random subset of the grid each tick
  const rows = [];
  for (const s of SYMS) for (const a of AGG) for (const m of MKT) {
    if (Math.random() < 0.45) rows.push({ s, a, m, st: step(s, a, m) });
  }
  if (!rows.length) rows.push({ s: "EURUSD", a: "medium", m: "normal", st: step("EURUSD", "medium", "normal") });
  ticks += rows.length;

  const n = rows.length;
  const now = qts(Date.now());
  const col = (fn) => rows.map(fn).join(" ");
  return (
    "upd[`spreadQuote;(" +
    `${Array(n).fill(now).join(" ")};` +
    "`" + rows.map((r) => r.s).join("`") + ";" +
    "`" + rows.map((r) => r.a).join("`") + ";" +
    "`" + rows.map((r) => r.m).join("`") + ";" +
    col((r) => (1 + Math.random() * 9).toFixed(2)) + "e6;" +          // weight (notional)
    col((r) => f(r.st.refSprd)) + ";" +
    col((r) => f(r.st.baseSprd)) + ";" +
    col((r) => f(r.st.clientSprd)) + ";" +
    col((r) => f(r.st.volSprd)) + ";" +
    col((r) => f(r.st.smoothSprd)) + ";" +
    col((r) => f(r.st.fallbackSprd)) + ";" +
    col((r) => f(r.st.alphaSprd)) +
    ")]"
  );
}

const q = new QConnection(TP);
q.connect((e) => {
  if (e) { console.error("cannot reach spread_tp", TP, e.message); process.exit(1); }
  console.log(`feeding spread_tp:${TP.port} every ${TICK_MS}ms  grid=${SYMS.length}x${AGG.length}x${MKT.length}`);
  const send = () => q.asyn(stmt(), (err) => { if (err) console.error("publish:", err.message); });
  send();
  const id = setInterval(send, TICK_MS);
  const log = setInterval(() => console.log(new Date().toISOString(), `quotes=${ticks}`), 15000);
  process.on("SIGINT", () => { clearInterval(id); clearInterval(log); q.close(() => process.exit(0)); });
});
