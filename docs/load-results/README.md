# Recorded load runs, 2026-11-16 (Step 10)

Tier: **Recorded run**, executed on a laptop, not on a sized server. Every service ran on the same machine as k6.

## Environment

| | |
|---|---|
| Date | 2026-11-16 (clock of the machine, UTC+5:30) |
| Host | Intel Core i5-8250U, 4 cores / 8 threads, 15.9 GB RAM, Windows 11 Home 10.0.26200 |
| k6 | v2.4.0 (commit dd9395906d, go1.26.11, windows/amd64) |
| Node | v24.22.1 |
| PostgreSQL / Redis | `postgres:18` and `redis:8` in Docker, from `compose.yaml` (Redis with `appendonly yes`) |
| Processes | API, worker, mock payment provider, ERP simulator, k6 and both containers on the one machine |
| Backend settings | defaults, except `RATE_LIMIT_SESSION_CREATE_PER_MIN=100000` and `RATE_LIMIT_SESSION_PER_MIN=100000` |
| Script | [`tools/load/storefront.js`](../../tools/load/storefront.js): ramp 30 s, hold 60 s, ramp down 5 s, `RATE` as below, at most 2000 virtual users |
| Email | none sent (pay without an address) |

## Results (raw files in this folder)

`RATE` is the target for new visitors per second at the plateau. "Completed" = the order reached `completed` (invoiced) within 60 s of paying.

| RATE | Iterations started | Completed | Not completed in 60 s | Dropped by k6 | HTTP requests | HTTP failures | Pay to completed (median / p95) | Request duration (p95) |
|---|---|---|---|---|---|---|---|---|
| 10 | 789 | 789 | 0 | 0 | 4179 | 0 | 1.02 s / 1.55 s | 31 ms |
| 50 | 1442 | 1232 | 210 | 1440 | 53177 | 0 | 26.8 s / 58.7 s | 2.38 s |
| 100 | 1845 | 0 | 1844 | 5094 | 58115 | 0 | none completed in time | 3.92 s |

The 50 and 100 runs overloaded this machine: k6 could not start the target number of visitors (dropped iterations) and orders waited for the invoice step. Do not read them as a throughput figure for any other host. "Pay to completed" is measured by polling every 0.5 s.

## Correctness after each run (reconciler scoreboard, `*-scoreboard.json`)

Oversold 0, orders lost 0, completed without invoice 0, paid but not invoiced or refunded 0, stock mismatches none, leaked holds none, in all three saved files. `drain-times.txt` records how long the worker's backlog took to clear after each run ended: 0 s for rate 10, and not within 400 s for rates 50 and 100.

## Not measured

A second machine, a sized host, a run longer than about 2 minutes, the SSE stream under load, the ERP slow or down faults, and a flood of webhook calls straight at `/webhooks/payment` (the webhook path is exercised only through Pay).
