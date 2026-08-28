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

// `push` is a transient mid displacement in the direction of recent order/
// trade flow - it decays each tick, so orders leave a real (temporary +
// small permanent) footprint in the mid for the markout/impact analytics to
// pick up, rather than the flow being pure noise.
// all near-1 priced: analytics/deskRisk.q's markoutBySym does 1e4*<abs price
// diff> (no /price), so a non-unit-priced sym like USDJPY blows the bps scale
const SYMS = [
  { sym: "EURUSD", mid: 1.0850, vol: 0.00004, push: 0 },
  { sym: "GBPUSD", mid: 1.2720, vol: 0.00005, push: 0 },
  { sym: "AUDUSD", mid: 0.6640, vol: 0.00003, push: 0 },
  { sym: "NZDUSD", mid: 0.6100, vol: 0.00003, push: 0 },
  { sym: "EURGBP", mid: 0.8530, vol: 0.00003, push: 0 },
];
const PUSH_DECAY = 0.82;      // fraction of push retained each ~250ms tick (~decay over ~4s)
const PUSH_PERMANENT = 0.06;  // fraction of each impulse that sticks in the mid

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
  for (const s of SYMS) {
    const decayed = s.push * (1 - PUSH_DECAY);        // leaves the transient this tick
    s.mid = Math.max(1e-4, s.mid + s.vol * gauss() + decayed * PUSH_PERMANENT);
    s.push *= PUSH_DECAY;                             // transient part relaxes back
  }
}

// an order/trade of `dir` (+1 buy / -1 sell) nudges its sym's quoted mid its way
function impulse(s, dir, sizeBps) {
  s.push += dir * s.vol * sizeBps;
}

// the mid the market actually shows = base mid + current transient push
const shownMid = (s) => s.mid + s.push;

function ratesStmt() {
  const now = qts(Date.now());
  const ts = SYMS.map(() => now).join(" ");
  const sy = "`" + SYMS.map((s) => s.sym).join("`");
  const mids = SYMS.map((s) => px(shownMid(s) + s.vol * 0.3 * gauss())).join(" ");
  return `upd[\`rate;(${ts};${sy};${mids})]`;
}

function tradeStmt() {
  const s = pick();
  tradeID += 1;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const sizeBps = 0.2 + Math.random() * 1.8;
  // price off the mid AS IT STANDS NOW; the impulse moves the market after
  const price = shownMid(s) * (1 + dir * sizeBps / 1e4);
  impulse(s, dir, 0.35 * sizeBps);
  return `upd[\`trade;(enlist ${qts(Date.now())};enlist \`${s.sym};enlist ${tradeID}j;enlist ${px(price)})]`;
}

function orderStmt() {
  const s = pick();
  orderID += 1;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const side = dir > 0 ? "buy" : "sell";
  const rate = shownMid(s);                    // arrival mid, before this order moves it
  impulse(s, dir, 0.8 + Math.random() * 1.0);  // orders move the mid more than a print
  return `upd[\`order;(enlist ${qts(Date.now())};enlist \`${s.sym};enlist ${orderID}j;enlist ${px(rate)};enlist \`${side})]`;
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
