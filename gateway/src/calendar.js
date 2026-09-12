"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// fxStreet economic-calendar archive (C:/data/calendar, schemas/schema_calendar.q
// - the `econCal` table) fronted by calendar_hdb (cfg_proc/modules/calendar/hdb.json,
// port 5078) for the eFX > Economic Calendar page. ~204k rows spanning 2010-01
// through whatever econCalScraper last scraped (see modules/ingest/calendar/README.md);
// a plain date-range + optional country/importance/category filter, range capped
// to maxRangeDays so a fat-fingered multi-year request can't pull the whole archive
// through one call. Every request also gets the archive's real min/max date back
// (a near-free query - selecting only the virtual `date` column off a partitioned
// table returns one row per partition, not per record) so the frontend's range
// picker can clamp to what's actually there instead of a guessed constant.

const qDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
};
const dstr = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10);
const num = (v) => (v == null || Number.isNaN(v) ? null : Number(v));

// A q symbol-list literal built via `$(...)` cast-from-strings - the only
// reliable way to embed a symbol containing a space (category names like
// "Central Banks", "Economic Activity") or arbitrary filter input safely.
// Values are stripped to a conservative charset first (this becomes literal
// q source, not a bound parameter).
const qSymList = (arr) => {
  const clean = (Array.isArray(arr) ? arr : [])
    .map((s) => String(s).replace(/[^A-Za-z0-9 _-]/g, "").trim())
    .filter(Boolean);
  if (!clean.length) return "`symbol$()";
  return "`$(" + clean.map((s) => JSON.stringify(s)).join(";") + ")";
};

const QUERY = (sD, eD, countries, importances, categories) => `
{[sD;eD;ctys;imps;cats]
  bounds:select minDate:min date, maxDate:max date from select date from econCal;
  t:select date,time,country,currency,category,event,importance,
      actual,consensus,previous,revised,unit,potency,
      allDay,tentative,preliminary,report,speech,eventId
    from econCal where date within (sD;eD);
  if[count ctys; t:select from t where country in ctys];
  if[count imps; t:select from t where importance in imps];
  if[count cats; t:select from t where category in cats];
  \`minDate\`maxDate\`rows!(first bounds\`minDate; first bounds\`maxDate; \`date\`time xasc t)
 }[${sD};${eD};${qSymList(countries)};${qSymList(importances)};${qSymList(categories)}]`;

class EconCalendarReader {
  constructor(opts) {
    this.enabled = opts.enabled !== false;
    this.maxRangeDays = Math.max(1, opts.maxRangeDays || 62);
    this.timeoutMs = Math.max(3000, opts.timeoutMs || 15000);
    this.session = new QSession({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      timeoutMs: this.timeoutMs,
      reconnectMs: 2000,
      label: "calendar-hdb",
    });
  }

  start() { this.session.start(); return this; }
  async stop() { await this.session.stop(); }
  get connected() { return this.session.connected; }

  status() {
    return { enabled: this.enabled, target: this.session.target, connected: this.session.connected };
  }

  _requireUp() {
    if (!this.session.connected) {
      const e = new Error(
        `calendar_hdb not reachable at ${this.session.target} - start it ` +
          `(scripts/startStop/startupAllByModule.sh calendar)`
      );
      e.statusCode = 503;
      throw e;
    }
  }

  _rows(tbl) {
    return (toRows(tbl).rows || []).map((r) => {
      const o = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        o[k] =
          v instanceof Date
            ? v.toISOString()
            : typeof v === "bigint"
            ? Number(v)
            : typeof v === "boolean"
            ? v
            : v;
      }
      return o;
    });
  }

  async read(query = {}) {
    if (!this.enabled) {
      const e = new Error("calendar disabled");
      e.statusCode = 503;
      throw e;
    }
    this._requireUp();

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const addDays = (d, n) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; };

    // default: the current week (Monday..Sunday) - a real econ-calendar
    // default, with recent-past context and the rest of the week ahead.
    const dow = (today.getUTCDay() + 6) % 7; // 0=Mon
    const defStart = addDays(today, -dow);
    const defEnd = addDays(defStart, 6);

    const sLit = qDate(query.start) || iso(defStart).replace(/-/g, ".");
    const eLit = qDate(query.end) || iso(defEnd).replace(/-/g, ".");

    // clamp order + max span (compare as plain yyyy.mm.dd strings - safe,
    // lexicographic order matches date order for this fixed-width format)
    let [lo, hi] = sLit <= eLit ? [sLit, eLit] : [eLit, sLit];
    const loD = new Date(lo.replace(/\./g, "-"));
    const hiD = new Date(hi.replace(/\./g, "-"));
    const spanDays = Math.round((hiD - loD) / 86400000);
    if (spanDays > this.maxRangeDays) {
      hi = iso(addDays(loD, this.maxRangeDays)).replace(/-/g, ".");
    }

    const countries = String(query.country || "").split(",").map((s) => s.trim()).filter(Boolean);
    const importances = String(query.importance || "").split(",").map((s) => s.trim()).filter(Boolean);
    const categories = String(query.category || "").split(",").map((s) => s.trim()).filter(Boolean);

    const started = Date.now();
    const d = await this.session.sync(QUERY(lo, hi, countries, importances, categories), {
      timeoutMs: this.timeoutMs,
    });

    const rows = this._rows(d.rows).map((r) => ({
      date: dstr(r.date),
      time: r.time == null ? null : String(r.time).slice(0, 8),
      country: r.country == null ? null : String(r.country),
      currency: r.currency == null ? null : String(r.currency),
      category: r.category == null ? null : String(r.category),
      event: r.event == null ? null : String(r.event),
      importance: r.importance == null ? null : String(r.importance),
      actual: num(r.actual),
      consensus: num(r.consensus),
      previous: num(r.previous),
      revised: num(r.revised),
      unit: r.unit == null ? null : String(r.unit),
      potency: r.potency == null ? null : String(r.potency),
      allDay: !!r.allDay,
      tentative: !!r.tentative,
      preliminary: !!r.preliminary,
      report: !!r.report,
      speech: !!r.speech,
      eventId: r.eventId == null ? null : String(r.eventId),
    }));

    return {
      connected: true,
      target: this.session.target,
      computedMs: Date.now() - started,
      meta: {
        start: dstr(lo.replace(/\./g, "-")),
        end: dstr(hi.replace(/\./g, "-")),
        requestedSpanDays: spanDays,
        maxRangeDays: this.maxRangeDays,
        archiveMinDate: dstr(d.minDate),
        archiveMaxDate: dstr(d.maxDate),
        nRows: rows.length,
      },
      rows,
    };
  }
}

module.exports = { EconCalendarReader };
