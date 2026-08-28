# openQ Dashboard Gateway

A small Node.js service that sits between the browser dashboard and the openQ
`gw` (kdb+ gateway) process, speaking **q IPC** via
[`jkdb`](../../jkdb). The dashboard talks plain HTTP + WebSocket to this service;
this service talks q to openQ. No q/kdb+ runs in the browser.

```
browser (openq-dashboard)
      │  HTTP  /api/query          WebSocket /stream
      ▼
openq-dashboard-gateway  (this)
      │  q IPC (jkdb)                       q IPC (jkdb, .u.sub)
      ▼                                     ▼
openQ  gw :5013  ──►  rdb :5011 / hdb :5012      openQ  tp :5010  (or rdb)
       .oq.gw.query                                   `upd feed
```

## Why a service and not a browser-side client

* openQ's `gw` answers `.oq.gw.query` by sending the result back as an **async
  message** (`` `error`data`stack`queryID! `` dict), not as a sync response, and
  it allocates the `queryID` itself. A caller therefore can't de-multiplex
  concurrent replies on one shared connection, so this service keeps a **pool**
  of q connections, one in-flight query per connection.
* q IPC is a binary TCP protocol — not reachable from a browser at all.

## Requirements

* Node.js >= 18
* A reachable openQ `gw` process (see the openQ repo's `scripts/startup.sh`)
* The local `jkdb` build: this service depends on `file:../../jkdb`, which must
  contain `jkdb.min.js`. If it's missing:
  ```
  cd ../../jkdb && npm install && npx rollup --config
  ```
  This service needs jkdb's `message` event (emitted by that build) to see
  gateway replies.

## Run

```bash
npm install
cp .env.example .env      # edit if openQ isn't on the default ports
npm start
```

`npm run smoke` runs a one-shot `.oq.gw.query` against the configured gw and
prints the first rows — a quick "is the wiring live" check.

## Configuration

All via env (or `.env`, same keys). Defaults in `.env.example`. Key ones:

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP + WebSocket listen port |
| `OPENQ_GW_HOST` / `OPENQ_GW_PORT` | `127.0.0.1` / `5013` | the single (`main`) openQ `gw` process |
| `OPENQ_GW_TARGETS` | *(unset)* | multiple named gw processes: `main=127.0.0.1:5013,mon=127.0.0.1:5025`. First is the default. Overrides `OPENQ_GW_HOST/PORT`. |
| `OPENQ_POOL_SIZE` | `4` | concurrent-query capacity, per target |
| `OPENQ_QUERY_TIMEOUT_MS` | `15000` | per-query + acquire timeout |
| `OPENQ_TABLES` | *(any)* | comma list; restricts which tables are queryable |
| `OPENQ_STREAM_PORT` | *(unset → streaming off)* | a `tp`/`rdb` port that speaks `.u.sub` |
| `OPENQ_LOG_DIR` | `../../openQ/scripts/logs` | dir of openQ's per-role `.log` files, for `/api/logs` |
| `OPENQ_LOG_FILES` | core roles + `bymod_*` | which `<name>.log` to surface — exact names and/or `prefix*` globs; `*` for all |
| `CORS_ORIGIN` | `*` | origin allowed to call the API (set to the Vite URL in prod) |

## HTTP API

### `GET /health`

```json
{
  "ok": true,
  "defaultTarget": "main",
  "gateways": {
    "main": { "target": "127.0.0.1:5013", "poolSize": 4, "ready": 4, "busy": 0, "waiters": 0 },
    "mon":  { "target": "127.0.0.1:5025", "poolSize": 4, "ready": 4, "busy": 0, "waiters": 0 }
  },
  "stream": { "enabled": true, "target": "127.0.0.1:5010", "connected": true, "tables": ["quote"] }
}
```

### `GET /api/query` &nbsp;·&nbsp; `POST /api/query`

Runs one `.oq.gw.query[table;sCols;sTime;eTime;symb;whereC]`. Add `target=<name>`
(query string or JSON field) to route at a non-default gw from `OPENQ_GW_TARGETS`;
omit for the default.

| param | GET (query string) | POST (JSON) | notes |
| --- | --- | --- | --- |
| `table` | `?table=trade` | `"table":"trade"` | required; must be a valid q symbol (and in `OPENQ_TABLES` if set) |
| `columns` | `?columns=timestamp,sym,price` | `"columns":["timestamp","sym","price"]` | omit for all columns |
| `start` / `end` | ISO 8601 or epoch ms | same | UTC time bounds; omit for open-ended |
| `sym` | `?sym=EURUSD` or `?sym=EURUSD,USDJPY` | `"sym":"EURUSD"` or `["EURUSD","USDJPY"]` | multiple symbols are fanned out as one query each and merged |
| `symPattern` | `?symPattern=EUR*` | `"symPattern":"EUR*"` | q `like` wildcards; mutually exclusive with `sym` |
| `format` | `?format=rows` (default) or `columns` | same | `rows` = array of objects; `columns` = column-oriented |

Response (`format=rows`):

```json
{
  "table": "trade",
  "queryId": 7,
  "tookMs": 3,
  "columns": ["timestamp", "sym", "price", "side", "source"],
  "count": 8,
  "rows": [
    { "timestamp": "2026-08-28T06:34:03.163Z", "sym": "EURUSD", "price": 100.01, "side": "SELL", "source": "SIM" }
  ]
}
```

q types are JSON-normalised: timestamp/date → ISO string, symbol → string,
long (with `OPENQ_USE_BIGINT`) → string.

Errors: `400` for bad input (invalid symbol, unknown table, malformed JSON),
`502` for an error coming back from openQ (`{ "error": "type" }` etc.).

### `GET /api/logs`

Parsed tail of openQ's per-role `.log` files, newest first.

| param | example | meaning |
| --- | --- | --- |
| `limit` | `?limit=300` | max rows (default 200, cap 2000) |
| `level` | `?level=ERROR,WARN` | filter by level (case-insensitive) |
| `proc` | `?proc=gw,rdb` | filter by role (the `.log` basename) |
| `q` | `?q=queryID` | substring match on message or function |
| `since` | `?since=2026.08.27D22:00:00` | only lines at/after this openQ timestamp |

```json
{
  "dir": "C:\\...\\openQ\\scripts\\logs",
  "files": [{ "name": "gw.log", "process": "gw", "bytes": 18816, "modified": "2026-08-27T..." }],
  "processes": ["cep", "gw", "hdb", "idb", "rdb", "tmphdb", "tp"],
  "levels": ["ERROR", "WARN", "INFO", "DEBUG"],
  "count": 6, "total": 95,
  "rows": [
    { "time": "2026-08-27 22:05:56.344", "process": "gw", "pid": 10380,
      "level": "INFO", "handle": "0", "function": ".util.gw.sendReply",
      "message": "Sent reply with queryID: 21" }
  ]
}
```

Lines that don't match openQ's `time|pid|level|handle|fn|msg` format (q error
lines, stack frames) are folded into the preceding row's `message`. The
dashboard's **Logs** page renders this table (level/process/text filters,
auto-refresh).

### `GET /api/markout`

Deal markout + order impact decay curves read live off the markout module's
CEP. No parameters. Enabled only when `OPENQ_MARKOUT_CEP` is set. See
"Markout" below for the response shape.

### `GET /api/spread`

Quoted-spread build-up attribution read live off the spread module's CEP
(`modules/spread/cep.q` → `analytics/spread.q`). A quote's spread is modelled as
the sum of 7 named components (`refSprd`…`alphaSprd`); this returns the weighted
build-up overall, by symbol, and by regime (aggression × market status), plus
the currently-widest keys and per-symbol percentiles. All values in bps. No
parameters. Enabled only when `OPENQ_SPREAD_CEP` is set. The dashboard's
**Spreads** page renders it. See "Spreads" below.

### `GET /api/report`

Per-symbol Desk Risk & TCA table read off the report module's CEP
(`modules/report/cep.q` -> `analytics/deskRisk.q`), which recomputes
`.report.latest` every 60s by combining spread / markout / primefinance
state: `spreadCostBp`, `markoutBp`, `impactBp`, `financingFeeBp`,
`shortQty`, `locatedQty`, `coverage`, `bucket` per symbol (nulls where a
symbol is absent from a domain). The endpoint adds an `allInBp` per row and
by-bucket / totals rollups. No parameters. Enabled only when
`OPENQ_REPORT_CEP` is set. The dashboard's **Desk Risk** page renders it.

### `GET /api/prime`

Securities-finance state read live off the primefinance module's CEP
(`modules/primefinance/cep.q` → `analytics/primeFinance.q`, all `.prime.*`
tables). Returns a summary (short exposure, locate coverage %, fill %, open
buy-ins, alert count), locate coverage per client/sym and rolled up by bucket
(`FULL`/`PARTIAL`/`AT_RISK`/`UNLOCATED`, from `.prime.positionCoverage`),
inventory + a hard-to-borrow score per symbol, borrows, recalls by severity,
buy-ins, and the recent alert stream. No parameters. Enabled only when
`OPENQ_PRIME_CEP` is set. The dashboard's **Prime Finance** page renders it.
See "Prime Finance" below.

### `GET /api/tables`

In-memory table inventory across every configured openQ process (one RDB per
pipeline by default — see `OPENQ_TABLE_SOURCES`). Per source: `connected`,
process name/role, and per table `rows`, `columns`, `bytes` (`-22!`), and
`lastTs` (newest `timestamp` value). Plus `totals`. No parameters. The
dashboard's **Tables** page renders it grouped by pipeline with a
live/recent/idle/empty/offline status per table.

```json
{
  "sources": [
    { "name": "markout", "process": "markout_rdb", "role": "rdb", "target": "127.0.0.1:5031",
      "connected": true,
      "tables": [ { "table": "rate", "rows": 688, "columns": 3, "bytes": 15883, "lastTs": "2026-...Z" } ] }
  ],
  "totals": { "sources": 7, "online": 7, "tables": 19, "rows": 3286, "bytes": 642834 }
}
```

## WebSocket API — `ws://<host>:<PORT>/stream`

