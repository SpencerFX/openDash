"use strict";

// Quick manual check against a running openQ gw.
//   node scripts/smoke.js [table]
// Honours the same env / .env as the service (OPENQ_GW_HOST, OPENQ_GW_PORT, ...).

const config = require("../src/config");
const { QGateway } = require("../src/qGateway");
const { toRows } = require("../src/qshape");

const table = process.argv[2] || "quote";

(async () => {
  const gw = new QGateway(config.gw);
  const { connected } = await gw.start();
  console.log(`connected ${connected}/${config.gw.poolSize} to ${config.gw.host}:${config.gw.port}`);
  if (!connected) {
    console.error("no gateway connection - is openQ's gw process up?");
    process.exit(1);
  }

  try {
    const { data, queryId } = await gw.query({ table });
    const shaped = toRows(data);
    console.log(`queryId=${queryId} rows=${shaped.count ?? "-"}`);
    if (shaped.rows) {
      console.log("columns:", shaped.columns.join(", "));
      console.table(shaped.rows.slice(0, 5));
    } else {
      console.log("value:", shaped.value);
    }
  } catch (err) {
    console.error("query failed:", err.message);
    process.exitCode = 1;
  } finally {
    await gw.stop();
  }
})();
