# Load run

`storefront.js` is a [k6](https://grafana.com/docs/k6/latest/) script. Each iteration is one new visitor: create a session, buy a random game, pay, then poll the order every 0.5 s until it is finished. It uses only this project's own API (the mock payment provider and the ERP simulator are part of the system under test); real Stripe, Gmail and ERPNext are never called, and no email address is sent, so no email goes out.

`scoreboard.mjs` prints the first proof scoreboard the reconciler publishes after it starts (from the public SSE stream), so each run can be checked against the invariants.

## Run it (Windows)

1. Get k6: download `k6-v2.4.0-windows-amd64.zip` from the [k6 releases](https://github.com/grafana/k6/releases), check its SHA-256 against `k6-v2.4.0-checksums.txt`, and put `k6.exe` in `tools/k6/` (git-ignored).
2. Start Redis and PostgreSQL (`docker compose up -d`), then `npm run migrate`, `npm run provider`, `npm run erp-sim`, `npm run worker`.
3. Start the API with the two visitor limits raised, otherwise one k6 machine is stopped by the per-IP limit of 10 new sessions a minute (PowerShell): `$env:RATE_LIMIT_SESSION_CREATE_PER_MIN="100000"; $env:RATE_LIMIT_SESSION_PER_MIN="100000"; npm start`. Unset, the limits are 10 and 120, as before.
4. `$env:RATE="10"; $env:RAMP="30s"; $env:HOLD="60s"; .\tools\k6\k6.exe run --summary-export=docs/load-results\run.json tools\load\storefront.js` (`RATE` = new visitors per second at the plateau; `BASE_URL` defaults to `http://127.0.0.1:3000`).
5. `node tools/load/scoreboard.mjs`

Every run creates real rows in the local database (orders, events, ERP documents). Results and their environment are in [`docs/load-results/`](../../docs/load-results/README.md).