Enabled only when `OPENQ_STREAM_PORT` is set. One shared `.u.sub` connection to
the upstream `tp`/`rdb`; the whole table is subscribed and **sym filtering is
applied per client** here.

Client → server (JSON text frames):

```json
{ "action": "subscribe",   "table": "trade", "sym": ["EURUSD"] }   // sym optional; omit = all
{ "action": "unsubscribe", "table": "trade" }
{ "action": "ping" }
```

Server → client:

```json
{ "type": "hello",       "stream": { "...": "status" } }
{ "type": "subscribed",  "table": "trade", "sym": ["EURUSD"] }
{ "type": "tick",        "table": "trade", "columns": [...], "rows": [ { "...": "row" } ] }
{ "type": "error",       "message": "..." }
{ "type": "pong" }
```

## Markout (the dashboard's Markout page)

openQ's **markout** module CEP loads `analytics/markOutImpact.q` and keeps deal
markout / order impact in in-memory keyed tables (`.markout.completed`,
`.impact.completed`) that aren't published downstream. `GET /api/markout` reads
them straight off the CEP over a plain jkdb sync connection and returns the two
decay curves + a peak/permanent-impact split + a per-symbol impact breakdown
(`impact.bySym`, from the sym still held in `.impact.pending` for each recent
order). The curves are **windowed to the recent past** (impact 5 min, markout
10 min, on `matchedTime`) so they track "now" rather than an ever-growing
history. It backs both the dashboard's **Markout** and **Market Impact** pages.

