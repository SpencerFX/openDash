"use strict";

// prime-feeder - keeps openQ's primefinance module moving so its dashboard
// has live data. modules/primefinance/simulator.q is one-shot; this drives a
// continuous stream:
//   * inventory refreshes  -> primefinance_tp  (relayed + recorded)
//   * short positions      -> primefinance_tp
//   * borrows              -> primefinance_tp
//   * recalls              -> primefinance_tp  (triggers .prime.applyRecall + alert)
//   * locate requests      -> primefinance_cep via a runLocate IPC wrapper
//                             (locates aren't wired to any tp event)
//
//   node tools/prime-feeder.js
//
// Env: PRIME_TP (127.0.0.1:5070), PRIME_CEP (127.0.0.1:5074). Ctrl-C to stop.

const { QConnection } = require("jkdb");

const [tpH, tpP] = (process.env.PRIME_TP || "127.0.0.1:5070").split(":");
const [cepH, cepP] = (process.env.PRIME_CEP || "127.0.0.1:5074").split(":");
const TICK_MS = 1800;

// sym -> borrow profile: base fee (bp), depth, recall risk
const SYMS = {
  AAPL: { fee: 25, depth: 90000, recall: 0.05, px: 190 },
  MSFT: { fee: 18, depth: 80000, recall: 0.04, px: 430 },
  NVDA: { fee: 20, depth: 95000, recall: 0.05, px: 900 },
  TSLA: { fee: 90, depth: 30000, recall: 0.12, px: 250 },
  AMD:  { fee: 70, depth: 35000, recall: 0.10, px: 160 },
  GME:  { fee: 460, depth: 6000, recall: 0.45, px: 18 },
  AMC:  { fee: 380, depth: 8000, recall: 0.38, px: 5 },
};
const SYM_NAMES = Object.keys(SYMS);
const LENDERS = ["PB", "BANKA", "BANKB", "BANKC"];
const CLIENTS = ["FUND1", "FUND2", "FUND3", "FUND4"];

const pick = (a) => a[(Math.random() * a.length) | 0];
const ri = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const jit = (v, pct) => v * (1 + (Math.random() - 0.5) * pct);

function qts(ms) {
  const d = new Date(ms), p = (x, w = 2) => String(x).padStart(w, "0");
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}D${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000`;
}
const now = () => qts(Date.now());
const plus = (mins) => qts(Date.now() + mins * 60000);

let tp, cep;
let locateID = 20000;
const send = (h, stmt) => h.asyn(stmt, (e) => { if (e) console.error("publish:", e.message); });

// upd needs a list of column vectors, positional to the schema
function invRow(sym, lender) {
  const s = SYMS[sym];
  return `upd[\`inventory;(enlist ${now()};enlist \`${sym};enlist \`${lender};` +
    `enlist ${Math.round(jit(s.depth, 0.5))}j;enlist ${jit(s.fee, 0.3).toFixed(2)};enlist ${ri(1, 5)}i;` +
    `enlist ${jit(s.recall, 0.4).toFixed(3)};enlist ${(0.05 + Math.random() * 0.25).toFixed(3)};enlist ${pick([100, 500, 1000])}j)]`;
}
function posRow(client, sym, qty) {
  return `upd[\`position;(enlist ${now()};enlist \`${sym};enlist \`${client};enlist ${qty}j;enlist ${SYMS[sym].px}f)]`;
}
function borrowRow(client, sym, lender, qty) {
  return `upd[\`borrow;(enlist ${now()};enlist \`${sym};enlist \`${client};enlist \`${lender};` +
    `enlist ${qty}j;enlist ${jit(SYMS[sym].fee, 0.2).toFixed(2)};enlist ${plus(ri(1, 8))})]`;
}
function recallRow(lender, sym, qty, sev) {
  return `upd[\`recall;(enlist ${now()};enlist \`${sym};enlist \`${lender};enlist ${qty}j;enlist \`${sev};enlist ${plus(ri(10, 40))})]`;
}
function locateCall(client, sym, qty, prio) {
  return `runLocate[${++locateID}j;\`${client};\`${sym};${qty}j;${prio}i;()]`;
}

function tick() {
  const roll = Math.random();
  if (roll < 0.50) {
    // a client shorts a name, then requests a locate to cover (most of) it
    const client = pick(CLIENTS), sym = pick(SYM_NAMES);
    const size = ri(3, 40) * 1000;
    send(tp, posRow(client, sym, -size));
    const ask = Math.round(size * (0.7 + Math.random() * 0.5)); // 70-120% of the short
    send(cep, locateCall(client, sym, ask, ri(50, 99)));
  } else if (roll < 0.68) {
    // inventory refresh for one sym/lender
    send(tp, invRow(pick(SYM_NAMES), pick(LENDERS)));
  } else if (roll < 0.80) {
    // a client covers part of a short
    send(tp, posRow(pick(CLIENTS), pick(SYM_NAMES), ri(2, 20) * 1000));
  } else if (roll < 0.92) {
    // a borrow, near-term expiry so the CEP sweep raises buy-ins
    send(tp, borrowRow(pick(CLIENTS), pick(SYM_NAMES), pick(LENDERS), ri(2, 25) * 1000));
  } else {
    // a recall
    const sym = pick(SYM_NAMES);
    send(tp, recallRow(pick(LENDERS), sym, ri(2, 20) * 1000, Math.random() < 0.4 ? "HIGH" : "MEDIUM"));
  }
}

function boot() {
  // define the locate wrapper on the CEP (same shape as simulator.q)
  cep.asyn(
    "runLocate:{[locateID;client;sym;requested;priority;constraints]" +
    " .prime.newLocate[locateID;client;sym;requested;priority;.prime.inventory;constraints;.z.p+0D00:30:00]}",
    (e) => { if (e) console.error("define runLocate:", e.message); }
  );
  // seed full inventory grid
  for (const sym of SYM_NAMES) for (const lender of LENDERS) send(tp, invRow(sym, lender));
  console.log(`prime-feeder -> tp ${tpH}:${tpP}, cep ${cepH}:${cepP}, every ${TICK_MS}ms`);
}

function start(host, port) {
  return new Promise((res, rej) => {
    const c = new QConnection({ host, port: Number(port) });
    c.connect((e) => (e ? rej(new Error(`${host}:${port} ${e.message}`)) : res(c)));
  });
}

(async () => {
  try {
    tp = await start(tpH, tpP);
    cep = await start(cepH, cepP);
  } catch (e) {
    console.error("connect failed:", e.message);
    process.exit(1);
  }
  boot();
  tick();
  const id = setInterval(tick, TICK_MS);
  const log = setInterval(() => console.log(new Date().toISOString(), `locates issued: ${locateID - 20000}`), 15000);
  process.on("SIGINT", () => {
    clearInterval(id); clearInterval(log);
    Promise.all([new Promise((r) => tp.close(r)), new Promise((r) => cep.close(r))]).then(() => process.exit(0));
  });
})();
