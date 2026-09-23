"use strict";

// Helpers that render validated JS values as q literal text.
//
// The gateway service never forwards a client-supplied string verbatim into
// q. Every dynamic part of a query (table name, symbols, time bounds) is
// validated here and re-emitted as a literal, so `.oq.gw.query[...]` is
// assembled from known-safe pieces only. Anything that fails validation
// throws a BadInput error the REST layer turns into a 400.

class BadInput extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BadInput";
    this.statusCode = 400;
  }
}

const SYMBOL_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;
// a `like` pattern: a symbol with q wildcards ? and * allowed
const PATTERN_RE = /^[A-Za-z0-9_.?*]+$/;
// Yahoo-style tickers (yfinance eq/fx feeds): digits, letters, '.', '-' -
// e.g. 0005.HK, 7203.T, BRK-B. These can start with a digit or contain '.'/
// '-', which q's bare `sym token syntax can't express (a leading digit or a
// bare '-' doesn't parse as part of a symbol token at all). Cast a validated
// string instead - `$"0005.HK"` is a valid symbol literal for any string,
// once quotes/backslashes are excluded by the regex.
const YAHOO_SYM_RE = /^[0-9A-Za-z.\-]{1,14}$/;

function assert(cond, msg) {
  if (!cond) throw new BadInput(msg);
}

// `sym  (single symbol atom literal)
function symbolLit(name) {
  assert(typeof name === "string" && SYMBOL_RE.test(name), `invalid q symbol: ${JSON.stringify(name)}`);
  return "`" + name;
}

// `a`b`c  (symbol vector literal); one element still renders as an atom which
// .oq.query.root handles via its `in` branch
function symbolVecLit(names) {
  assert(Array.isArray(names) && names.length > 0, "expected a non-empty array of symbols");
  return names.map(symbolLit).join("");
}

// q string literal "..."  (used for `like` patterns)
function stringLit(s) {
  assert(typeof s === "string" && PATTERN_RE.test(s), `invalid pattern: ${JSON.stringify(s)}`);
  return '"' + s + '"';
}

// `$"0005.HK"  (Yahoo-ticker symbol atom literal, via cast rather than a
// bare backtick token - see YAHOO_SYM_RE above)
function yahooSymbolLit(name) {
  assert(typeof name === "string" && YAHOO_SYM_RE.test(name), `invalid ticker: ${JSON.stringify(name)}`);
  return `\`$"${name}"`;
}

// A plain integer literal, e.g. for count/window-size args that aren't
// table/symbol/time data (.util.gw.mon's nRecent/nSlow/winMin/histMin).
function intLit(n) {
  assert(Number.isInteger(n), `expected an integer: ${JSON.stringify(n)}`);
  return String(n);
}

// A q float literal - e.g. .brk.api.hourly's zCut (a z-score cutoff, not an
// integer count). q parses a bare digit string as a long int atom, not a
// float, so a whole-number value needs an explicit `f` suffix to land as
// the float type the receiving function expects.
function floatLit(n) {
  assert(typeof n === "number" && Number.isFinite(n), `expected a finite number: ${JSON.stringify(n)}`);
  const s = String(n);
  return /[.e]/i.test(s) ? s : `${s}f`;
}

// `$"Some Broker Name"  (cast symbol atom literal covering the broker-tag /
// instrument-symbol shapes the brokerTech.* pages take - letters, digits,
// spaces, '.', '_', '-'. Broader than SYMBOL_RE/YAHOO_SYM_RE, which don't
// allow spaces; narrower than a q string literal, which would allow
// quotes/backslashes this never needs to carry.)
const CAST_SYM_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
function castSymbolLit(name) {
  assert(typeof name === "string" && CAST_SYM_RE.test(name), `invalid symbol: ${JSON.stringify(name)}`);
  return `\`$"${name}"`;
}