```bash
Q_BIN=/path/to/q bash ../../openQ/scripts/startupAllByModule.sh markout   # CEP on :5034
node tools/markout-feeder.js                                              # correlated trade/order/rate
OPENQ_MARKOUT_CEP=127.0.0.1:5034 npm start
```

`analytics/markOutImpact.q`'s grid runs to ±10 min, so the far ends of the
markout curve only fill in after the feeder has run that long; near offsets
fill within seconds, and the impact curve (−10s…+60s) within a minute.

Response:

```json
{
  "connected": true,
  "summary": { "mkTrades": 71, "mkSamples": 3849, "imOrders": 52, "...": "..." },
  "markout": { "curve": [ { "offsetSec": 1, "markoutBps": -0.13, "samples": 71, "trades": 71 } ] },
  "impact":  { "curve": [ { "offsetSec": 5, "impactBps": -0.06, "...": "..." } ],
               "peakBps": 0.09, "permanentBps": -0.41 }
}
```

## Prime Finance (the dashboard's Prime Finance page)

openQ's **primefinance** module CEP loads `analytics/primeFinance.q` and keeps a
securities-lending model in `.prime.*` (inventory → locate → reservation →
borrow → coverage → recall → buy-in). `GET /api/prime` reads it off the CEP and
returns locate coverage (via `.prime.positionCoverage`), inventory + a
hard-to-borrow score, borrow economics, recalls, buy-ins, and alerts.

