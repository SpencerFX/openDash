"use strict";

const { QSession } = require("./qSession");
const { toRows } = require("./qshape");

// Base for the analytics endpoints (markout / spread / prime). Each is the
// same shape: one reconnecting QSession to a module CEP, a bag of named
// canned q queries run together, and a subclass `read()` that shapes the
// raw results into the HTTP response.
//
//   class FooReader extends CepReader {
//     constructor(opts) { super(opts, { curve: "0!select ...", summary: "`a`b!(...)" }); }
//     async read() {
//       const r = await this._run({ optional: ["bySym"] });
//       return { connected: this.connected, ...shape(r.curve.rows, r.summary.value) };
//     }
//   }
class CepReader {
  // opts: { host, port, user?, password?, timeoutMs? }
  constructor(opts, queries) {
    this.opts = opts;
    this.queries = queries;
    this.session = new QSession({ ...opts, label: this.constructor.name });
  }

  start() {
    this.session.start();
  }

  async stop() {
    await this.session.stop();
  }

  get connected() {
    return this.session.connected;
  }

  get target() {
    return this.session.target;
  }

  status() {
    return { enabled: true, ...this.session.status() };
  }

  // Run the canned queries in parallel; returns { name: toRows(raw), ... }.
  // Names in `optional` yield an empty result instead of failing the batch.
  async _run({ names = Object.keys(this.queries), optional = [] } = {}) {
    const entries = await Promise.all(
      names.map((name) =>
        this.session.sync(this.queries[name]).then(
          (raw) => [name, toRows(raw)],
          (err) => {
            if (optional.includes(name)) return [name, { rows: [], value: {} }];
            throw err;
          }
        )
      )
    );
    return Object.fromEntries(entries);
  }
}

module.exports = { CepReader };