// The null symbol atom - openQ's "no filter" sentinel for an optional
// brokerTag/instrument arg (.brk.broker.filterTrades's own convention).
const NULL_SYM = "`";

// A q timestamp literal: 2026.08.28D12:34:56.789000000
function timestampLit(v) {
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") d = new Date(v);
  else if (typeof v === "string") d = new Date(v);
  else throw new BadInput(`cannot read a timestamp from ${JSON.stringify(v)}`);
  assert(!Number.isNaN(d.getTime()), `invalid timestamp: ${JSON.stringify(v)}`);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const date = `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000`;
  return `${date}D${time}`;
}

// null symbol - openQ's "open ended / all" sentinel for every .oq.gw.query arg
const NULL = "`";

// Build the exact string a q client would send as
//   neg[h] (`.oq.gw.query; `table; sCols; sTime; eTime; symb; whereC)
// jkdb serializes it as a char vector; the gw's .z.ps does `value` on it.
//
// spec: { table, columns?, start?, end?, sym?, symPattern? }
//
// `sym` here is a *single* symbol. openQ's .oq.query.root wraps the sym arg
// in `enlist` before an `in` where-clause, which only produces a usable
// clause for a symbol atom - so multi-symbol filtering is done by the pool
// layer as one query per symbol, each built through here. `symPattern` uses
// the `like` branch instead and takes q wildcards.
function buildGwQuery(spec) {
  assert(spec && typeof spec === "object", "query spec must be an object");

  const table = symbolLit(spec.table);

  let sCols = NULL;
  if (spec.columns != null && !(Array.isArray(spec.columns) && spec.columns.length === 0)) {
    const cols = Array.isArray(spec.columns) ? spec.columns : [spec.columns];
    sCols = symbolVecLit(cols);
  }

  // openQ's .oq.query.root throws `type when exactly one of sTime/eTime is a
  // real timestamp and the other is the ` sentinel (it evaluates
  // `date$(sTime;eTime) for the HDB date clause). Both-null and both-set are
  // fine, so when only one bound is given we materialise the other at the edge
  // of the representable range.
  // q's timestamp (-12h) is int64 nanoseconds since 2000.01.01 - it overflows
  // and fails to parse well before year 2999 (max representable is ~2262).
  // 2200 is comfortably inside range and just as good as "infinity" here.
  const MIN_TS = "2000.01.01D00:00:00.000000000";
  const MAX_TS = "2200.01.01D00:00:00.000000000";
  let sTime = spec.start == null ? NULL : timestampLit(spec.start);
  let eTime = spec.end == null ? NULL : timestampLit(spec.end);
  if (sTime !== NULL && eTime === NULL) eTime = MAX_TS;
  if (eTime !== NULL && sTime === NULL) sTime = MIN_TS;

  let symb = NULL;
  if (spec.symPattern != null) {
    symb = stringLit(spec.symPattern); // -> `like`
  } else if (spec.yahooSym != null) {
    assert(typeof spec.yahooSym === "string", "buildGwQuery takes one sym string; fan out for multiple");
    symb = yahooSymbolLit(spec.yahooSym); // -> `in` (atom, cast form - see YAHOO_SYM_RE)
  } else if (spec.sym != null) {
    assert(typeof spec.sym === "string", "buildGwQuery takes one sym string; fan out for multiple");
    symb = symbolLit(spec.sym); // -> `in` (atom)
  }

  // whereC is intentionally always ` - arbitrary where-clauses are not
  // exposed over HTTP.
  const whereC = NULL;

  return `.oq.gw.query[${table};${sCols};${sTime};${eTime};${symb};${whereC}]`;
}

module.exports = {
  BadInput,
  symbolLit,
  symbolVecLit,
  stringLit,
  yahooSymbolLit,
  intLit,
  floatLit,
  castSymbolLit,
  NULL_SYM,
  timestampLit,
  buildGwQuery,
  SYMBOL_RE,
  YAHOO_SYM_RE,
};
