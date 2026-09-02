"use strict";

const fs = require("fs");

// Serves openQ's data catalog (schemas/catalog.json) - a curated dictionary
// of every table's columns, kdb+ types and plain-English descriptions -
// to the dashboard's Data > Catalog page. Reloads on file change (mtime
// check) so edits to the JSON show up without a gateway restart.

class CatalogReader {
  constructor(file) {
    this.file = file;
    this._cache = null;
    this._mtimeMs = 0;
  }

  _load() {
    const st = fs.statSync(this.file); // throws if missing -> 503 in the route
    if (this._cache && st.mtimeMs === this._mtimeMs) return this._cache;
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    const groups = Array.isArray(raw.groups) ? raw.groups : [];
    const groupRank = new Map(groups.map((g, i) => [g.name, i]));

    const tables = (raw.tables || []).map((t) => ({
      name: t.name,
      schema: t.schema || null,
      pipeline: t.pipeline || null,
      group: t.group || t.pipeline || "Other",
      key: Array.isArray(t.key) ? t.key : [],
      desc: t.desc || "",
      columns: (t.columns || []).map((c) => ({
        name: c.name,
        type: c.type || raw.types?.[c.kdb] || c.kdb || "",
        kdb: c.kdb || "",
        desc: c.desc || "",
      })),
    }));
    // stable order: catalog-defined group order, then table name
    const rankOf = (g) => (groupRank.has(g) ? groupRank.get(g) : 999);
    tables.sort(
      (a, b) =>
        rankOf(a.group) - rankOf(b.group) ||
        String(a.group).localeCompare(String(b.group)) ||
        String(a.name).localeCompare(String(b.name))
    );
    this._cache = {
      file: this.file,
      types: raw.types || {},
      groups,
      generatedAt: new Date().toISOString(),
      counts: {
        tables: tables.length,
        columns: tables.reduce((n, t) => n + t.columns.length, 0),
        groups: [...new Set(tables.map((t) => t.group))].length,
      },
      tables,
    };
    this._mtimeMs = st.mtimeMs;
    return this._cache;
  }

  read() {
    return this._load();
  }

  status() {
    try {
      const c = this._load();
      return { enabled: true, file: this.file, ...c.counts };
    } catch (e) {
      return { enabled: true, file: this.file, error: e.message };
    }
  }
}

module.exports = { CatalogReader };
