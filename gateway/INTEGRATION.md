# Wiring the dashboard to the gateway

The dashboard (`../openq-dashboard`) still renders from the mock state in
`src/main.jsx`. This is the concrete path to replace it with live openQ data
through this service. Nothing here is done yet — it's the next step.

## 1. Point the dashboard at the gateway

Add to `../openq-dashboard/.env` (Vite reads `VITE_`-prefixed vars):

```
VITE_GATEWAY_URL=http://localhost:8080
VITE_GATEWAY_WS=ws://localhost:8080/stream
```

Fall back to mock data when unset so the UI still runs with no backend:

```js
const GW = import.meta.env.VITE_GATEWAY_URL;
```

## 2. Snapshot loads (REST)

Replace the module-level `baseOrders` / `chart` / `impact` constants with a
fetch on mount. Example for an orders-style table backed by openQ's `trade`:

```js
async function loadTrades({ sym, start } = {}) {
  const u = new URL("/api/query", GW);
  u.searchParams.set("table", "trade");
  u.searchParams.set("columns", "timestamp,sym,price,size,side");
  if (sym) u.searchParams.set("sym", Array.isArray(sym) ? sym.join(",") : sym);
  if (start) u.searchParams.set("start", start); // ISO; needs a populated HDB if before today
  const res = await fetch(u);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return (await res.json()).rows;
}
```

In `App()`:

```js
const [orders, setOrders] = useState(baseOrders);
useEffect(() => {
  if (!GW) return;                       // keep mock data
  loadTrades({ sym: ["EURUSD", "USDJPY"] })
    .then(setOrders)
    .catch((e) => console.warn("gateway snapshot failed, keeping mock:", e));
}, []);
```

The intraday chart and market-impact panels are the same pattern: one
`/api/query` each (add openQ-side analytics tables or a CEP-derived table for
the aggregates the mock currently fakes).

## 3. Live updates (WebSocket)

Swap the `setInterval` mock updater for a `/stream` subscription:

```js
useEffect(() => {
  if (!import.meta.env.VITE_GATEWAY_WS) return;
  const ws = new WebSocket(import.meta.env.VITE_GATEWAY_WS);
  ws.onopen = () => {
    ws.send(JSON.stringify({ action: "subscribe", table: "trade", sym: ["EURUSD", "USDJPY"] }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "tick") return;
    setOrders((prev) => mergeTicks(prev, msg.rows));   // your reducer: upsert by order id / append fills
  };
  ws.onclose = () => { /* optional: reconnect with backoff */ };
  return () => ws.close();
}, []);
```

`tick.rows` are already row objects with the same shape as the REST `rows`, so
one normaliser serves both.

## 4. Production notes

* Set `CORS_ORIGIN` on the gateway to the deployed dashboard origin (not `*`).
* Put auth in front of the gateway (it currently trusts every caller and openQ's
  default `.z.pw` trusts the gateway). Add a token check in `src/server.js`.
* `OPENQ_TABLES` should be set to the exact tables the dashboard needs.
* Run more than one gateway instance behind a load balancer if query volume
  grows; each keeps its own `OPENQ_POOL_SIZE` connections to openQ.
