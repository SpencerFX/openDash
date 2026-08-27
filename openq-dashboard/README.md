# openQ Dashboard

React/Vite/Tailwind trading dashboard for SpencerFX/openQ.

## Current UI

- Trading overview
- Intraday performance chart
- Order table
- Algo utilisation
- Market-impact decay analytics
- Placeholder pages for orders, algorithms, positions and executions
- Dark trading-terminal UI
- Mock streaming order updates

## Architecture

React -> WebSocket/API gateway -> openQ gateway -> kdb+

openQ already exposes its gateway query path through `.oq.gw.query`, while its TP/RDB/HDB/CEP architecture supports live publication and derived analytics. The dashboard intentionally keeps q/kdb+ outside the browser.

The Node.js service that bridges the two lives in [`../gateway`](../gateway) - it
speaks q IPC to openQ via `jkdb` and serves the browser plain HTTP (`/api/query`)
and WebSocket (`/stream`). See its `README.md` for the API and `INTEGRATION.md`
for how to wire this UI to it.

## Run

```bash
npm install
npm run dev
```

Then open the Vite URL, normally `http://localhost:5173`.

## Next integration

The Node.js gateway that speaks q IPC to openQ now exists in
[`../gateway`](../gateway). Remaining work, all on the browser side, is to
replace the mock state in `src/main.jsx` with calls to it (step-by-step in
[`../gateway/INTEGRATION.md`](../gateway/INTEGRATION.md)):

- `GET /api/query` for historical / order snapshots
- `/stream` WebSocket subscriptions for live order/execution/position updates
- authentication and role-based access (add in front of the gateway)
- production telemetry from the openQ monitoring module
