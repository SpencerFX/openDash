"use strict";

// markout-feeder - synthetic but *correlated* trade/order/rate for openQ's
// markout module, so analytics/markOutImpact.q actually computes markout and
// impact curves (the generator's schema-blind random syms never match up).
//
// A fixed symbol set, each with a random-walking mid. A dense `rate` feed
// (every ~250ms) so grid offsets complete; a `trade` and an `order` every
// second or so, priced off the current mid. Published to markout_tp as q
// `upd[...]` strings.
//
//   node tools/markout-feeder.js
//
// Env: MARKOUT_TP_HOST (127.0.0.1), MARKOUT_TP_PORT (5030). Ctrl-C to stop.
// The markout grid runs to +/-10min, so the far ends of the curve only fill
// in after the feeder has been running that long; near offsets fill in seconds.

const { QConnection } = require("jkdb");

const TP = {
  host: process.env.MARKOUT_TP_HOST || "127.0.0.1",
  port: Number(process.env.MARKOUT_TP_PORT) || 5030,
};
const RATE_MS = 250;
const TRADE_MS = 1100;
const ORDER_MS = 1500;

const SYMS = [
  { sym: "EURUSD", mid: 1.0850, vol: 0.00004 },
  { sym: "USDJPY", mid: 156.20, vol: 0.006 },
  { sym: "GBPUSD", mid: 1.2720, vol: 0.00005 },
  { sym: "AUDUSD", mid: 0.6640, vol: 0.00003 },
];

let tradeID = 0;
let orderID = 0;

const pick = () => SYMS[(Math.random() * SYMS.length) | 0];
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

function qts(ms) {
  const d = new Date(ms), p = (x, w = 2) => String(x).padStart(w, "0");
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}D${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000`;
}
const px = (v) => v.toFixed(6);

function walk() {
  for (const s of SYMS) s.mid = Math.max(1e-4, s.mid + s.vol * gauss());
}

function ratesStmt() {
  const now = qts(Date.now());
  const ts = SYMS.map(() => now).join(" ");
  const sy = "`" + SYMS.map((s) => s.sym).join("`");
  const mids = SYMS.map((s) => px(s.mid + s.vol * 0.3 * gauss())).join(" ");
  return `upd[\`rate;(${ts};${sy};${mids})]`;
}

function tradeStmt() {
  const s = pick();
  tradeID += 1;
  const side = Math.random() < 0.5 ? 1 : -1;
  const price = s.mid * (1 + side * (0.2 + Math.random() * 1.8) / 1e4); // 0.2-2 bps off mid
  return `upd[\`trade;(enlist ${qts(Date.now())};enlist \`${s.sym};enlist ${tradeID}j;enlist ${px(price)})]`;
}

function orderStmt() {
  const s = pick();
  orderID += 1;
  const side = Math.random() < 0.5 ? "buy" : "sell";
  return `upd[\`order;(enlist ${qts(Date.now())};enlist \`${s.sym};enlist ${orderID}j;enlist ${px(s.mid)};enlist \`${side})]`;
}

const q = new QConnection(TP);
q.connect((e) => {
  if (e) { console.error("cannot reach markout_tp", TP, e.message); process.exit(1); }
  console.log(`feeding markout_tp:${TP.port}  rate/${RATE_MS}ms trade/${TRADE_MS}ms order/${ORDER_MS}ms  syms=${SYMS.map((s) => s.sym).join(",")}`);

  const send = (stmt) => q.asyn(stmt, (err) => { if (err) console.error("publish:", err.message); });

  const iR = setInterval(() => { walk(); send(ratesStmt()); }, RATE_MS);
  const iT = setInterval(() => send(tradeStmt()), TRADE_MS);
  const iO = setInterval(() => send(orderStmt()), ORDER_MS);
  setInterval(() => console.log(new Date().toISOString(), `trades=${tradeID} orders=${orderID}`), 15000);

  process.on("SIGINT", () => {
    clearInterval(iR); clearInterval(iT); clearInterval(iO);
    q.close(() => process.exit(0));
  });
});