```bash
Q_BIN=/path/to/q bash ../../openQ/scripts/startupAllByModule.sh primefinance  # tp :5070, cep :5074
node tools/prime-feeder.js                                                    # continuous events
OPENQ_PRIME_CEP=127.0.0.1:5074 npm start
```

`modules/primefinance/simulator.q` is a one-shot demo;
`tools/prime-feeder.js` drives a continuous stream (inventory refreshes,
short positions, borrows, recalls onto the tp; locate requests via a
`runLocate` IPC wrapper on the CEP, since locates aren't wired to any tp event).

## Spreads (the dashboard's Spreads page)

openQ's **spread** module CEP loads `analytics/spread.q` and keeps the latest
composed quote per (sym, aggression, marketStatus) in `.spread.snap` — each
quote already broken into 7 named build-up components. `GET /api/spread` reads
it off the CEP and returns the overall attribution, per-symbol and per-regime
build-up, widest keys, and per-symbol percentiles.

```bash
Q_BIN=/path/to/q bash ../../openQ/scripts/startupAllByModule.sh spread   # CEP on :5059
node tools/spread-feeder.js                                              # synthetic spreadQuote grid
OPENQ_SPREAD_CEP=127.0.0.1:5059 npm start
```

Component values are stored as price fractions; the endpoint reports bps
(`1e4 ×`), matching `analytics/spread.q`'s own `contributionBps`.

## Process monitoring (the dashboard's Processes page)

openQ's **mon** module holds a `pidstats` table (per-process CPU/memory/threads
per poll) and a `logs` table. It runs as its own tp/cep/rdb/idb/hdb set:

```bash
Q_BIN=/path/to/q  bash ../../openQ/scripts/startupAllByModule.sh mon
# then a gw for it (mon has no gw of its own):
cd ../../openQ/core && q init.q -procType gw -name mon_gw -port 5025 \
  -rdbaddr :localhost:5021 -hdbaddr :localhost:5023 -schema schema_mon.q
```

Point this service at both platforms and run it:

```bash
OPENQ_GW_TARGETS=main=127.0.0.1:5013,mon=127.0.0.1:5025 npm start
```

`GET /api/query?table=pidstats&target=mon` now works, and the dashboard's
**Processes** page renders it (CPU/memory time-series + a per-process table).

Feeding `pidstats`: the real feeder is `openQ/modules/mon/pidstat_poller.py`
(Linux `pidstat`). On Windows, `tools/pidstat-feeder.js` is a stand-in — it
reads the live Windows process table and publishes real rows for the running
q/node processes into `mon_tp`:

```bash
node tools/pidstat-feeder.js       # 3s interval; Ctrl-C to stop
```

## Known limitations

* **Time-bounded queries need a populated HDB.** openQ routes any query whose
  time range reaches before "today" to the HDB as well as the RDB; against an
  HDB with zero partitions the date-partition where-clause throws `` `type ``.
  Queries with no `start`/`end`, or bounds entirely within today, are fine.
* **`whereC` is not exposed** over HTTP — the sixth `.oq.gw.query` argument is
  always `` ` ``. Arbitrary where-clauses would be an injection surface.
* **Publishing is out of scope.** This service only queries and subscribes;
  writing ticks into openQ is a feed handler's job.

## Layout

```
index.js            entry point / lifecycle
src/config.js        env + .env parsing
src/qlit.js          validate JS input → safe q literal text; build the .oq.gw.query string
src/qshape.js        column-oriented q table → row objects; q value → JSON-safe
src/qGateway.js      the connection pool + async-reply correlation
src/stream.js        .u.sub bridge → "tick" events
src/logs.js          read + parse openQ's .log files for /api/logs
src/markout.js       read the markout CEP's .markout/.impact state for /api/markout
src/spread.js        read the spread CEP's .spread.snap for /api/spread
src/report.js        read the report CEP's .report.latest for /api/report
src/prime.js         read the primefinance CEP's .prime.* state for /api/prime
src/tables.js        survey each pipeline's RDB for the /api/tables inventory
src/server.js        HTTP routes + WebSocket wiring
scripts/smoke.js     one-shot query check
tools/pidstat-feeder.js  Windows stand-in for modules/mon/pidstat_poller.py
tools/markout-feeder.js  correlated trade/order/rate feed for the markout module
tools/spread-feeder.js   synthetic spreadQuote grid for the spread module
tools/prime-feeder.js    continuous securities-finance events for the primefinance module
```
