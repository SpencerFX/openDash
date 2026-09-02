"use strict";

const config = require("./src/config");
const { createServer } = require("./src/server");

// A stray rejected promise (e.g. a background cache refresh whose q sync
// timed out) must not take the whole gateway down - log and carry on.
process.on("unhandledRejection", (err) => {
  console.error("[gateway] unhandledRejection:", err && err.stack ? err.stack : err);
});

async function main() {
  const app = createServer();
  const { targets } = await app.start();

  console.log(`[gateway] listening on http://localhost:${config.port}`);
  for (const [name, opts] of Object.entries(config.targets)) {
    const st = targets[name] || { connected: 0 };
    const dflt = name === config.defaultTarget ? " (default)" : "";
    console.log(
      `[gateway] target ${name}${dflt} -> ${opts.host}:${opts.port} - ${st.connected}/${opts.poolSize} pooled connections up`
    );
  }
  console.log(
    config.stream.enabled
      ? `[gateway] streaming from ${config.stream.host}:${config.stream.port} (ws /stream)`
      : `[gateway] streaming disabled (set OPENQ_STREAM_PORT to a tp/rdb port)`
  );

  const shutdown = async (sig) => {
    console.log(`\n[gateway] ${sig} - shutting down`);
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[gateway] failed to start:", err);
  process.exit(1);
});
