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
| `OPENQ_OHLC_STREAM` / `_TABLE` / `_PRICE` | `127.0.0.1:5030` / `rate` / `mid` | the price feed the eFX Charts page buckets |
| `OPENQ_OHLC_SYMS` | `EURUSD,GBPUSD,AUDUSD,NZDUSD,EURGBP` | currency-pair allow-list for `/api/ohlc`; empty ⇒ 6-upper-letter FX shape check |
| `OPENQ_EQ_HDB` / `_TABLE` / `_MAX_DAYS` | `127.0.0.1:5090` / `eq_m1_yfinance` / `21` | `eq_hdb` for the EQ > Charts page (`/api/eq/*`); `off`/`none`/`0` disables |
| `OPENQ_HDBHEALTH` | `127.0.0.1:5023` | `mon_hdb` — serves all three `/api/hdbhealth` sources (`archive`, `eq`, `mon`); `off`/`none`/`0` to disable |
| `OPENQ_HDBHEALTH_SOURCES` | *(archive+eq+mon)* | override the source list: `name=host:port[:archive\|live],…` |
| `OPENQ_HDBHEALTH_EQ_BOUND_DAYS` | `400` | lookback window for the bounded `eq` (`tableHealthEq`) archive scan |
| `OPENQ_LOG_DIR` | `../../openQ/scripts/logs` | dir of openQ's per-role `.log` files, for `/api/logs` |
| `OPENQ_LOG_FILES` | core roles + `bymod_*` | which `<name>.log` to surface — exact names and/or `prefix*` globs; `*` for all |
| `OPENQ_TESTS_DIR` | `../../openQ/tests` | openQ's `tests/` dir — `/api/tests` reads `logs/results/`, `POST /api/tests/run` runs `sh/run_all.sh` |
| `OPENQ_CATALOG_FILE` | `../../openQ/schemas/catalog.json` | curated data dictionary served at `/api/catalog` (Data > Catalog page) |
| `OPENQ_CONTROL_TOKEN` | *(unset → read-only)* | shared secret for every mutating op (`/api/control/*`, `/api/tests/run`); present it as `Authorization: Bearer <token>` |
| `OPENQ_CONTROL_ENABLED` | `1` | hard off-switch for the Control subsystem |
| `OPENQ_ROOT` | `../../openQ` | openQ checkout the Control page drives (`scripts/`, `core/`, `cfg_proc/`) |
| `OPENQ_Q_BIN` | `/c/q/w64/q` | q executable — MSYS form for the shell scripts; auto-converted to a native path for direct spawns |
| `OPENQ_DATA_DIR` | `C:/tmp/openq-dash-e2e/data2` | `DATA_DIR` passed to `scripts/startup.sh` |
| `OPENQ_CONTROL_MODULES` | `mon,markout,spread,primefinance,report` | modules the Control page can start/stop |
| `OPENQ_START_WITH_CEP` / `_IDB` | `0` / `0` | `WITH_CEP` / `WITH_IDB` for the core plant start |
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

### `GET /api/pidstats`

Live per-process CPU / memory / thread samples for the **Processes** page,
read straight off the **mon RDB pair** (`OPENQ_PIDSTATS_RDB`, default
`127.0.0.1:5021,127.0.0.1:5101`) with a plain `select from pidstats` — not
`mon_gw`/`mon_hdb` (see *Process monitoring* below for why). Both active/
standby instances are queried and unioned, deduped on `(host, pid,
timestamp)`. No parameters.

```json
{
  "connected": true,
  "endpoints": [{ "target": "127.0.0.1:5021", "connected": true },
                { "target": "127.0.0.1:5101", "connected": true }],
  "columns": ["timestamp", "sym", "host", "pid", "procType", "port", "cpuPct", "rss", "..."],
  "count": 872,
  "rows": [{ "timestamp": "2026-09-01T23:48:...", "sym": "mon_rdb_1", "host": "…",
             "pid": 1015, "procType": "rdb", "cpuPct": 0.3, "rss": 41123840, "…": 0 }]
}
```

| env | default | meaning |
| --- | --- | --- |
| `OPENQ_PIDSTATS_RDB` | `127.0.0.1:5021,127.0.0.1:5101` | comma list of mon RDB instances; `off`/`none`/`0` disables `/api/pidstats` |
| `OPENQ_PIDSTATS_TABLE` | `pidstats` | table name |
| `OPENQ_PIDSTATS_TIMEOUT_MS` | `8000` | per-instance query timeout |

### `GET /api/jobstatus`

The mon **`jobStatus`** table (`modules/mon/jobStatus.q` → `schema_mon.q`) for
the **JobStatus** page: two rows per job run (`RUNNING` at
`.mon.job.start`, `SUCCESS`/`FAILED` at `.mon.job.end`), each carrying
`jobName`, the publishing process's `-name` (`sym`), and start/end/
duration. Three sources, unioned + deduped: **realtime** off the mon RDB
pair (`OPENQ_JOBSTATUS_RDB`), **staged** rows off the mon IDB
(`OPENQ_JOBSTATUS_IDB` — every numbered `jobStatus` splay under
`.oq.idb.root`, so a job that already fell off the RDB but hasn't been
promoted to the HDB yet — i.e. anything that ran earlier the same day —
still shows), and **history** off the mon HDB (`OPENQ_JOBSTATUS_HDB`).
The HDB query is skipped when `jobStatus` isn't registered there and
anchors on `exec max date from select date from jobStatus` (real rows
only). Rows are folded into one record per run — the latest event
timestamp wins, so an end row supersedes its start row.

