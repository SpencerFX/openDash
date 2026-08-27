"use strict";

// jkdb deserializes a q table (k type 98) to a column-oriented object:
//   { timestamp: [Date, ...], sym: ["EURUSD", ...], bid: [1.08, ...] }
// The dashboard wants row objects. These helpers convert, and JSON-normalise
// values q hands back (Date -> ISO string, BigInt -> string).

function isColumnarTable(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const vals = Object.values(x);
  if (vals.length === 0) return false;
  if (!vals.every((v) => Array.isArray(v))) return false;
  const len = vals[0].length;
  return vals.every((v) => v.length === len);
}

function jsonSafe(v) {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = jsonSafe(val);
    return o;
  }
  return v;
}

// Returns { columns, rows } for a table; { value } for anything else.
function toRows(data) {
  if (isColumnarTable(data)) {
    const columns = Object.keys(data);
    const n = data[columns[0]].length;
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = {};
      for (const c of columns) row[c] = jsonSafe(data[c][i]);
      rows[i] = row;
    }
    return { columns, rows, count: n };
  }
  return { value: jsonSafe(data) };
}

module.exports = { isColumnarTable, jsonSafe, toRows };