`?days=<1..120>` sets the HDB lookback (default `OPENQ_JOBSTATUS_HIST_DAYS`).

```json
{
  "connected": true, "days": 7, "rdbConnected": true, "hdbConnected": true,
  "count": 12,
  "rows":    [{ "timestamp": 0, "sym": "mon_housekeeping", "jobName": "monEod",
                "startTime": 0, "endTime": 0, "durationMs": 4123, "status": "SUCCESS" }],
  "runs":    [{ "sym": "…", "jobName": "monEod", "startTime": 0, "endTime": 0,
                "durationMs": 4123, "status": "SUCCESS", "live": false }],
  "running": [{ "jobName": "…", "sym": "…", "startTime": 0, "elapsedMs": 900 }],
  "summary": { "runs": 6, "jobs": 2, "procs": 2, "running": 0, "success": 5, "failed": 1,
               "successRate": 0.83, "avgDurationMs": 3800, "p95DurationMs": 6200,
               "maxDurationMs": 6200, "last24h": { "runs": 2, "success": 2, "failed": 0, "running": 0 } }
}
```

| env | default | meaning |
| --- | --- | --- |
| `OPENQ_JOBSTATUS_RDB` | `127.0.0.1:5021,127.0.0.1:5101` | mon RDB instances for realtime; `off`/`none`/`0` disables `/api/jobstatus` |
| `OPENQ_JOBSTATUS_IDB` | `127.0.0.1:5022` | mon IDB for staged-but-unpromoted rows (jobs that ran earlier today); `off` skips it |
| `OPENQ_JOBSTATUS_HDB` | `127.0.0.1:5023` | mon HDB for history; `off` skips the historical query |
| `OPENQ_JOBSTATUS_HIST_DAYS` | `14` | default HDB lookback (client `?days=` overrides, capped 120) |
| `OPENQ_JOBSTATUS_TIMEOUT_MS` | `8000` | per-endpoint query timeout |

### `GET /api/timers`

Every openQ process's scheduled work for the **SystemAdmin → Timers** page.
openQ layers a multi-timer scheduler over kdb+'s single `.z.ts`
(`core/utils/timer.q`, in every process's `utilities`), keeping one keyed
table `.util.timer.tab` (`id added start end frequency func lastRun nextRun
active mode info`). This reader has **no persistent connections and no
endpoint list of its own** — it reuses the Modules `cfg_proc` topology and
does one short-lived IPC probe per live node port that pulls
`.util.timer.tab`, then rolls the rows up per process, per module and
platform-wide. `func` (stored as a projection like `` @[`.util.conn.cleanup] ``)
is reduced to the bare callback name; `mode` is `DEF` (after finish) /
`REL` (after start) / `ABS` (fixed grid) / `ONCE`. No parameters.
`OPENQ_TIMERS=off` disables the route.

```json
{
  "asOf": "2026-09-03T09:32:06.365Z", "host": "127.0.0.1",
  "overview": { "processes": 55, "processesUp": 41, "processesWithTimers": 41,
                "totalTimers": 164, "activeTimers": 164, "inactiveTimers": 0,
                "distinctFunctions": 17, "overdueTimers": 0, "modules": 9,
                "byMode": { "DEF": 145, "REL": 19 },
                "fastestFreqMs": 1000, "slowestFreqMs": 900000 },
  "modules":  [{ "name": "mon", "label": "mon", "procCount": 8, "procUp": 8,
                 "procsWithTimers": 8, "timerCount": 22, "activeCount": 22, "overdueCount": 0,
                 "procs": [{ "module": "mon", "name": "mon_tp", "role": "tp", "port": 5020,
                             "up": true, "timerCount": 2, "activeCount": 2, "overdueCount": 0,
                             "timers": [{ "id": 1, "fn": ".util.conn.cleanup",
                                          "label": ".util.conn.cleanup", "mode": "DEF", "active": true,
                                          "freqMs": 10000, "freqHuman": "10s",
                                          "added": "…", "lastRun": "…", "nextRun": "…",
                                          "lastRunAgoMs": 4200, "dueInMs": 5800, "overdue": false }] }] }],
  "functions":[{ "fn": ".util.conn.cleanup", "count": 41, "activeCount": 41, "procs": 41,
                 "minFreqMs": 10000, "minFreqHuman": "10s" }],
  "upcoming": [{ "proc": "mon_tp", "module": "mon", "fn": ".util.conn.cleanup", "mode": "DEF",
                 "nextRun": "…", "dueInMs": 793, "freqMs": 10000, "freqHuman": "10s", "overdue": false }],
  "overdue":  []
}
```

| env | default | meaning |
| --- | --- | --- |
| `OPENQ_TIMERS` | `on` | `off`/`none`/`0` disables `/api/timers` and hides the page |
| `OPENQ_TIMERS_HOST` | `127.0.0.1` | host to probe every node on |
| `OPENQ_TIMERS_TIMEOUT_MS` | `2500` | per-node probe timeout |

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

### `GET /api/modules`

Process topology per pipeline, reconstructed from openQ's `cfg_proc/` JSON
files (`OPENQ_CFG_DIR`). No `name` -> `{ modules: [{name,label,roles}] }`.
With `?name=markout` -> the module's nodes (one per role JSON: id, name,
procType, port, schema, libraries, cepscript) with a live probe of each
(`up`, `asOf`, `tables` + row counts, open `handles`), plus edges that model
openQ's **canonical dataflow** from the roles present rather than a literal
dump of every `*addr` param:

```
feed -> tp -> cep -> rdb#1 / rdb#2 -> hdb        (kind: "flow" / "eod")
             rdb#1 / rdb#2 -> idb  (harvest)      (kind: "flow")
             idb -> rdb#1 / rdb#2 (checkpoint)    (kind: "flush")
        gw -> {rdb#1, rdb#2, idb, hdb}            (kind: "query")
```

The **rdb is an active/standby pair** (openQ `core/rdb.q`): one `rdb.json`,
no top-level `port`, launched twice with `-instance 1/2` onto
`params.port1` / `params.port2` — this endpoint expands it into two nodes
(`rdb`, `rdb_2`, the second flagged `standby`). The **idb** is a distinct
process (its own diagram column, not shared with rdb) that no longer
subscribes to the tp/cep; both rdb instances harvest into it and it
checkpoints back to both (`core/idb.q` "pivot-and-harvest"). With no `cep`
the rdbs subscribe straight to the
`tp`; a standalone `eod` job, if the module ships one, sits between `idb`
and `hdb`. Each edge carries `{from, to, label, kind}`. The dashboard's
**System > Modules** page renders it as an interactive architecture
diagram — columns by role, edges styled per kind (solid = data flow,
dashed = gateway query, dotted = idb checkpoint), click a node for detail.

### `GET /api/procmon`

Every openQ process across every pipeline in one flat view — the **System >
Process Mon** page. Runs `/api/modules`'s topology + live probe for every
module and cross-references the latest `pidstats` snapshot (CPU / RSS /
threads / pid, matched on the process `-name`; the default pipeline's
`tp0`/`cep0`/… suffix is handled). 3 s server-side cache.

```json
{
  "updatedAt": "…",
  "totals": { "processes": 54, "up": 41, "down": 13, "modules": 10, "modulesFullyUp": 8 },
  "modules": [
    { "name": "mon", "label": "mon", "up": 7, "total": 7, "offline": false,
      "procs": [
        { "module": "mon", "name": "mon_rdb_1", "role": "rdb", "port": 5021,
          "status": "up",  // up | standby | down | batch (an eod one-shot)
          "standby": false, "instance": 1, "procType": "rdb", "handles": 6,
          "tables": { "logs": 0, "pidstats": 686 }, "rowsTotal": 686, "error": null,
          "cpuPct": 0.53, "rss": 13594624, "threads": 24, "pid": 22564, "logProc": "mon_rdb_1" }
      ] }
  ],
  "infra": [ { "name": "dashboard_gateway", "procType": "gateway", "cpuPct": 0, "rss": 50716672, "pid": 3876 } ]
}
```

`infra` is every `pidstats` row that isn't an openQ pipeline process — the
gateway itself, Vite, the node feeders, hand-started gateways (`mon_gw`).
An `eod` node is `status:"batch"` (a deliberate one-shot, not counted as
down); an entirely unstarted module is `offline:true`.

### `GET /api/catalog`

openQ's curated data dictionary (`openQ/schemas/catalog.json`, path via
`OPENQ_CATALOG_FILE`) — one entry per `(schema, table)` with a plain‑English
description of the table and every column plus its kdb+ type. Reloaded on file
change (mtime), no gateway restart needed. Returns
`{ types, groups:[{name, tier, desc}], counts:{tables,columns,groups},
tables:[{name, schema, pipeline, group, key, desc,
columns:[{name, type, kdb, desc}]}] }`. `groups` gives the display order and a
`tier` of `hdb` / `memory` / `demo`; tables are sorted into that order then by
name. Current groups: `HDB-eFX`, `HDB-eq`, `HDB-mon`, `In-Memory Markout`,
`In-Memory PrimeFinance`, `In-Memory Spread`, `Demo-eq`. No parameters. The
dashboard's **Data > Catalog** page renders it: a searchable, group‑ordered
table list on the left (with HDB / In‑Memory / Demo tier dividers), the
selected table's column dictionary
on the right (key columns flagged, type badges). Keep `catalog.json` in sync
when a `schemas/*.q` (or `core/housekeeping.q`) column changes.

### `GET /api/ohlc`

OHLC candles for a live price feed. The gateway keeps a rolling per-symbol
tick ring from a `.u.sub` subscription (markout's `rate` table by default,
via `OPENQ_OHLC_STREAM`) and buckets it on demand - so history doesn't
depend on RDB retention.

| param | example | meaning |
| --- | --- | --- |
| `sym` | `?sym=EURUSD` | one of the feed's symbols; first available if omitted/unknown |
| `bucket` | `?bucket=15` | candle interval in seconds (1-3600, default 15) |
| `count` | `?count=90` | max candles returned (default 90, cap 500) |

Returns `{ sym, syms, bucketSec, bars:[{t,open,high,low,close,ticks}], last, hi, lo, changePct }`.
The dashboard's **eFX > Charts** page renders it as a candlestick.

Because this is an eFX page, the store only ever admits currency pairs:
`OPENQ_OHLC_SYMS` (default `EURUSD,GBPUSD,AUDUSD,NZDUSD,EURGBP`) is an explicit
allow-list; with none set it falls back to a six-upper-case-letter FX-pair
shape check. Ticks for anything else (equity tickers, etc.) are dropped on
ingest.

### `GET /api/eq/syms` · `GET /api/eq/bars`

1-minute equity candles for the **EQ > Charts** page, read straight off
`eq_hdb` (`OPENQ_EQ_HDB`, default `127.0.0.1:5090` - `cfg_proc/modules/eq/`,
hdbroot `C:/data/db1/eq`). One table, `eq_m1_yfinance` (Asian markets - HKEX
+ Tokyo/Nikkei). `src/eqOhlc.js` holds a reconnecting IPC session and runs
date-partition-scoped selects; no gateway-side ring (unlike `/api/ohlc`),
the HDB is the history. `eq_hdb` is not always up - both routes `503` with a
"start the eq module" hint when it's down.

| route | params | returns |
| --- | --- | --- |
| `/api/eq/syms` | — | `{ count, exchanges:[{exchange,count}], syms:[{sym,exchange}] }` - the ~5.6k-symbol universe from the newest partition (cached 5 min, warmed on connect) |
| `/api/eq/bars` | `sym` (e.g. `0700.HK`, `7203.T`), `days` (1-`OPENQ_EQ_MAX_DAYS`, default 3) | `{ sym, exchange, days, count, bars:[{t,open,high,low,close,volume}], last, hi, lo, vol, changePct }` - `bars` in the same shape `/api/ohlc` returns, so the EQ page reuses the eFX chart's `<LwCandles>` + indicators unchanged |

`sym` is validated against `/^[0-9A-Za-z.\-]{1,14}$/` (qlit's `symbolLit`
rejects the dot / leading digit) and passed as `` `$"<sym>" ``. `days` selects
the last N HDB partitions via `.Q.pv` indexed from the end.

| env | default | meaning |
| --- | --- | --- |
| `OPENQ_EQ_HDB` | `127.0.0.1:5090` | `eq_hdb` host:port; `off`/`none`/`0` disables the EQ Charts routes |
| `OPENQ_EQ_TABLE` | `eq_m1_yfinance` | the minute-bar table to read |
| `OPENQ_EQ_MAX_DAYS` | `21` | upper bound on the `days` param |

### `GET /api/report`

Per-symbol Desk Risk & TCA table read off the report module's CEP
(`modules/report/cep.q` -> `analytics/deskRisk.q`), which recomputes
`.report.latest` every 60s by combining spread / markout / primefinance
state: `spreadCostBp`, `markoutBp`, `impactBp`, `financingFeeBp`,
`shortQty`, `locatedQty`, `coverage`, `bucket` per symbol (nulls where a
symbol is absent from a domain). The endpoint adds an `allInBp` per row and
by-bucket / totals rollups. No parameters. Enabled only when
`OPENQ_REPORT_CEP` is set. The dashboard's **Desk Risk** page renders it.

### `GET /api/hdbhealth` &nbsp;·&nbsp; `?source=archive|eq|mon`

Selectable **sources** — one button each on the HDB Health page (the
response carries the full `sources` list `[{name, kind, target}]` and the
resolved `source`; an unknown `?source=` falls back to the default,
`archive`):

| `source` | kind | what |
| --- | --- | --- |
| `archive` *(default)* | archive | the on-disk `tableHealth` / `tableHealthTick` scan archive `examples/scripts/05_table_health_scan.q` writes under `C:/data/db1/mon` (one row per `(tab, date)`, `.oq.hk.tableHealth` shape), read off `mon_hdb` |
| `eq` | archive | the `tableHealthEq` scan archive (same `05_table_health_scan.q`, `-hdbroot C:/data/db1/eq -schema schemas/schema_eq_scan.q -savetab tableHealthEq`), the 3 minute-bar tables. A single "eq HDB" source with the same rows-per-month / archive-completeness / rows-per-day panels as `archive` — the old live `.Q.pt` scan of `eq_hdb` had none of those. Also written into `C:/data/db1/mon` so it is read off `mon_hdb`, but only the ~35 partitions it was scanned into carry that splay, so the reader stays **bounded** (`OPENQ_HDBHEALTH_EQ_BOUND_DAYS`, default 400) and re-derives the honest date range / partition count / latest-with-data status from the bounded `recent` window (the scan's own stored `oldestDate` counts `.Q.chk` stub dirs across the whole `/mon` root). Re-run the scan after an EOD to refresh it. |
| `mon` | live | a **live** scan of `mon_hdb`'s own `.Q.pt` tables (`logs`, `pidstats`, `tableHealth`, `tableHealthTick`, `tableHealthEq`) |

Override the set with `OPENQ_HDBHEALTH_SOURCES="name=host:port[:archive|live],…"`;
otherwise `OPENQ_HDBHEALTH` is the `archive`/`eq`/`mon` target (all read off `mon_hdb`).

A **live** scan walks the HDB process's `.Q.pt` right now — per table:
partition count (with data), total rows, rows in the newest partition,
`oldestDate`/`newestDate`, the newest `timestamp` value (→ `ageSec`), and
`missingDays`. No `monthly` / `recent` history (those need the per-day
archive rows) — both come back `[]`, and `live:true` is set.

The **archive** source returns `{ scanTs, tables, monthly, recent, totals }`:
- `tables` — one row per monitored table: latest-partition `status`
  (`HEALTHY`/`EMPTY`), `rowsTotal`, `bytesArchive`, `partitionCnt`,
  `missingDays` (calendar days in range with no partition), `emptyDays` /
  `healthyDays` / `coveragePct`, `oldestDate`/`newestDate`/`spanDays`,
  `ageSec` (staleness of the newest partition), `rowsToday`.
- `monthly` — `{kind, tab, month, rows, bytes, days, emptyDays}` per month
  across the whole archive (the row-count trend + completeness strips).
- `recent` — daily `{kind, tab, date, rowsToday, bytesDisk, status}` for the
  last 180 days.

"Latest" here anchors on `exec max date from select date from <table>` — the
newest date the health archive itself has rows for — **not** `max date`. On the
shared `C:/data/db1/mon` root `max date` is the virtual partition column across
*all* families, and `core/hdb.q`'s `.Q.chk` backfills an empty `tableHealth`
splay into the mon module's newer partitions, so `where date=max date` would
come back blank.

Every source's result is served from a **60s TTL cache** (whole-archive /
whole-`.Q.pt` scans over ~6k partitions run ~15s cold on Windows); the
default source is warmed on gateway start, and a stale copy is returned
immediately while it refreshes. The dashboard's **System > HDB Health** page
renders it with a source button-group.

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

### `GET /api/querymon`

Query-behaviour snapshot off every watched gw-capable process. openQ's
`core/utils/gateway.q` keeps every query it ever routed in the keyed
in-memory table `.util.gw.queue` (finished rows retain `returned` / `took` /
`error` / `discard`) plus per-backend-handle counters in `.util.gw.servers`;
`src/queryMon.js` runs one read-only select per target and rolls it up. A
process without `.util.gw.queue` comes back `hasGw:false`.

The watch set is `OPENQ_QUERYMON_TARGETS` (same `name=host:port,…` format as
`OPENQ_GW_TARGETS`; falls back to the `/api/query` targets when unset). It's
separate because Query Mon usefully watches more than the query router does:
`mon_gw` (the one gateway with real dashboard traffic), each module's
query-serving HDB (`markout` 5033 / `spread` 5058 / `primefinance` 5075 —
they load `utils/gateway.q` too, so they expose `.util.gw.queue`, though the
analytics pages read them with a plain `select` rather than through the
gateway entrypoint, so those tabs stay at zero until something routes a
gateway query at them), and `default_gw` (`gw0` 5013, the default demo
pipeline's gateway — idle unless you query it directly).

Per target: `connected`, `hasGw`, `totalQueries` (`.util.gw.ID`), `queued`
(in-flight), `doneCnt` / `errCnt` / `discardCnt`, `latencyMs`
(`p50`/`p95`/`p99`/`max`/`avg` of `took` over the last `winMin` minutes),
`qpsWindow`, `errRateWindow`, `byType` (per `rdb`/`hdb`/`rdb+hdb` route: n,
avg/max ms, errors), `servers` (per handle: `querycount`, `usageMs`,
`lastAgoSec`, `active`/`inuse`), `recent` (newest N queries — id, age,
route, table, `tookMs`, error/discard/pending) and `slowest` (top N by
`took`), and `series` (per-minute query/error/avg-ms buckets, last
`histMin` min). No parameters. The dashboard's **System > Query Mon** page
renders it with a tab per gateway.

| env | default | meaning |
| --- | --- | --- |
| `OPENQ_QUERYMON` | `1` | off-switch (`0` disables `/api/querymon`) |
| `OPENQ_QUERYMON_TARGETS` | *(the `/api/query` targets)* | watch set: `mon_gw=127.0.0.1:5025,markout=127.0.0.1:5033,spread=127.0.0.1:5058,primefinance=127.0.0.1:5075,default_gw=127.0.0.1:5013` |
| `OPENQ_QUERYMON_WINDOW_MIN` / `_HISTORY_MIN` | `5` / `30` | latency window / per-minute history depth |
| `OPENQ_QUERYMON_RECENT` / `_SLOW` | `40` / `15` | rows in the recent / slowest tables |

### `GET /api/tables`

Table inventory across every configured openQ process (each pipeline's RDB
pair by default, plus any HDB you list — see `OPENQ_TABLE_SOURCES`). Per
source: `connected`, process name/role, and per table `rows`, `columns`,
`bytes` (`-22!`), and `lastTs` (newest `timestamp` value). Partitioned HDB
tables are handled too: rows via `select count i by date`, `cols` off the
name, `bytes` null, `lastTs` = newest partition date. Plus `totals`. No
parameters.

Each `OPENQ_TABLE_SOURCES` entry is `name=host:port[:kind]`, and `host:port`
may repeat joined by **`+`**:

- **rdb** (default) — a pipeline RDB, listed as a `+`-joined active/standby
  pair (`mon=…:5021+…:5101`). Both instances are surveyed and the higher
  per-table row count (the active one) is kept; otherwise the source reads 0
  for the half of each ~2-min pivot cycle its `-port1` instance sits standby.
- **hdb** — an on-disk HDB (`eq_hdb=…:5090:hdb` — or bare, detected by
  `role`), single endpoint.
- **idb** — a pivot-and-harvest IDB (`mon_idb=…:5022:idb`). Its own
  in-memory tables are transient (cleared after each harvest), so instead
  the survey sums the row count of every numbered segment dir under
  `.oq.idb.root` per schema table — **rows staged since the last EOD**,
  pending promotion to the HDB.

The dashboard's **Tables** page renders it with two-level collapsible
grouping (`main.jsx`): top-level tiers **Demo**
(default/markout/primefinance/spread), **Live — Real-time** (RDB working
set), **Live — Real-time (IDB)** (staged rows, `staged` badge) and
**Live — HDB** — split by each source's `role`/kind; within a tier,
`TABLE_GROUPS` clusters the yfinance sources under one **yfinance**
sub-header. Tiers, groups and the tables per source are all alpha-sorted.

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

### `GET /api/explore` &nbsp;·&nbsp; `POST /api/explore`

Ad-hoc data explorer for the **Data > Explorer** page. Runs one **guarded
`select`** straight against a `tableSources` process (the RDB pairs + HDBs
from `OPENQ_TABLE_SOURCES`; `idb` sources are excluded - their in-memory
tables are transient). No `gw` involved, so it reaches modules that don't
have one.

`GET /api/explore` with no params lists the queryable sources. To query,
pass (query string or JSON body):

| param | example | meaning |
| --- | --- | --- |
| `source` | `mon` | required; a `tableSources` name |
| `table` | `pidstats` | required; a q identifier (`[A-Za-z][A-Za-z0-9_]*`) |
| `columns` | `timestamp,sym,cpuPct` | optional CSV of identifiers; omit for all |
| `sym` | `EURUSD,GBPUSD` or `0700.HK` | optional CSV → `sym in (...)` |
| `start` / `end` | ISO 8601 | optional → `timestamp within (…)` |
| `order` / `dir` | `timestamp` / `asc`\|`desc` | optional sort |
| `limit` | `500` | rows returned (default 200, cap 5000) |

Every dynamic piece is validated and re-emitted as a q literal — there is
**no free-text where clause** (same safety model as `/api/query`). A
partitioned (HDB) table with no `start`/`end` is pinned to its newest date
that actually has rows. For an RDB pair both instances are tried and the
one with rows (the active) is used.

```json
{
  "source": "mon", "target": "127.0.0.1:5021", "table": "pidstats",
  "tookMs": 1, "matched": 46, "count": 5, "truncated": true,
  "columns": ["timestamp", "sym", "procType", "cpuPct", "rss"],
  "rows": [ { "timestamp": "2026-09-02T04:33:29.448Z", "sym": "tp0", "procType": "tp", "cpuPct": 0, "rss": 11079680 } ]
}
```

`matched` is the full row count of the filtered result; `rows` is the first
`limit` of them (`truncated` when `matched > count`).

### `GET /api/tests`

Structured results of the openQ acceptance suite. The gateway reads the
artifacts `openQ/tests/sh/run_all.sh` drops under `tests/logs/results/`
(`manifest.txt` + one `<suite>.out` per suite — see `OPENQ_TESTS_DIR`) and
parses the `PASS:`/`FAIL:` lines and the `=== RESULT: N passed, M failed ===`
banner out of each. No parameters. Before any run has been recorded it returns
`{ "present": false }`. The dashboard's **Tests** page (System group) renders
the totals, a green/red bar, and a per-suite accordion of individual checks +
output tail.

```json
{
  "present": true, "running": false,
  "startedAt": "2026-08-29T22:46:58Z", "finishedAt": "2026-08-29T22:49:10Z",
  "totals": { "suites": 9, "green": 8, "red": 1, "pass": 60, "fail": 2 },
  "suites": [
    { "name": "cep", "exitCode": 0, "durationSec": 7, "pass": 7, "fail": 0,
      "errored": false, "status": "pass",
      "checks": [ { "ok": true, "name": "..." } ], "tail": "...last 60 lines..." }
  ]
}
```

Per suite `status` is `pass` (exit 0, no failing checks), `fail` (one or more
`FAIL:` checks), or `error` (non-zero exit with no checks emitted at all).

### `POST /api/tests/run`

Kicks off a fresh `tests/sh/run_all.sh` in the background and returns `202` with
`{ "started": true }` (or `{ "started": false, "reason": "..." }` if a run is
already in progress or the script is missing). **This stops the running openQ
platform** — each suite tears its own q processes down (some via
`taskkill //F //IM q.exe`) — so the plant must be restarted afterwards. The
dashboard guards the button behind a `window.confirm`. **Gated** — requires
`OPENQ_CONTROL_TOKEN` (see below).

## Control API — start / stop the platform

Backs the dashboard's **System > Control** page. `src/control.js` shells out to
the same scripts an operator runs by hand (`scripts/startup.sh`,
`scripts/startupAllByModule.sh`, the Node feeders under `tools/`) and, for EOD,
runs each module's one-shot `eod` process. **One operation at a time** (a global
mutex); every run is kept in a rolling history with its exit code + output tail.

**Auth.** Every route below is a no-op unless `OPENQ_CONTROL_TOKEN` is set in the
gateway `.env`. Unset ⇒ **read-only**: `GET /api/control` still works, every
`POST` returns `403`. When set, pass it as `Authorization: Bearer <token>` (or
`X-Control-Token: <token>`); a wrong value is `401`. `OPENQ_CONTROL_ENABLED=0`
disables the subsystem entirely (`503`).

### `GET /api/control`

Full state, no auth: `{ enabled, readOnly, dataDir, busy, plant, monGw, modules,
feeders, history }`. Liveness is derived from **TCP-probing each role's
configured port** (from `cfg_proc/**/*.json`), not the pidfiles — on Windows/MSYS
the scripts' `$!` is a bash pseudo-pid, useless to `process.kill`.

```json
{
  "readOnly": false,
  "plant":   { "up": true, "upCount": 4, "total": 4,
               "procs": [ { "role": "tp", "port": 5010, "up": true }, ... ] },
  "monGw":   { "name": "mon_gw", "port": 5025, "up": true, "pid": 41288 },
  "modules": [ { "name": "markout", "up": true, "procCount": 6, "total": 6, "procs": [...] }, ... ],
  "feeders": [ { "name": "markout", "running": true, "pid": 24012, "source": "managed",
                 "logMtimeAgeMs": 1975, "lastLine": "feeding markout_tp:5030 ..." }, ... ],
  "busy":    null,
  "history": [ { "action": "module:restart", "target": "report", "ok": true,
                 "exitCode": 0, "steps": [...], "output": "..." } ]
}
```

### `POST /api/control/…`  *(all gated, all return `202 {started:true}` or `409/…`)*

| Path | Body | Effect |
|---|---|---|
| `/plant` | `{action:"start"\|"stop"}` | `scripts/startup.sh` (`WITH_CEP`/`WITH_IDB` from env) / `shutdown.sh` |
| `/module` | `{name, action:"start"\|"stop"\|"restart"}` | `scripts/startupAllByModule.sh` / `shutdownAllByModule.sh` for `name` (∈ `OPENQ_CONTROL_MODULES`) |
| `/mongw` | `{action:"start"\|"stop"\|"restart"}` | the hand-started `mon_gw` gw process |
| `/feeder` | `{name, action:"start"\|"stop"\|"restart"}` | a Node feeder under `tools/` (`pidstat\|markout\|spread\|prime`) |
| `/eod` | `{module}` | runs `initFromCfg.q -config cfg_proc/modules/<module>/eod.json` — the one-shot that promotes today's partition into that module's HDB, then exits |
| `/up` | — | orchestrated: clear stale pidfiles → plant → each module → `mon_gw` → all feeders |
| `/down` | — | orchestrated: feeders → `mon_gw` → modules (reverse) → plant |

Names are checked against fixed allow-lists; commands are `spawn(cmd, [args])`,
never a shell string.

## Replay API — paced tp-log replay

Backs the **Replay** panel on the Control page. `src/replay.js` spawns openQ's
`modules/replay/replay.q` — one process per target module — which loads that
module's rotated tickerplant logs and re-publishes every message into the live
`tp` against a simulated clock (`simClock = t0 + speed·(now − wall0)`), rewriting
each row's `timestamp` to the wall instant it now represents (`-stamp now`). The
markout / market-impact / spread CEPs and the dashboards reading them then run on
**real captured data, wall-clock paced**, instead of the synthetic feeders. The
gateway holds one reconnecting IPC session per running replay for the `.rp.*`
control verbs and the `.rp.status[]` poll.

Two targets ship by default: `markout` (→ `markout_tp:5030`, feeds the Markout +
Market Impact pages) and `spread` (→ `spread_tp:5055`, feeds the Spreads page).

| Route | Body | Effect |
|---|---|---|
| `GET /api/replay` | — | every target: config, `running`, and live `.rp.status[]` (`playing`, `speed`, `pct`, `simClock`, `sent`, `loops`, …) |
| `POST /api/replay/start` | `{module, speed?, stamp?, loop?, lastn?, paused?, stopFeeder?}` | spawn `replay.q` for `module`; unless `stopFeeder:false`, the module's Node feeder is stopped first so it doesn't interleave |
| `POST /api/replay/stop` | `{module}` | kill that replay process |
| `POST /api/replay/command` | `{module, verb:"pause"\|"resume"\|"restart"\|"speed", value?}` | IPC to the running `replay.q` (`value` = new multiplier for `verb:"speed"`) |

`start` / `stop` / `command` are gated by `OPENQ_CONTROL_TOKEN` exactly like
`/api/control/*`. `speed` is clamped to `[0.25, 500]`.

| Env | Default | Meaning |
|---|---|---|
| `OPENQ_REPLAY_ENABLED` | `1` | off-switch for the replay subsystem |
| `OPENQ_REPLAY_SPEED` / `_STAMP` / `_LOOP` / `_LASTN` | `10` / `now` / `1` / `6` | default playback multiplier / `now`\|`keep` timestamp mode / loop at end / source log files to keep (~1h) |
| `OPENQ_REPLAY_MARKOUT_TP` / `_SRC` / `_PORT` | `:127.0.0.1:5030` / `examples/data/markout/tplogs` / `5098` | markout target: tickerplant, log dir, `replay.q` listen port |
| `OPENQ_REPLAY_SPREAD_TP` / `_SRC` / `_PORT` | `:127.0.0.1:5055` / `examples/data/spread/tplogs` / `5097` | spread target |

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

The **Processes** page (CPU/memory time-series + a per-process table) reads
**`GET /api/pidstats`**, not `/api/query`. `/api/query?table=pidstats&target=mon`
fans through `mon_gw` to `mon_hdb`, whose root `C:/data/db1/mon` is shared with
the table-health archive and holds ~1.1M `pidstats` rows in its newest daily
partition — an unbounded scan there is far too heavy for a 3s poll, and
`.oq.gw.query` can't ask for "just the latest samples". `/api/pidstats`
(`src/pidstats.js`) instead runs a plain `select` against the **mon RDB pair**
directly (`OPENQ_PIDSTATS_RDB`, default `127.0.0.1:5021,127.0.0.1:5101`) and
unions both instances — `mon_idb` pivots which one is subscribed every ~2 min,
so the live rows are on whichever is active now. Returns
`{ connected, endpoints, columns, count, rows }`; the page accumulates the
rows client-side into a 3-minute rolling window.

> `mon_hdb` also now runs `.Q.chk` on load (openQ `core/hdb.q`) so a shared
> `/mon` root's older `tableHealth`-only partitions get empty `logs`/`pidstats`
> splays — an unbounded `select from pidstats` / `from logs` via `/api/query`
> no longer errors with a bare OS path-not-found, it just returns the real
> rows. It's still a whole-history scan, hence `/api/pidstats` for the page.

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
src/modules.js       cfg_proc topology + live probe for /api/modules
src/procMon.js       /api/procmon - every openQ proc (modules topology + probe) x pidstats, flat, for the Process Mon page
src/ohlc.js          rolling OHLC ring from a .u.sub price feed for /api/ohlc
src/eqOhlc.js         eq_m1_yfinance minute bars off eq_hdb for /api/eq/*
src/queryMon.js       .util.gw.queue/.servers rollup per gateway for /api/querymon
src/pidstats.js       live pidstats off the mon RDB pair (unioned) for /api/pidstats
src/jobStatus.js      mon `jobStatus` table - realtime (mon RDB pair) + staged (mon IDB segments) + history (mon HDB) - for /api/jobstatus
src/timers.js        every process's .util.timer.tab via a probe per cfg_proc node (reuses Modules topology) for /api/timers
src/report.js        read the report CEP's .report.latest for /api/report
src/hdbHealth.js     /api/hdbhealth sources: tableHealth / tableHealthEq archives off mon_hdb + a live .Q.pt scan of mon_hdb (TTL-cached)
src/prime.js         read the primefinance CEP's .prime.* state for /api/prime
src/tables.js        /api/tables inventory: each pipeline's RDB pair (per-table max across active/standby), each IDB's staged-since-EOD segment counts, + HDBs
src/explore.js       /api/explore - guarded ad-hoc `select` against any RDB/HDB tableSource (sym/time/order/limit filters, all q-literalised; no free-text where)
src/catalog.js       serve openQ/schemas/catalog.json (data dictionary) for /api/catalog
src/tests.js         parse tests/logs/results/ into /api/tests; kick run_all.sh
src/control.js       start/stop plant, modules, feeders, EOD for /api/control
src/replay.js        spawn/drive openQ modules/replay/replay.q for /api/replay
src/server.js        HTTP routes + WebSocket wiring
scripts/smoke.js     one-shot query check
tools/pidstat-feeder.js  Windows stand-in for modules/mon/pidstat_poller.py
tools/markout-feeder.js  correlated trade/order/rate feed for the markout module
tools/spread-feeder.js   synthetic spreadQuote grid for the spread module
tools/prime-feeder.js    continuous securities-finance events for the primefinance module
```
