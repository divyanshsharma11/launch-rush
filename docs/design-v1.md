# launch-rush: V1 design note

Status: all 8 sections written and reviewed one by one with the owner (2026-10-28 to 2026-11-02).

## Sections

1. Data flow
2. Order state machine
3. Connector interface
4. PostgreSQL tables
5. API contracts and payloads
6. Idempotency keys
7. Error taxonomy
8. SSE events

---

## 1. Data flow

How one order moves through the system. Stack: Express (HTTP), Redis (stock gate + BullMQ), PostgreSQL (record of orders), SSE (live updates to the browser).

```
Browser
  |  1. POST /api/orders (Buy)
  v
Storefront API (Express)
  |  2. Redis Lua script: check stock, decrement, record reservation (atomic)
  |     -> sold out (or others already waiting)? join the waitlist instead (1.1)
  |  3. Save Order (state: reserved, or waitlisted) in PostgreSQL
  |
Browser
  |  4. POST /api/orders/:id/pay (optional email)
  v
Storefront API (Express)
  |  5. Order reserved -> payment_pending; ask the mock provider to charge
  v
Mock Payment Provider
  |  6. Sends signed webhook "payment.succeeded" (HMAC-SHA256)
  v
Webhook Ingress (Express)
  |  7. Verify signature on raw body
  |  8. Save event in PostgreSQL (a duplicate event id adds no new row)
  |  9. Enqueue webhook job, jobId = event id (always, even for a duplicate; see 5.2)
  | 10. Return 2xx immediately
  v
Webhook job (BullMQ worker)
  | 11. Order payment_pending -> paid, then enqueue one fulfilment job (jobId = fulfil-<orderId>, see 5.3)
  v
Fulfilment job (BullMQ worker)
  | 12. ERP simulator: Sales Order (create -> submit) -> reserve stock (Stock Reservation Entry)
  |     -> Sales Invoice (create -> submit) -> Payment Entry (create -> submit)
  | 13. Order state: completed (order-to-cash is finished once the Payment Entry is submitted)
  | 14. Enqueue one email job (jobId = email-<orderId>), only if an email was given or it is a simulated rush order
  v
Email job (BullMQ worker)
  | 15. Decide the channel once per order (email_channel, 5.1 real-email cap), then
  |     Email connector: Gmail (visitor's order within the cap) or mock email (rush buyers, or cap reached)
  |     Result goes to the email delivery row and emailStatus only; the order state does not change.
  v
SSE stream ---> Browser (animation, order card, scoreboard)
```

The confirmation email is a separate job because it is a notification, not part of order-to-cash: a Gmail problem (daily limit, revoked token) must not mark a paid, invoiced order as failed.

Each state change of the visitor's own orders (shop orders, and their own order in a demo run) is shown live on the SSE stream; simulated buyers' orders are shown as aggregated progress instead (section 8).

Failure paths:
- Sold out at step 2: the buyer joins the waitlist and the order is saved as `waitlisted` (1.1).
- Reservation expires unpaid: a Redis TTL only deletes a key; it does not give stock back, and Redis expiry notifications are fire-and-forget and can arrive late ([docs](https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/)). So an **expiry sweeper**, running every 5 seconds (configurable; it must run well within the 30-second run hold, 5.1), finds orders in `reserved` or `payment_pending` whose `reserved_until` has passed, moves each to `reservation_expired` (conditional update, section 2) and runs the Release Lua script (1.1), which deletes that order's reservation record (so a late payment can re-reserve correctly, next item but one) and passes the copy to the earliest waiter, or back to stock if nobody waits. Only the sweeper that wins the state update returns the stock, so a copy is never returned twice.
- PostgreSQL write fails after step 2 already took a copy (or a waitlist place) in Redis: the API runs the Release script (1.1) for that order before replying with an error. If even that fails (for example the process crashes in between), the reconciler detects the mismatch between Redis stock and PostgreSQL orders. **(2026-11-15, built in Step 6)** The stock-sum check cannot see such a leak (a leaked hold still counts as held), so the reconciler also reads the order ids that hold copies in each shop pool and reports as `leakedHolds` (in its stored result) every one whose order is missing or in `reservation_expired`, `waitlist_ended`, `refund_pending` or `refunded`, once it is found on two passes in a row (a hold exists for a moment during a normal Buy or release). Detect only: an automatic release could free a copy that a late payment (below) is about to take. Waiting orders are left out (the sweeper settles them, 1.1), and so are `failed` orders (replay settles them; a `failed` order that never held a copy is not detected).
- Payment arrives after the reservation expired: the webhook job runs the Lua stock script again for that order. A copy is free and nobody is waiting (1.1): the order continues as `paid`. No copy left: the order moves to `refund_pending`, the refund is issued, and the order moves to `refunded` (5.2); never dropped. The script records the reservation by order id, so a retried or duplicate job never takes a second copy.
- ERP call fails: BullMQ retries with backoff; after the final failure the delivery is marked `failed`, the order moves to `failed`, and it can be replayed from the admin page.
- Email call fails: BullMQ retries with backoff; after the final failure only the email delivery is marked `failed` (`emailStatus = failed`). The order stays `completed`. The email can be replayed from the admin page.
- Duplicate webhook: step 8 adds no second event row, and step 9's job id is ignored while the first job still exists. If a late duplicate still creates a job, it finds the order already past `payment_pending` and either does nothing or repeats a step that is itself keyed (the fulfilment job id, the refund idempotency key; 5.2). So one copy and one invoice.

### 1.1 Waitlist

Why: plan §3.3 step 1 ("stock reserved, or sold out/waitlist"), §3.2 item 2 ("first come, first served, visible queue position") and §3.2 item 3 (unpaid holds expire and return stock). Without a waitlist, a copy returned by an expired hold goes to whoever clicks Buy next, so a later buyer can beat one who was told "sold out" earlier. The waitlist gives each returned copy to the earliest waiter.

Every stock pool (the shop pool of one game, or one demo run's pool, 5.5) has, in Redis:
- the stock counter and the per-order reservation records (as before, no TTL, section 4);
- a waitlist: a sorted set whose members are order ids and whose scores are tickets from a per-pool counter (`INCR`). A counter is needed because members with equal scores are ordered alphabetically, not by arrival ([ZADD docs](https://redis.io/docs/latest/commands/zadd/)).

**Buy** (one Lua script, atomic like the existing stock script; plan §5.8):
1. Run pools only: the buyer (`buyer_ref`) already holds or waits in this run's pool, per the run's buyer set (5.5): return "already" (`409 already_reserved`, 5.1). In the shop the same rule is enforced by the partial unique index on `orders` (5.1).
2. Stock above 0 **and** waitlist empty (`ZCARD` = 0): take a copy, record the reservation, return `reserved`. The "waitlist empty" check stops a newcomer from taking a copy ahead of people already waiting.
3. Otherwise: `ZADD NX` the order id with the next ticket and return `waitlisted` with its position (`ZRANK` + 1; `ZRANK` is 0-based, [docs](https://redis.io/docs/latest/commands/zrank/)).

The API then saves the order as `reserved` or `waitlisted` (with `waitlist_until`). If that insert fails, it runs the release script below for that order, the same compensation as for a reserved copy.

**Release** (one Lua script, used whenever an order gives up its place):
- The order holds a reservation record: delete it, then pass the copy on: if the waitlist is not empty, `ZPOPMIN` the earliest waiter ([docs](https://redis.io/docs/latest/commands/zpopmin/)), record a reservation for that waiter and return its order id; otherwise put the copy back into stock.
- The order is only waiting: `ZREM` it from the waitlist (a missing member is ignored, [docs](https://redis.io/docs/latest/commands/zrem/)).

**A copy comes back** (expiry sweeper, section 1): after the sweeper's conditional update to `reservation_expired` wins, it runs Release. If Release returned a waiter, the sweeper moves that order `waitlisted -> reserved` with a new `reserved_until` (conditional update, section 2). If that update changes 0 rows (the waiter's wait ended at the same moment, or the entry belongs to an order that was never saved), the sweeper runs Release for that order too, which hands the copy to the next waiter or back to stock.

**Wait ends**: a waitlisted order waits until `waitlist_until` (configurable; starting value 10 minutes) or until its demo run ends (5.5), whichever is first. The sweeper moves it `waitlisted -> waitlist_ended` (conditional update), then runs Release for it. Release handles both cases: still waiting (removed from the waitlist) or already handed a copy whose PostgreSQL update did not happen (the copy is passed on). So a crash between the Redis step and the PostgreSQL step of a promotion cannot hold a copy longer than the waiter's `waitlist_until`.

**Races** are settled by the conditional update (section 2): if the promotion's update runs first, the wait-end update changes 0 rows and does nothing; if the wait-end update runs first, the promotion's update changes 0 rows and the copy is handed on.

**Late payment (option B) and the waitlist:** the late payment's re-reserve takes a copy only if stock is above 0 **and** the waitlist is empty; it never joins the waitlist. People already waiting came first, and the late payer's hold had expired, so otherwise the payment is refunded (section 1).

**Visible position:** Buy returns the position; the order card and the SSE stream show it as it changes (5.1, section 8). A waitlisted order cannot be paid (`409 invalid_state`, 5.1).

**Not covered by the waitlist:** copies only come back from expired holds. If every hold is paid, waiters wait until `waitlist_until` and their orders end as `waitlist_ended`.

### 1.2 Shop restock

Why: shop stock only goes down (every paid order keeps its copy), so without a refill every shop game eventually sells out for all visitors, and plan §3.2 item 6 ("normal days: a regular purchase flows straight through") stops working. Demo runs are not restocked: each run is a short, separate launch whose point is selling out (5.5).

**Trigger:** a background job checks every shop game (`listed_in_shop = true`) every 30 seconds. If the game's Redis stock is 0 and no restock was made for it in the current 10-minute window, it restocks `games.stock_total` copies (one batch of the starting size). The 30 seconds, 10 minutes and batch size are configurable starting values. The 10-minute window caps how fast stock can grow, even if someone keeps buying and abandoning holds.

**Steps** (the order matters; each step is safe to repeat):
1. **Record it in PostgreSQL:** `INSERT INTO stock_receipts (id, game_id, dedupe_key, qty) ... ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`. For the timer, `dedupe_key` is `timer:<gameId>:<window start>`, so there is at most one timer receipt per game per window and two job instances running at once cannot both restock; the one whose insert returned no row stops ([docs](https://www.postgresql.org/docs/current/sql-insert.html)).
2. **Add to the ERP simulator first:** an internal simulator endpoint adds `qty` to the item's available quantity, keyed by the receipt id, so a repeated call adds nothing (5.3). This comes **before** Redis on purpose: if Redis got the copies first, a buyer could take one, pay, and reach the ERP's Reserve step before the ERP had the stock, and fail with `InsufficientStock`. Extra available stock in the ERP for a moment is harmless, because the ERP's quantity is only a guard.
3. **Add to Redis:** one Lua script (atomic, plan §5.8), keyed by the receipt id: if the id is already in the pool's set of applied receipts (`SADD` returns 0 for an existing member, [docs](https://redis.io/docs/latest/commands/sadd/)), do nothing. Otherwise, for each new copy: if someone is waiting, give it to the earliest waiter exactly as Release does (1.1) and note that waiter's order id; else add it to stock.
4. **Promote the noted waiters** in PostgreSQL: `waitlisted -> reserved` with a new `reserved_until`, conditional update as in 1.1. If an update changes 0 rows, run Release for that order, which hands the copy on.
5. **Mark the receipt done** (`erp_applied_at`, `redis_applied_at`).

**Crash safety:** on every tick the job also re-runs steps 2-5 for receipts not yet marked done. Steps 2 and 3 are keyed by the receipt id, so nothing is added twice. If the job crashed after step 3 but before step 4, the noted waiters hold a copy in Redis while still `waitlisted` in PostgreSQL; the existing rule in 1.1 covers this: when their `waitlist_until` passes, the sweeper ends their wait and Release hands the copy on, so a copy is held no longer than that.

**Effects elsewhere:**
- Waiters are served first, in order, so restocking keeps the first-come-first-served rule (1.1).
- The scoreboard rule becomes "all-time sold ≤ starting stock + all recorded receipts" (timer restocks and admin refills, 5.4). Receipts are recorded **before** the copies are added (step 1), so the bound is never smaller than the copies actually sold; it cannot raise a false alarm. "Sold" counts each order once (distinct orders that ever entered `paid`), because an order replayed after `failed` can enter `paid` a second time (section 2).
- The reconciler's Redis-versus-PostgreSQL stock check counts receipts not yet marked done as "in progress", not as a mismatch.
- The SSE `stock` event already reports any stock change (section 8), so the page shows the refill.

**Admin refill:** the admin "reset demo stock" (plan §3.4) uses the same steps: it adds copies up to a shop game's starting level, based on the stock at the moment of the click: one receipt of `games.stock_total - current Redis stock` copies (nothing is done if that is 0 or less), `dedupe_key` = `admin:<random id>`. It cancels no orders and clears no waitlist; waiting buyers get the new copies first. A refill running at the same moment (a double click, or the timer restock) can leave the stock above the starting level; every refill is recorded before its copies are added (step 1), so the scoreboard stays correct and no order is affected.

Five background jobs run independently of this flow (**2026-11-15:** a sixth, the **recovery** job, is described in section 7 under "After the final failure", and a seventh, the **redelivery** job, in section 5.2 under the mock provider): the **expiry sweeper** (failure paths above), the **shop restock** (1.2), the **reconciler**, which reads PostgreSQL (and checks Redis stock against it) to compute the scoreboard, the **demo-run cleanup** (5.5), and the **email purge**, which sets `orders.buyer_email` to null 24 hours (configurable) after `orders.email_saved_at`, as plan §4.1 requires ("store visitor emails briefly; delete after a short period"). A failed email replayed after the purge has no address and ends as `failed`.

---

## 2. Order state machine

Each order is in exactly one state. A transition is one PostgreSQL transaction: `UPDATE orders SET state = <new> WHERE id = <id> AND state = <expected>`, and, only if that updated a row, an `INSERT` into `order_transitions` (section 4). Both commit together, so the history the SSE stream reads (section 8.4) never misses a state change. If two events race for the same order, the second one waits for the first to commit, re-checks the `WHERE` against the updated row (PostgreSQL's default Read Committed behaviour, [docs](https://www.postgresql.org/docs/current/transaction-iso.html)), finds the state already changed, and updates zero rows. The code treats "zero rows updated" as "someone else already moved this order". Transitions of a visitor's own orders (shop orders, and their own demo-run order) are sent live on the SSE stream; simulated buyers' orders are shown as aggregated progress (section 8).

Happy path:

```
reserved -> payment_pending -> paid -> so_submitted -> invoiced -> completed
```

`completed` means order-to-cash is finished: paid, and Sales Order, Sales Invoice and Payment Entry all submitted. The confirmation email is not an order state; it is tracked in its own delivery row and shown as `emailStatus` (section 1, 5.1).

Side states: `waitlisted` (sold out at Buy, section 1.1; left by promotion or wait end), `waitlist_ended` (terminal), `reservation_expired` (left only by a late payment), `refund_pending` (refund decided, not yet confirmed; 5.2), `refunded` (terminal), `failed` (left only by admin replay).

| From | To | Trigger |
|---|---|---|
| (none) | reserved | Redis Lua script reserved a copy and the order was saved |
| (none) | waitlisted | sold out (or others already waiting): the Lua script added the order to the pool's waitlist and the order was saved (1.1) |
| waitlisted | reserved | a returned copy was handed to this order, the earliest waiter (1.1); new `reserved_until` |
| waitlisted | waitlist_ended | `waitlist_until` passed, or the order's demo run ended (1.1, 5.5) |
| reserved | payment_pending | visitor called Pay (5.1); the state changes, then the API asks the mock provider to charge (section 1, step 5) |
| reserved, payment_pending | reservation_expired | expiry sweeper found `reserved_until` passed; the copy goes to the earliest waiter or back to stock (section 1, 1.1) |
| payment_pending | paid | verified, non-duplicate `payment succeeded` webhook accepted |
| paid | so_submitted | ERP simulator: Sales Order submitted |
| so_submitted | invoiced | ERP simulator: stock reserved (Stock Reservation Entry), then Sales Invoice created and submitted (a draft invoice has no ledger effect, 5.3) |
| invoiced | completed | ERP simulator: Payment Entry created and submitted; the fulfilment job then enqueues the email job |
| reservation_expired | paid | `payment succeeded` webhook arrives after the reservation ended, and the Lua script re-reserved a free copy (only when nobody is waiting, 1.1) |
| reservation_expired | refund_pending | same late webhook, but no copy is left (sold out); the decision is recorded before the refund call (5.2) |
| refund_pending | refunded | the mock provider's refund call succeeded (`Idempotency-Key: refund-<orderId>`) |
| paid, so_submitted, invoiced, refund_pending | failed | final retry of that step failed (ERP step, or for `refund_pending` the refund call, so a paid order is not left silently unrefunded); kept for replay. An email failure never moves the order here. |
| failed | (last good state) | admin replay re-enqueues the job; the last good state is the `from_state` of the transition into `failed` in `order_transitions`, and the job continues from there |

Retries are not a state. While BullMQ retries a step, the order stays in its last state, the delivery record holds the attempt count and last error, and the SSE stream emits a `delivery.retrying` event (section 8) so the animation can show it.

Naming: the plan's `sold_out_refunded` is called `refunded`. The only path into it is "paid after the reservation expired, and no copy was left" (through `refund_pending`), so it always means sold out and needs no separate reason column. The page labels it "Refunded (sold out)".

---

## 3. Connector interface

Every outside system (payment provider, ERP, email) is reached through one interface. The storefront API (the charge in Pay, 5.1) and the workers call connectors by id and never contain Gmail- or ERP-specific code, so swapping mock email for Gmail, or adding a connector later, needs no change to the core. Shown TypeScript-style for readability; the language choice is not part of this note.

```ts
interface Connector {
  id: string;                         // 'payment-mock', 'erp-sim', 'email-mock', 'email-gmail'
  capabilities: string[];             // actions it supports, e.g. ['sales_order.submit', 'sales_invoice.submit']
  execute(action: string, payload: object, ctx: Ctx): Promise<Result>;
  classifyError(err: unknown): ErrorClass;
  healthCheck(): Promise<boolean>;
}

// Separate, small interface: only connectors that receive webhooks implement it (today: payment-mock).
interface InboundVerifier {
  verifyInbound(rawBody: Buffer, headers: Headers): VerifiedEvent;
}

type Ctx = { orderId: string; runId: string | null; idempotencyKey: string; attempt: number; timeoutMs: number };   // runId: demo run (5.5), null for shop orders
type ErrorClass = { kind: 'retryable' } | { kind: 'permanent' } | { kind: 'rateLimited'; retryAfterMs: number };
```

How each member is used:
- `execute`: does one action against the outside system. Must be safe to call twice with the same `idempotencyKey` (section 6), because BullMQ is at-least-once.
- `classifyError`: turns a raw error (timeout, HTTP 429, validation error) into one of three classes. The worker only reads the class: retry with backoff, stop and mark `failed`, or wait `retryAfterMs`. The full table of errors is section 7.
- `healthCheck`: used by the admin page (`GET /admin/health`, 5.4). It is not the breaker's half-open probe: in opossum, half-open lets the next real call through as the trial ([opossum source](https://github.com/nodeshift/opossum/blob/main/lib/circuit.js)).
- `verifyInbound` (on `InboundVerifier`, not on `Connector`, so email and ERP connectors do not carry a method that does not apply to them; interface segregation): `payment-mock` implements both interfaces, and the webhook ingress depends only on `InboundVerifier`. It checks the HMAC signature on the untouched raw body and rejects old timestamps, then returns the verified event. Called by the webhook ingress (data flow step 7).

The connectors in V1:

| id | Real or mock | Actions |
|---|---|---|
| `payment-mock` | mock | `charge`, `refund`, **(2026-11-14)** `resend_webhook` (the "Duplicate" control, 5.5); sends signed webhooks |
| `erp-sim` | mock (ERPNext-shaped) | `sales_order.submit`, `stock.reserve`, `sales_invoice.submit`, `payment_entry.submit` (each: check by `order_ref`, create if missing, submit if draft; 5.3), **(2026-11-14)** `stock.add`, `run.delete` (simulator wiring only, 5.3) |
| `email-mock` | mock | `email.send` (simulated: rush buyers, and visitor orders after the real-email cap) |
| `email-gmail` | real, capped | `email.send` (the visitor's own order, within the cap) |

`email-mock` and `email-gmail` expose the same action, so choosing between them is a single decision in the email job, stored once per order as `orders.email_channel` (5.1 real-email cap).

The circuit breaker (opossum) wraps each connector's `execute`: one breaker per connector for shop orders, plus one per connector per demo run (5.5), chosen by `ctx.runId`. So a failing ERP trips only its own breaker, and a run's faults trip only that run's breaker.

Errors created by the breaker itself never reach `classifyError`, so the caller checks them first (codes from the [opossum source](https://github.com/nodeshift/opossum/blob/main/lib/circuit.js)): `EOPENBREAKER` (breaker open) is `rateLimited(resetTimeout)`, `ETIMEDOUT` (call exceeded the breaker's `timeout`) is `retryable`. Any other error goes to the connector's `classifyError`.

---

## 4. PostgreSQL tables

Nine tables (`demo_runs` added with section 5.5, `stock_receipts` with 1.2). Column types are the standard ones (`uuid`, `text`, `integer`, `boolean`, `timestamptz`, `jsonb`). Money is stored as integer minor units (`amount_minor`) plus a `currency` code, to avoid rounding errors. Redis holds live stock and one reservation record per order, **without a TTL**: expiry is driven by `orders.reserved_until` and the expiry sweeper (section 1). A TTL would let Redis delete the record on its own while the copy is still counted as taken, and then a late payment's re-reserve (section 1) would take a second copy. PostgreSQL is the record of what happened.

| Table | Purpose | Main columns |
|---|---|---|
| `games` | Shop catalog (luduscore ids) plus our price and starting stock, ~~and one row for the fictional launch game "Ironvale Ascent" (plan rule 8, §14), which only demo runs sell (5.5; owner's decision 2026-11-02)~~ plus "Grand Theft Auto VI" (`gta-6`, not in luduscore), sold like every other game in the shop and in runs (owner's decision 2026-11-03; real names as plain text, plan rule 8). **(2026-11-05)** Physical copies only: the 85 games seeded by migration 012 are the luduscore games with a verified physical price, plus `gta-6` and `inside-limbo-double-pack`, added through luduscore's `extra_games`. Prices and sources: `tools/catalog_prices.json` | `id` (luduscore slug, or our own slug for a game not in luduscore, e.g. `gta-6`; PK), `title`, `price_minor`, `currency`, `stock_total`, `listed_in_shop` (true for every game; ~~false for the launch game~~) |
| `sessions` | Anonymous visitor (id sent as `X-Session-Id`, 5.1) | `id` (PK), `created_at` |
| `orders` | One purchase | `id` (PK), `session_id` (FK; null for simulated buyers' orders, which are found through `run_id`, so per-session queries never return them; owner's decision 2026-11-03), `game_id` (FK), `amount_minor`, `currency`, `state`, `buyer_email` (null unless given; set to null by the email purge job 24 hours after `email_saved_at`, section 1), `email_saved_at` (when `buyer_email` was saved; the purge job needs it, and `updated_at` cannot serve because every state change updates it), `email_channel` (`gmail` / `mock` / null; decided once by the email job, 5.1 real-email cap), `waitlist_until` (set only for `waitlisted` orders, 1.1), `is_simulated` (simulated buyer; false for the visitor's own run order), `run_id` (FK to `demo_runs`, null for normal shop orders), `buyer_ref` (buyer id inside a run: a simulated buyer id, or the session id for the visitor's own run order; null for shop orders), `reserved_until`, `created_at`, `updated_at` |
| `order_transitions` | History of state changes; feeds the event log and SSE | `id` (from a sequence), `order_id` (FK), `from_state`, `to_state`, `at` |
| `payment_events` | Every webhook received, once | `event_id` (PK, the provider's event id), `order_id` (FK), `type`, `payload` (jsonb), `received_at` |
| `deliveries` | One outside action for one order, with retry status | `id`, `order_id` (FK), `connector`, `action`, `status` (`pending` / `succeeded` / `failed`), `attempts`, `last_error`, `next_retry_at` |
| `erp_documents` | What the ERP simulator created | `id`, `order_id` (FK), `doctype` (Sales Order / Stock Reservation Entry / Sales Invoice / Payment Entry), `name` (e.g. invoice number), `docstatus` |
| `stock_receipts` | One shop restock: timer (1.2) or admin refill (5.4) | `id` (PK), `game_id` (FK), `dedupe_key` (UNIQUE; `timer:<gameId>:<window start>` or `admin:<random id>`), `qty`, `created_at`, `erp_applied_at`, `redis_applied_at` |
| `demo_runs` | One visitor's sandbox run (rush and/or faults), section 5.5 | `id` (PK), `session_id` (FK), `game_id` (FK; the game the visitor picked for the run, any listed game; owner's decision 2026-11-03, was "always the launch game"), `stock_total`, `buyers_requested`, `faults` (jsonb), `status` (`running` / `finished` / `stopped`), `created_at`, `ends_at` |

Rules the database enforces (these are what make the invariants hard to break):
- `orders.state` has a `CHECK` limiting it to the states in section 2.
- `payment_events.event_id` is the primary key, so a duplicate webhook is rejected at insert (`INSERT ... ON CONFLICT DO NOTHING`).
- `deliveries` has `UNIQUE (order_id, action)`: one action per order, however many times a job is retried.
- **(2026-11-15, built in Step 8)** `deliveries.error_class` (migration 020, `retryable` / `rateLimited` / `permanent`, null until a step fails) holds the class of the last failure of a step (also `permanent`, and kept when the row ends `failed`), so the stream can send `delivery.retrying` (8.3) without parsing `last_error`. It is set with `next_retry_at` when a step fails (only a `rateLimited` failure has a known retry time, the delay of a plain retry is chosen later by BullMQ) and cleared when the step starts again.
- `erp_documents` has `UNIQUE (order_id, doctype)`: at most one Sales Order, Sales Invoice and Payment Entry per order.
- Foreign keys on every `order_id`, so no orphan records. They use `ON DELETE CASCADE`, and so does `orders.run_id`, so the demo-run cleanup (5.5) deletes a run and all its orders and their rows in one statement; with the default (`NO ACTION`) that delete would fail on the child rows ([docs](https://www.postgresql.org/docs/current/ddl-constraints.html)). Shop orders are never deleted.
- Partial unique index on `orders (session_id, game_id) WHERE run_id IS NULL AND state IN ('waitlisted', 'reserved', 'payment_pending')`: one active reservation or wait per session per game (5.1).
- Partial unique index on `demo_runs (session_id) WHERE status = 'running'`: one active run per session (5.5).

About `order_transitions.id`: sequence values are distinct but are taken when the row is inserted, not when the transaction commits, and are never rolled back ([docs](https://www.postgresql.org/docs/current/sql-createsequence.html)). So across different orders a smaller id can become visible after a larger one, and a reader that only asks for "id greater than the last one I sent" can skip a row. Within one order the ids do follow commit order, because the second transition's `UPDATE` waits for the first to commit before its `INSERT` runs (section 2). Section 8 must rely only on that per-order order.

Example reconciler check, which must return 0 rows: orders that are `completed` but have no submitted Sales Invoice (a draft has no ledger effect, 5.3).

```sql
SELECT o.id FROM orders o
WHERE o.state = 'completed'
  AND NOT EXISTS (SELECT 1 FROM erp_documents d
                  WHERE d.order_id = o.id AND d.doctype = 'Sales Invoice' AND d.docstatus = 1);
```

---

## 5. API contracts and payloads

Split into 5.1 storefront API, 5.2 payment webhook, 5.3 ERP simulator, 5.4 admin. The SSE stream is in section 8.

Shared conventions:
- JSON bodies; errors always `{ "error": { "code": "<snake_case>", "message": "<text>" } }`. Some codes add fields inside `error`, listed where the code is defined (e.g. `already_reserved` adds `orderId`, `invalid_state` adds `state`; section 6 relies on both). **(2026-11-10)** An unexpected server error (e.g. a database or Redis failure) is `500 internal_error` with message `internal error`; no details or stack trace in the reply (Express's built-in handler would send `err.stack` as HTML outside production, [Express docs](https://expressjs.com/en/guide/error-handling.html)).
- Rate limits (`429 rate_limited`): `POST /api/session` is limited per client IP (otherwise new sessions would bypass per-session limits); every other visitor call is limited per session. Limits are configurable starting values. **(2026-11-15, built in Step 6)** Fixed window counted in Redis (one Lua script): 10 session creations per minute per IP, 120 other calls per minute per session; the reply carries `Retry-After` in whole seconds; if Redis cannot be reached the request is allowed (the stock gate itself refuses sales without Redis). Behind a proxy the IP is only right once Express `trust proxy` is set (hosting step).
- Money as integer minor units plus currency (section 4).
- The frontend runs on a different site than the backend, so the backend sends CORS headers allowing only the portfolio origin, and the portfolio's CSP `connect-src` must list the backend origin. Calls with `X-Session-Id` or a JSON body are not "simple" requests, so the browser sends a preflight first ([MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)). The preflight reply carries `Access-Control-Allow-Origin: <portfolio origin>`, `Access-Control-Allow-Methods: GET, POST, PUT`, `Access-Control-Allow-Headers: Content-Type, X-Session-Id` and `Access-Control-Max-Age`; every reply carries `Access-Control-Allow-Origin` and `Vary: Origin`. No credentials mode, since no cookies are used.
- **(2026-11-15, built in Step 8)** `controllers/cors.js`: the single allowed origin is `PORTFOLIO_ORIGIN` (default `http://localhost:5173`, must be a bare origin), every reply has `Vary: Origin` and `Access-Control-Expose-Headers: Retry-After`, a preflight is answered `204` with `Access-Control-Max-Age: 600`. Without Expose-Headers the page could not read `Retry-After` on a `429`: only the CORS-safelisted response headers are readable ([MDN Access-Control-Expose-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers); `Retry-After` is not on that list). `Max-Age` defaults to 5 s and browsers cap it (Chromium 7200 s, Firefox 86400 s), so 600 s is honoured everywhere ([MDN Access-Control-Max-Age](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age)). Step 11 must set `PORTFOLIO_ORIGIN` on the host; Step 9 adds the backend origin to the portfolio CSP `connect-src` (only in builds where `VITE_LAUNCH_RUSH_API` is set).
- Real game names (owner's decision 2026-11-03, plan rule 8 and §3.5): names are plain text only; nothing is sold or delivered. Every confirmation email (Gmail and mock) has a subject starting with `[DEMO]`, opens with the demo disclaimer ("simulated payment, nothing was charged, no game will be delivered; not affiliated with or endorsed by any game publisher"), uses the project name as sender name, links only to the project page and never asks for information. The disclaimer text is defined once in the backend code and used by every email; the README and the demo page (portfolio repo) carry the same wording. Hiding a game is `games.listed_in_shop = false` (removes it from `GET /api/games`, the run picker and restock, 1.2, 5.5).

### 5.1 Storefront API (called by the demo page)

Visitor identity: no cookie. The backend issues a random anonymous session id; the frontend keeps it in `localStorage` and sends it as `X-Session-Id` on every call below except `POST /api/session`. Reason: frontend and backend are on different sites, and a backend cookie would be third-party, which Safari and Firefox restrict by default ([MDN](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies)). Unknown or missing id: `401 session_required`, and the frontend calls `POST /api/session` again.

| Method and path | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/session` | Create an anonymous session | `201 { "sessionId": "<uuid>" }` | `429 rate_limited` |
| `GET /api/games` | Shop catalog with price and live stock: only games with `listed_in_shop = true` (~~the launch game is sold only in demo runs, 5.5~~; also the list the run's game is picked from, 5.5) | `200 { "games": [ { "id", "title", "priceMinor", "currency", "stockTotal", "stockLeft" } ] }` (`stockTotal` = starting stock, added 2026-11-16 in Step 9 for the shop's stock bar) | |
| `POST /api/orders` | Buy: reserve one copy, or join the waitlist when sold out (1.1) | `201 { "orderId", "state": "reserved", "reservedUntil", "buyerNumber" }` or `201 { "orderId", "state": "waitlisted", "waitlistPosition", "waitlistUntil" }` | `409 already_reserved` (+ `orderId`, `state`; also when already waitlisted), `404 unknown_game`, `404 not_found` (run is not this session's), `409 run_ended`, `400 invalid_input` (with `runId`, `gameId` is not the run's game; ~~without `runId`, `gameId` is the launch game, which is not sold in the shop;~~ 5.5), `503 unavailable` (Redis stock gate unreachable), `429 rate_limited` |
| `POST /api/orders/:id/pay` | Start the mock payment | `202 { "orderId", "state": "payment_pending" }` | `404 not_found`, `409 invalid_state` (+ `state`; e.g. waitlisted, expired, or already paid), `400 invalid_email`, `502 payment_unavailable` (provider call failed; safe to retry), `429 rate_limited` |
| `GET /api/orders/:id` | Order card | `200 { "orderId", "gameId", "state", "invoiceNo", "emailStatus", "reservedUntil", "waitlistPosition", "waitlistUntil" }` (the two waitlist fields only while `waitlisted`; position read live with `ZRANK`) | `404 not_found` |
| `GET /api/orders` | "My orders" for this session | `200 { "orders": [ ...same shape as above ] }` | |

Request bodies:
- `POST /api/orders`: `{ "gameId": "<games.id>", "runId": "<optional>" }`. Without `runId` the order is a normal shop order. With `runId` (the session's own running demo run, 5.5) the visitor's order competes in that run's stock pool against the simulated buyers; it is a real order (`is_simulated = false`, real email if given), with `buyer_ref` = the session id.
- `POST /api/orders/:id/pay`: `{ "email": "<optional, for the real confirmation email>" }`. The page states next to the email field that the address is deleted after 24 hours (plan §4.1).

Pay behaviour:
- Order `reserved`: in one update, move it to `payment_pending` and save the email (if given); then ask the mock provider to charge with `Idempotency-Key: charge-<orderId>`.
- Order already `payment_pending` (a retry, e.g. the first provider call failed or the reply was lost): send the same charge again with the same key and reply `202`. The provider returns the existing payment for that key, so this never charges twice (section 6). The email saved by the first call is kept.
- If the provider call fails, the reply is `502 payment_unavailable`; the order stays `payment_pending`, so the visitor can press Pay again until the reservation expires.

Rules:
- An order is only visible to the session that created it (`404`, not `403`, so ids cannot be probed).
- `buyerNumber` is the position in which the Lua script granted reservations **within that stock pool** (the shop pool, or one run's pool), which is what makes first-come-first-served visible (plan §3.2).
- One active reservation or wait per session per game in the shop: a partial unique index on `orders (session_id, game_id) WHERE run_id IS NULL AND state IN ('waitlisted', 'reserved', 'payment_pending')` returns `409 already_reserved` for a second Buy (PostgreSQL partial unique index, [docs](https://www.postgresql.org/docs/current/indexes-partial.html)). This also covers double-clicks. If that insert fails, the Release script gives back the copy or waitlist place taken in Redis (1.1). Inside a run, the same rule is enforced by the Lua script's buyer set (`buyer_ref` = session id, 5.5).
- Hold time (`reserved_until` = time of the grant + hold): **5 minutes** for shop orders (plan §3.2 item 3, "a few minutes"); **30 seconds** for demo-run orders, so holds can expire within a run of at most 5 minutes (5.5). Both configurable (owner's decision 2026-11-02). A waiter promoted from the waitlist gets the same hold from the moment of promotion (1.1).
- Redis unreachable during Buy: reply `503 unavailable` and do not create an order. The system never sells without the stock gate (consistency over availability, plan §8).
- `emailStatus` is `none`, `pending`, `sent_gmail`, `simulated`, `simulated_limit` or `failed`, which drives the honesty label on the order card (plan §3.5). It is not stored on the order; it is derived:
  - `none`: no email was requested (not a simulated rush order, `email_channel` is null and `buyer_email` is null); **(2026-11-15, Step 7)** also an order in `refunded` or `waitlist_ended`, which can never complete, so no email can come (a `reservation_expired` order stays `pending`: a late payment can still complete it);
  - `pending`: an email is expected but the order's `email.send` delivery row is missing or `pending`;
  - `sent_gmail`: delivery `succeeded`, `email_channel = gmail`;
  - `simulated`: delivery `succeeded`, `email_channel = mock`, simulated rush order;
  - `simulated_limit`: delivery `succeeded`, `email_channel = mock`, visitor's own order (the real-email cap was reached); the card says "Email: simulated (real-email limit reached)";
  - `failed`: delivery `failed`.

**Real-email cap** (plan §4.1: at most 1-2 real emails per visitor and a daily ceiling well under 500; Gmail's own limit is about 500 a day, plan §5.1). Owner's values: **2 per session** (a session is the visitor identity, plan §3.4) and **200 per day** (UTC day). Both configurable.
- When: the email job decides the channel, not Pay. So the quota is used only by orders that actually reach `completed`; an order that expires unpaid uses nothing. If `email_channel` is already set (a retried job), the job uses it and skips the script. Simulated rush orders get `mock` without the script.
- How: one Redis Lua script (atomic, plan §5.8), keyed by order id so a retried job never counts twice. It keeps two sets of order ids: one per session and one per UTC day (`SADD` ignores members already present; `SCARD` returns 0 for a missing key; [SADD](https://redis.io/docs/latest/commands/sadd/), [SCARD](https://redis.io/docs/latest/commands/scard/)). If the order id is already in either set, return `gmail` (already counted). Else, if the session set has fewer than 2 and the day set fewer than 200, add the order id to both and return `gmail`. Else return `mock`. The day set gets a 2-day expiry (`EXPIRE ... NX`, [docs](https://redis.io/docs/latest/commands/expire/)) so old days are removed. The session set has no expiry, because the per-visitor cap is not per day (plan §4.1); it holds at most 2 order ids per session.
- Then the job stores the result with `UPDATE orders SET email_channel = <result> WHERE id = <id> AND email_channel IS NULL`, so a retried job keeps the first decision, and uses `email-gmail` or `email-mock` accordingly. With `mock` for a visitor's order, `buyer_email` is cleared at the same time, because no real email will use it (plan §4.1: store briefly).
- Why a script and not a count in PostgreSQL: two email jobs at the same moment could both read "1 sent so far" and both send; the Lua script checks and adds in one atomic step.
- Counting by UTC day with a ceiling of 200 means any 24-hour window holds at most 400 real emails (it spans at most two UTC days), still under Gmail's about-500 limit, whichever way Google counts its day.
- Limit of the per-session cap: a visitor can open new sessions (session creation is rate-limited per IP, 5.1 conventions); the daily ceiling still bounds the total.
- `stockLeft` is read from Redis, not PostgreSQL, because Redis is the stock gate.

### 5.2 Payment webhook (mock payment provider -> our ingress)

The mock provider copies Stripe's documented webhook scheme ([Stripe docs](https://docs.stripe.com/webhooks)) so the ingress code is the same shape a real provider would need. Real Stripe is never load-tested.

**Endpoint:** `POST /webhooks/payment`

**Headers:**
- `Content-Type: application/json`
- `Mock-Signature: t=<unix seconds>,v1=<hex HMAC>`

**Signature:** `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`, hex-encoded. `secret` is a shared env var (`PAYMENT_WEBHOOK_SECRET`), never in job data or logs. Node APIs: `crypto.createHmac('sha256', secret)` and `crypto.timingSafeEqual` ([Node docs](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b)). `timingSafeEqual` throws if the two buffers differ in length, so lengths are checked first and a mismatch counts as an invalid signature.

**Body (event):**

```json
{
  "id": "evt_<random>",
  "type": "payment.succeeded",
  "created": 1793500000,
  "data": { "paymentId": "pay_<random>", "orderId": "<uuid>", "amountMinor": 199900, "currency": "INR" }
}
```

Event types: `payment.succeeded`, `payment.refunded`. Event ids always have a non-digit prefix and no colon, because they are reused as BullMQ job ids (next list).

**Ingress steps (in order):**
1. Read the body as raw bytes: `express.raw({ type: 'application/json' })` on this route only, so `req.body` is the untouched `Buffer` ([Express docs](https://expressjs.com/en/5x/api/express/)). The rest of the API keeps `express.json()`, registered **after** this route: Express applies middleware in order, and a JSON parser that runs first changes the body and breaks the signature check ([Stripe docs](https://docs.stripe.com/events/manage-webhook-endpoints)).
2. Verify the signature and reject a `t` older than 5 minutes (Stripe's default tolerance; blocks replayed requests). Failure: `400 invalid_signature`. **(2026-11-05)** A body with a valid signature that is not valid JSON: `400 invalid_payload` ~~, so the provider does not retry it forever~~ (corrected 2026-11-05: a non-2xx is retried a few times either way, by our mock provider and by Stripe; `400` is used because the sender's body is invalid, not our server) (Stripe's example handler also answers `400` on a parse error, [docs](https://docs.stripe.com/webhooks)). **(2026-11-10)** A signed body that is valid JSON but not a valid event (not an object, or `id`, `type` or `data.orderId` missing or malformed): also `400 invalid_payload`.
3. `INSERT INTO payment_events ... ON CONFLICT (event_id) DO NOTHING`.
4. Enqueue a BullMQ job with `jobId = event id`, **whether or not step 3 inserted a row**. BullMQ ignores a job whose id already exists in the queue ([BullMQ docs](https://docs.bullmq.io/guide/jobs/job-ids)), so this is safe, and it fixes the crash case: if the process dies after step 3 but before step 4, the provider's retry re-enqueues it instead of being dropped as a duplicate.
5. Reply `200 { "received": true }` immediately. Errors in steps 3-4: `500`, so the provider retries.

**Why duplicates still cannot double-invoice:** BullMQ accepts the same id again once the old job has been removed (docs above), so a late duplicate can create a second job. The worker is still safe, because every step goes through the conditional state update (section 2) and the unique keys (section 4): the second job finds the order already past `payment_pending` and either does nothing or re-sends a step that is itself keyed (the fulfilment job id, the refund idempotency key; list below).

**Worker handling of `payment.succeeded`:**
- Order in `payment_pending`: move to `paid`, then enqueue the fulfilment job (5.3), which does the ERP steps.
- Order in `reservation_expired`: run the Lua stock script again for this order (it grants a copy only if stock is above 0 and nobody waits, 1.1). Copy granted: move to `paid` and continue as above. No copy: move to `refund_pending` first, then call `payment-mock` `refund` with `Idempotency-Key: refund-<orderId>`, then move `refund_pending -> refunded`.
- Order already `paid`: enqueue the fulfilment job anyway (BullMQ ignores it if it exists). This covers a crash after the `paid` update but before the enqueue; without it the retried job would stop here and the order would never be fulfilled.
- Order already `refund_pending`: call the refund again with the same key (the provider returns the existing refund, section 6), then move to `refunded`. This covers a crash between the decision and the refund call, or between the refund call and the final update.
- Any other state: already handled, do nothing.

Why `refund_pending` is recorded **before** the refund call: if the order stayed `reservation_expired` until after the call, a crash after the refund but before the update would make the retried job run the stock script again; a copy freed in the meantime would then be granted, and the order would be both refunded and fulfilled. Recording the decision first means a retry can only finish the refund.

`payment.refunded` is recorded in `payment_events` as confirmation; it does not change the order state.

**Mock provider behaviour:**
- Retries a non-2xx delivery a few times with backoff, like a real provider, and signs **each attempt with a fresh timestamp**, as Stripe does ([Stripe docs](https://docs.stripe.com/webhooks)). Without that, any retry later than 5 minutes would fail our timestamp check forever. The "Duplicate" resend (5.5) is signed fresh too; it keeps the same event id.
- **(2026-11-15, built in Step 6) Redelivery.** After its last attempt a delivery is `failed`, and the payment would stay unknown to us if our endpoint was down for the whole retry window (about 35-70 minutes). Stripe documents the same recovery: list the events whose delivery failed, process them again, guard against duplicates ([Stripe docs](https://docs.stripe.com/webhooks/process-undelivered-events)). Here a worker timer (every 60 seconds) calls the provider's `POST /deliveries/redeliver-failed { maxAgeMs }` (24 hours), which puts failed deliveries of shop events back to `pending` with fresh attempts; run events (cleaned up soon) and events another send already delivered are left alone. Ingress dedupes by event id (steps 3-4) and the webhook job handles a payment after expiry (1), so a repeat is harmless.
- Delivers in any order, because Stripe documents no ordering guarantee.
- Break-it controls: "Duplicate" re-sends the same event id.
- Internal API, called by the storefront and the worker (not public): `charge(orderId, amountMinor, currency)` with `Idempotency-Key: charge-<orderId>`, and `refund(paymentId)` with `Idempotency-Key: refund-<orderId>` (section 6). The `paymentId` comes from the stored `payment.succeeded` event (`payment_events.payload`).

### 5.3 ERP simulator API (worker -> ERP simulator)

The simulator imitates the shape of ERPNext/Frappe's REST API, so a real ERPNext connector can later replace it behind the same connector interface (section 3). It is our own code, not ERPNext.

Facts it copies (official Frappe docs and source):
- Paths `/api/resource/:doctype`, `/api/resource/:doctype/:name`, `/api/method/<path>`; auth header `Authorization: token api_key:api_secret` ([Frappe REST docs](https://docs.frappe.io/framework/user/en/api/rest)).
- Resource responses are wrapped in `data`; method calls return `message`; errors carry `exc_type` and `exc` (same docs).
- List filters `filters=[["field","=","value"]]`, `fields=[...]`, default page length 20 (same docs).
- `docstatus`: 0 = draft, 1 = submitted, 2 = cancelled ([Frappe source](https://github.com/frappe/frappe/blob/develop/frappe/model/docstatus.py)).
- Submit is a whitelisted method `frappe.client.submit(doc)`, POST or PUT ([Frappe source](https://github.com/frappe/frappe/blob/develop/frappe/client.py)).
- A Sales Invoice and a Payment Entry only take effect when **submitted**: a draft Sales Invoice "has no ledger effect" ([ERPNext Sales Invoice](https://docs.frappe.io/erpnext/user/manual/en/sales-invoice)); "a draft does not post to the General Ledger" ([ERPNext Payment Entry](https://docs.frappe.io/erpnext/user/manual/en/payment-entry)). So all three documents are created, then submitted.
- The standard flow is Sales Order -> Delivery Note -> Sales Invoice -> Payment Entry, but a Sales Invoice can be created directly from a submitted Sales Order when no separate delivery transaction is needed ([ERPNext Sales Order](https://docs.frappe.io/erpnext/user/manual/en/sales-order)). The games are demo items with nothing shipped, so we skip the Delivery Note, as plan §3.3 step 4 already does.
- A Payment Entry links the money to invoices or orders through its References table (Payment Entry page above).
- Stock reservation for a Sales Order ([ERPNext Stock Reservation](https://docs.frappe.io/erpnext/user/manual/en/stock-reservation)): it must be enabled in Stock Settings; it is a separate **Reserve** action on the Sales Order, not automatic on submit; it is recorded as **Stock Reservation Entries** against the Sales Order items; Unreserve cancels those entries. The Sales Order page adds that it "does not create a stock-ledger movement" ([ERPNext Sales Order](https://docs.frappe.io/erpnext/user/manual/en/sales-order)). The manual does not say what happens when there is not enough stock, or which REST call the Reserve button uses.

Not copied, our own choices (Frappe documents none of these):
- HTTP status codes for errors, rate limiting (`429` with `Retry-After`), and idempotency. ERPNext documents no idempotency, so the connector does check-then-create (below).
- The reference field `order_ref` (our order id) on every document. In real ERPNext this would be a custom field; to confirm at the real-ERPNext step.

**Calls the `erp-sim` connector makes, per order:**

| Step | Call | Body (main fields) | Response |
|---|---|---|---|
| Check | `GET /api/resource/Sales Order?filters=[["order_ref","=","<orderId>"]]&fields=["name","docstatus"]` | | `{ "data": [ { "name", "docstatus" } ] }` |
| Create SO | `POST /api/resource/Sales Order` | `customer`, `items: [{ item_code, qty, rate }]`, `order_ref` | `{ "data": { "name": "SO-0001", "docstatus": 0 } }` |
| Submit SO | `POST /api/method/frappe.client.submit` | `{ "doc": { "doctype": "Sales Order", "name": "SO-0001" } }` | `{ "message": { "name", "docstatus": 1 } }` |
| Reserve stock | `POST /api/resource/Stock Reservation Entry` (after the same check by `order_ref`) | `voucher_type: "Sales Order"`, `voucher_no: "SO-0001"`, `item_code`, `reserved_qty: 1`, `order_ref` | `{ "data": { "name": "SRE-0001", ... } }`, or `409` with `exc_type: "InsufficientStock"` |
| Create SI | `POST /api/resource/Sales Invoice` (after the same check) | `customer`, `items`, `sales_order`, `order_ref` | `{ "data": { "name": "SINV-0001", "docstatus": 0 } }` |
| Submit SI | `POST /api/method/frappe.client.submit` | `{ "doc": { "doctype": "Sales Invoice", "name": "SINV-0001" } }` | `{ "message": { "name", "docstatus": 1 } }` |
| Create PE | `POST /api/resource/Payment Entry` (after the same check) | `party`, `paid_amount`, `references: [{ "reference_doctype": "Sales Invoice", "reference_name": "SINV-0001" }]`, `order_ref` | `{ "data": { "name": "PE-0001", "docstatus": 0 } }` |
| Submit PE | `POST /api/method/frappe.client.submit` | `{ "doc": { "doctype": "Payment Entry", "name": "PE-0001" } }` | `{ "message": { "name", "docstatus": 1 } }` |

The body field names are approximations of ERPNext's and are not verified against its doctype definitions (the manual pages above use UI labels such as "References", not field names); they are checked when the real ERPNext connector is built.

The simulator is seeded with one Item per game, `item_code` = the `games.id` slug, so `items[].item_code` always refers to an existing item.

The simulator is also seeded with one Customer, "Demo Customer", used as `customer` (Sales Order, Sales Invoice) and as the party (Payment Entry) for every order (owner's decision 2026-10-31). The ERPNext manual describes Customer as "the party placing the order" ([Sales Order](https://docs.frappe.io/erpnext/user/manual/en/sales-order)) and a Payment Entry as having "Party Type and Party" ([Payment Entry](https://docs.frappe.io/erpnext/user/manual/en/payment-entry)). Each order is told apart by `order_ref`, so no email or other personal data is sent to the ERP (visitors are anonymous, plan §3.4; emails are kept only briefly, plan §4.1).

**Stock reservation in the simulator** (plan §3.3 step 4 and §4: "order-to-cash + stock reservation"; owner's decision 2026-10-31):
- The simulator keeps an available quantity per item: for shop orders, seeded from `games.stock_total`; for a demo run, a separate quantity for that run (chosen by the `X-Sim-Run` header, 5.5), seeded from the run's `stock_total`.
- The Reserve step is modelled as creating a Stock Reservation Entry, as the manual records it. The REST shape above (doctype name used as a resource path, field names, the `409 InsufficientStock` error) is our own approximation, because the manual does not document the call; it is checked when the real ERPNext connector is built.
- Creating the entry and lowering the available quantity happen in one simulator transaction, with `UPDATE ... SET available = available - 1 WHERE item = <item> AND available >= 1` (a conditional update, safe under concurrency as in section 2). No row updated means not enough stock: `409 InsufficientStock`.
- A retry after a timeout finds the entry by `order_ref` and does not reserve again, the same check-then-create as the other documents.
- Why it should never fail: a Sales Order is only created for a paid order, and every paid order holds a copy granted by the Redis stock gate, so reservations cannot exceed the stock. If it does fail, it means our system and the ERP disagree: the error is `permanent` (section 7), the order moves to `failed` for admin replay, and the reconciler reports it.
- Reserved units are never released: no flow in this design cancels a submitted Sales Order, and refunded orders never reach the ERP (they are refunded before `paid`, 5.2).
- Simulator-only internal endpoints (not ERPNext-shaped, not public): delete a run's quantities (used by run cleanup, 5.5), and add a restock quantity keyed by receipt id, where a repeated receipt id adds nothing (used by shop restock and the admin refill, 1.2).
- **(2026-11-14, built in Step 5)** The two internal endpoints are `POST /sim/stock-receipts` `{ receiptId, itemCode, qty, runId? }` (without `runId` the shop quantity, with it that run's; reply `{ applied }`; an unknown item is `404`) and `DELETE /sim/runs/:runId`. A run's quantity is added when the run starts, with receipt id `run-<runId>` (a retry adds nothing), so the simulator needs no knowledge of our database. Both routes still need the API key (one of them deletes data) but skip the fault settings: they are our own wiring, not the simulated ERP. Connector actions: `stock.add`, `run.delete`.
- **(2026-11-14, built in Step 5)** Faults are read from Redis: `faults:<runId>` for calls with `X-Sim-Run`, `faults:shared` for calls without it (shop orders). Order of effects: latency, then `down` (`503`), then rate limit (`429` with `Retry-After: 1`), then failure rate (`500`). `GET /health` answers `503` only while the shared `down` is set. If Redis cannot be read the simulator carries on without faults. The setter `PUT /admin/erp-sim/faults` (5.4) comes with the admin API.

Each step: check by `order_ref` first, create only if missing, submit only if `docstatus` is 0. A retry after a timeout therefore finds the document already there instead of creating a second one. The result is saved in `erp_documents`, whose `UNIQUE (order_id, doctype)` is the last guard.

**One fulfilment job per order:** check-then-create is not atomic, so two jobs running for the same order at the same time could both create. To prevent that, the webhook job (5.2) does not call the ERP itself: after moving the order to `paid` it enqueues a fulfilment job with `jobId = "fulfil-<orderId>"`. A second webhook for the same order adds the same job id, which BullMQ ignores while the first still exists ([BullMQ docs](https://docs.bullmq.io/guide/jobs/job-ids)). So only one job per order talks to the ERP.

**Hand-off to email:** after the Payment Entry is submitted, the fulfilment job moves the order `invoiced -> completed` and then enqueues the email job with `jobId = "email-<orderId>"`, but only if the order has a `buyer_email` or is a simulated rush order (`emailStatus = none` otherwise, 5.1). Simulated rush orders always get `email_channel = mock` and never use the real-email quota; the visitor's orders go through the real-email cap (5.1). It enqueues **whether or not that state update applied**, the same pattern as the webhook ingress (5.2 step 4): if the process crashed after the update but before the enqueue, the retried fulfilment job finds the order already `completed` and still enqueues the email job, which BullMQ ignores if it already exists.

**Simulator storage:** its own tables in a separate PostgreSQL schema (`erpsim`), so it behaves like an outside system: our code never reads them directly, only through the API.

**Break-it controls (admin and demo page):**
- `ERP slow`: adds latency to every call.
- `ERP down`: every call returns `503`.
- Rate limit: returns `429` with `Retry-After` above N calls per second.
- Random failure rate: a share of calls return `500`.

### 5.4 Admin API (owner only)

The admin page is served by the backend itself (its own origin), so its cookie is first-party and the third-party cookie problem from 5.1 does not apply.

**Login:**
- One owner account. The password is never stored: an env var holds its scrypt hash and salt (`crypto.scrypt`, built into Node, [docs](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)). Comparison with `crypto.timingSafeEqual`.
- Success creates a random admin session id, stored server-side with an expiry, sent as a cookie with `HttpOnly; Secure; SameSite=Strict; Path=/admin`: not readable by JavaScript, sent only over HTTPS, sent only on requests from the same site ([MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)). `Path` only limits where the cookie is sent; MDN notes it is not a security measure.
- Every state-changing admin call (POST/PUT) also checks that the `Origin` header is the backend's own origin, as a second guard against cross-site requests. Browsers add `Origin` to same-origin POST and PUT requests ([MDN Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin)); a missing or `null` value is rejected.
- Login attempts are rate-limited per IP. **(2026-11-15, built in Step 8.1)** 5 attempts per minute per IP, counted by the same Redis limiter as 5.1 (a wrong or a right password both count; `429 rate_limited` with `Retry-After`).
- **(2026-11-15, built in Step 8.1)** How it is built: `ADMIN_PASSWORD_HASH` and `ADMIN_PASSWORD_SALT` (hex; `npm run admin-hash` asks for the password without echo and prints both) hold the scrypt hash (N = 2^17, r = 8, p = 1, 64 bytes: OWASP's minimum for scrypt, [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); `maxmem` raised to 256 MiB because Node refuses a cost above it, default 32 MiB, [Node docs](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)). The login body is `{ "password": "<text>" }`; a wrong, missing or non-string password is `401 bad_credentials`. The admin session is a Redis key `admin:session:<id>` (32 random bytes, base64url; OWASP asks for at least 64 bits of entropy, [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)) that expires 8 hours after login (an absolute timeout, no extension; OWASP names 4 to 8 hours for an app used all day, same page); the cookie's `Max-Age` is the same 8 hours. "The backend's own origin" is `ADMIN_ORIGIN` (default `http://API_HOST:PORT`; set it when the public address differs, e.g. behind a proxy at hosting). Every request that is not GET, HEAD or OPTIONS, login and logout included, must carry exactly that `Origin`, else `403 bad_origin`. Without a valid session: `401 admin_required`. The `/admin` routes are served only when the two hash variables are set; otherwise they answer the normal `404 not_found`, and the API's `api listening` log line says `admin: false`. No CORS headers are sent on `/admin` (only the admin page, on the backend's own origin, calls it), and every API reply carries `Cache-Control: no-store` (the page files do not: they are static and revalidated). A request body that cannot be parsed is `400 invalid_input` with a fixed message, not the parser's, which quotes part of the body (a typed password). If Redis cannot be reached, login and the session check answer `500 internal_error`, while health, faults and the kill switch answer `503 unavailable`. Behind a proxy, Express `trust proxy` must be set or all callers share one login limit (5.1 conventions).

| Method and path | Purpose | Success | Errors |
|---|---|---|---|
| `POST /admin/login` | Log in | `204` + session cookie | `401 bad_credentials`, `429 rate_limited` |
| `POST /admin/logout` | Log out | `204` | |
| `GET /admin/health` | Connector health, circuit breaker states, queue depth, failed count | `200 { "connectors": [...], "queues": {...} }` | |
| `GET /admin/deliveries?status=failed` | List failed deliveries with last error | `200 { "deliveries": [...] }` | |
| `POST /admin/deliveries/:id/replay` | Re-enqueue a failed delivery with fresh attempts | `202` | `404 not_found`, `409 invalid_state` (not failed) |
| `POST /admin/stock/reset` | Refill shop stock up to its starting level, based on the stock at the moment of the click (1.2): body `{ "gameId": "<optional; all shop games if omitted>" }`. Runs the admin refill in 1.2 (one restock receipt per game). Cancels no orders and clears no waitlist. Demo runs are not affected (they have their own stock, 5.5) | `202` | `400 invalid_input` |
| `PUT /admin/rush` | Kill switch: `{ "enabled": false }` stops all rush runs | `204` | |
| `PUT /admin/erp-sim/faults` | Set ERP faults: `{ "latencyMs", "down", "rateLimitPerSec", "failureRate" }` | `204` | `400 invalid_input` |
| `GET /admin/gmail/connect` | Start Google OAuth (scope `gmail.send`) | `302` to Google | |
| `GET /admin/gmail/callback` | Finish OAuth, store the refresh token encrypted | `302` back to the admin page | `400 oauth_error` |

All routes except `POST /admin/login` return `401` without a valid admin session.

**(2026-11-15, built in Step 8.1)** Details the table leaves open:
- `GET /admin/health`: `connectors` is one entry per connector `{ id, healthy, breaker }` (`payment-mock`, `erp-sim`, `email-gmail`, `email-mock`): `healthy` is the connector's `healthCheck()` run from the API process (the Gmail one asks Google for a fresh access token, so each call is one request to Google), `breaker` is the shared circuit breaker's state as the worker reports it in the Redis hash `breakers` (8.3), `closed` when the worker has reported none (a breaker that never opened has no entry). `queues` is `{ webhooks, fulfilment, email, runs }`, each `{ waiting, active, delayed, failed }` from BullMQ's `getJobCounts` ([docs](https://docs.bullmq.io/guide/jobs/getters; the installed 6.3.19 accepts `waiting` and the test reads the key back)); queue depth is waiting + delayed, and the "failed count" is BullMQ's failed set. Deliveries that failed for good are listed by the next route.
- `GET /admin/deliveries`: only `status=failed` (or no `status`) is supported; any other value is `400 invalid_input`. Each item is `{ id, orderId, connector, action, attempts, lastError }`.
- `POST /admin/deliveries/:id/replay` is the replay of section 6 (`202`, `404 not_found`, `409 invalid_state`; a malformed id is `404`).
- `POST /admin/stock/reset` replies `202 { "refilled": [ { "gameId", "qty" } ] }`, listing what the refill added (empty when every game is at its starting level). It runs synchronously. If the ERP simulator cannot be reached, the reply is `500 internal_error`: the receipt was recorded before the ERP call (1.2 step 1), Redis is untouched, and the worker's restock timer finishes the receipt once the ERP is back (1.2, crash safety); clicking again before that records a second receipt, so the stock can end above its starting level, which 1.2 already accepts.
- `PUT /admin/rush` needs `enabled` to be `true` or `false` (else `400 invalid_input`). Switching it off also stops every running demo run (5.5).
- `PUT /admin/erp-sim/faults` sets the faults for shop orders (the simulator's `faults:shared`, 5.3); fields left out are off, so `{}` clears them; values are checked like the faults of a run (5.5).
- The two Gmail routes are still not built (Step 7 note below): the local script does the job, and the routes would need an encrypted token store and the OAuth callback.
- **(2026-11-16, built in Step 8.2)** The page: a React + TypeScript + Vite app in `launch-rush/admin/` (own `package.json`), built to `admin/dist` and served by the backend at `/admin/` (`config.admin.pageDir`, Express static) with a Content-Security-Policy that allows only its own origin (images also `data:`) and forbids framing (`frame-ancestors 'none'`) ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)). It calls the routes above on the same origin. Added for it: `GET /admin/scoreboard` replies `200 { "scoreboard": { ... } | null }` (the reconciler's latest shop result, `null` before its first pass), and `GET /admin/health` also carries `rushEnabled` (boolean) and `erpFaults` (`{ latencyMs, down, rateLimitPerSec, failureRate }`, the shared faults, all off when none are set). Chrome stores and sends the `Secure` cookie when the page is opened at `http://127.0.0.1` (tested).
- **(2026-11-16, Step 8.2)** The two Gmail routes are final: not built, and the page has no Connect Gmail button. The Gmail token belongs to the project's own sender account, so `npm run gmail-connect` stays the way to connect or reconnect.

The Gmail routes are only the contract here. Token encryption and the OAuth consent setup are designed at the Gmail step (roadmap step 7), where the details are verified against Google's docs. The sending caps are decided now (5.1 real-email cap). **(2026-11-15, built in Step 7)** The two Gmail routes are not built: they need this admin login, which has no roadmap Step, and an open connect route would let anyone link their own mailbox as the sender. Gmail is connected with a local script instead, `npm run gmail-connect` (authorization code flow with a loopback redirect, `state` and PKCE, as Google documents for desktop apps; scope `gmail.send`), which prints the refresh token; the owner puts it in the env var `GMAIL_REFRESH_TOKEN` (no encryption beyond the env, like every other secret). Reconnecting = run the script, change the env var, restart the worker.

### 5.5 Public demo controls (visitor page: Break it / Rush)

Every Break it or Rush action happens inside a **demo run**: a sandbox owned by the visitor's session. A run uses the same code paths as the real shop (Lua stock gate, webhook ingress, queue, ERP simulator, email connector) but never touches shared state, so one visitor cannot break the demo for others. The visitor's shop Buy (5.1, without `runId`) is unaffected; with `runId` the visitor's own order joins the run and competes for its stock (5.1).

What a run owns:
- **Its own stock pool** in Redis (`stock:run:<runId>`). The Lua stock script already receives its key names as parameters (Redis requires all keys via `KEYS`, [docs](https://redis.io/docs/latest/develop/programmability/eval-intro/)), so the same script serves the shop pool and run pools.
- **Its own fault settings** in Redis (`faults:<runId>`). The `erp-sim` connector sends `X-Sim-Run: <runId>` on calls for run orders, and the simulator applies that run's faults. This header is a simulator-only test hook; a real ERP connector never sends it.
- **Its own circuit breaker instance**, created when the run starts and ~~discarded at the run's cleanup (not when the run ends, because run orders that were already paid keep going through the ERP after the end)~~, so a run's "ERP down" trips only its own breaker. **(2026-11-15, built in Step 6)** Not discarded when the run ends, because run orders that were already paid keep going through the ERP after the end. Each process (API, worker) keeps its own instance and drops it once nobody has used it for `breaker.runIdleMs` (10 minutes), which also covers the cleanup; there is no cross-process call to discard it.
- **Its own orders**: `orders.run_id` set and a `buyer_ref` on each; simulated buyers' orders have `is_simulated = true`, the visitor's own order (if they join) has `is_simulated = false`.
- **Its own waitlist** (1.1). When the run ends, its `waitlisted` orders move to `waitlist_ended`.

**One copy per buyer in a rush:** the Lua script records each `buyer_ref` in a Redis set for the run pool and refuses a second reservation for the same buyer, atomically with the stock check. **(2026-11-14)** Implemented as a Redis hash `buyer_ref -> order id` instead of a plain set: the `409 already_reserved` body needs the existing `orderId` (5.1, section 6), and Release removes the entry when the order gives up its place (1.1). Some simulated buyers deliberately click twice, to show this working.

**Simulated buyers** (owner's decision 2026-11-02): so a run shows what plan §3.2 asks a rush to handle (expired holds, item 3; paid after sold out, item 4; double clicks and repeated webhooks, item 5).
- A **run driver** inside the backend acts for the simulated buyers. It calls the same Buy and Pay logic as the API (Lua stock script, PostgreSQL, queue) but not the public HTTP layer, so the per-session rate limits (5.1) do not apply to it.
- All simulated buyers arrive within the first 10 seconds of the run.
- Each simulated buyer gets one behaviour at random. It starts when the buyer gets a copy: at Buy, or when promoted from the waitlist (1.1).

| Behaviour | Share | Shows |
|---|---|---|
| Pays within the hold | 70% | Normal flow |
| Never pays | 15% | Hold expires; the copy goes to the next waiter (1.1) |
| Pays after the hold expired | 10% | Late-payment re-reserve, or refund when no copy is left (5.2) |
| Clicks Buy twice, then pays within the hold | 5% | Second click refused (`already_reserved`) |

- The mock provider re-sends about 5% of the run's payment webhooks with the same event id, to show duplicates blocked (5.2).
- Shares are configurable starting values, not measurements. They are approximate in practice: a "late" payment that arrives before the sweeper's next pass (section 1, every 5 seconds) is processed as an on-time payment. The page shows the counts that actually happened (`run.progress`, section 8), not the shares.

**Endpoints** (all need `X-Session-Id`; a run is visible only to its session, `404` otherwise):

| Method and path | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/runs` | Start a run | `201 { "runId", "endsAt" }` | `409 run_active` (one per session), `503 runs_busy` (global cap), `503 rush_disabled` (kill switch), `404 unknown_game`, `400 invalid_input` |
| `GET /api/runs/:id` | Run summary: sold, stock, refunds, duplicates blocked, invariant checks | `200 { ... }` | `404 not_found` |
| `PUT /api/runs/:id/faults` | Change faults during the run | `204` | `404`, `409 run_ended`, `400 invalid_input` |
| `POST /api/runs/:id/stop` | Stop early | `204` | `404` |
| `POST /api/orders/:id/resend-webhook` | "Duplicate": resend the same payment event (same event id) for one of the session's own orders, shop or run | `202` | `404`, `409 invalid_state` (no payment yet) |

`POST /api/runs` body: `{ "gameId": "<games.id>", "buyers": <int>, "stock": <int>, "faults": { "latencyMs", "down", "rateLimitPerSec", "failureRate" } }`. Buyers above stock is the point: it shows sold-out handling and refunds. ~~Every run sells the fictional launch game "Ironvale Ascent" (plan §3.2, §14), stored as `demo_runs.game_id`~~ **(owner's decision 2026-11-03)** The visitor picks the run's game: any game listed by `GET /api/games` (5.1; unknown id: `404 unknown_game`), stored as `demo_runs.game_id`. The run sells it from its own stock pool and its own ERP quantity (above, 5.3), so shop stock of the same game is never touched. A Buy with `runId` (5.1) must use that game (`400 invalid_input` otherwise).

**Caps (starting values, configurable, tuned at the load step; not measured yet):**
- One active run per session (partial unique index on `demo_runs (session_id) WHERE status = 'running'`).
- `buyers` at most 500, `stock` at most `buyers`; a run ends after at most 5 minutes.
- At most 3 runs at once across all visitors.
- The admin kill switch (`PUT /admin/rush`) stops all runs and blocks new ones.
- Simulated rush buyers never send real email: `email_channel = mock` always. The visitor's own run order is a real order and goes through the real-email cap (5.1).

**Cleanup:** a job deletes finished runs and their orders after a few hours, and deletes the run's quantities in the ERP simulator (5.3), so simulated data does not grow without limit. **(2026-11-14, built in Step 5)** The run's ERP quantity is added when the run starts (receipt id `run-<runId>`; if that call fails the run ends as `stopped` and the visitor gets `503 unavailable`, like a Redis failure). Cleanup deletes the run's ERP data first, one run at a time: a run whose ERP data cannot be deleted now is left for the next pass, so nothing is orphaned in the ERP.

**Honesty:** run results are labelled "Simulated run" on the page. They are not a throughput claim. Runs use a 30-second hold instead of the shop's 5 minutes (5.1), so the page also labels runs "accelerated" (plan §9: the simulated tier is an "accelerated model").

---

## 6. Idempotency keys

Delivery is at-least-once everywhere (browser retries, provider retries, BullMQ retries), so every boundary needs a key that makes a repeat harmless. This section collects them in one place. Key format rule: keys that become BullMQ job ids have a non-digit prefix and no colon ([BullMQ docs](https://docs.bullmq.io/guide/jobs/job-ids)).

| Boundary | Repeat that can happen | Key | Mechanism |
|---|---|---|---|
| Buy (shop) | Double-click, network retry | `(session_id, game_id)` while `waitlisted`, `reserved` or `payment_pending` | Partial unique index (5.1). The `409 already_reserved` body includes the existing `orderId` and `state`, so a retried Buy resumes the same order instead of failing. |
| Buy (rush run) | Buyer (simulated or the visitor) clicks twice | `(runId, buyer_ref)` | Redis set inside the Lua script (5.5) |
| Waitlist join | Buy script retried for the same order | order id as the sorted-set member | `ZADD NX` adds only new members ([docs](https://redis.io/docs/latest/commands/zadd/)) |
| Waitlist promotion / wait end | Both at once for one order | `orderId` + expected state `waitlisted` | Conditional update; the loser changes 0 rows and the copy is handed on (1.1) |
| Start payment | Double-click, network retry, failed provider call | `orderId` | Conditional update `reserved -> payment_pending` (section 2). A repeat while `payment_pending` re-sends the charge with the same `Idempotency-Key` (next row) and gets `202`, so a failed first call can be retried without a double charge (5.1). A repeat in any later state gets `409 invalid_state` with the current state in the body. |
| Charge at mock provider | Our call retried after a timeout | `Idempotency-Key: charge-<orderId>` | Mock provider returns the same payment for the same key. Header name and the 255-character limit copy Stripe ([docs](https://docs.stripe.com/api/idempotent_requests)). |
| Refund at mock provider | Worker retry | `Idempotency-Key: refund-<orderId>` | Same as charge. The `refund_pending` state is recorded before the call, so a retry only finishes the refund and never re-runs the stock script (5.2) |
| Webhook received | Provider retry, "Duplicate" button | provider event id | `payment_events` primary key + BullMQ `jobId = event id` (5.2) |
| Fulfilment | Two webhooks for one order | `fulfil-<orderId>` | BullMQ job id (5.3) |
| ERP documents | Retry after timeout | `order_ref` + doctype | Check-then-create (5.3) + `erp_documents UNIQUE (order_id, doctype)` |
| Email job | Fulfilment job retried after the hand-off | `email-<orderId>` | BullMQ job id (5.3) |
| Email channel / quota | Email job retried | order id in the quota sets; `email_channel IS NULL` | Lua script counts an order once; conditional update keeps the first decision (5.1 real-email cap) |
| Email send | Email job retried | `(order_id, 'email.send')` | `deliveries UNIQUE (order_id, action)`; skip if already `succeeded` |
| Shop restock / admin refill | Two job instances at once, or a retried tick | `dedupe_key`; receipt id | Unique `dedupe_key` on `stock_receipts`; ERP add and Redis add both keyed by receipt id (1.2) |
| Reservation expiry | Two sweeper runs | `orderId` + expected state | Conditional update; only the winner runs Release, so the copy is passed on once (section 1, 1.1) |
| Late-payment re-reserve | Webhook job retried for an order in `reservation_expired` | order id | The Lua stock script records the reservation by order id, so a second run finds it and takes no second copy (section 1) |
| Release | Run twice for the same order (sweeper retry, or compensation after a failed insert) | order id | The second call finds no reservation record, so it only does `ZREM`, which ignores a missing member ([docs](https://redis.io/docs/latest/commands/zrem/)), and passes no copy on (1.1) |

**Email is the one honest exception.** Gmail's `users.messages.send` takes no idempotency key or request id ([Gmail API reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)). If Gmail accepts the message and the worker crashes before recording `succeeded`, the retry sends a second email. This window is small and cannot be closed without Gmail support, so the design accepts it: **email is at-least-once, a rare duplicate is possible**, and the README says so. Money and invoices have no such gap.

**Admin replay:** a failed job still in BullMQ's failed set is retried with `job.retry('failed', { resetAttemptsMade: true })`, which moves it back to waiting with a full retry allowance; without the reset it would fail immediately. **(2026-11-15)** With `maxStartedAttempts` (section 7) the call also needs `resetAttemptsStarted: true`, or the job fails again at once ('job started more than allowable limit', tested) ([BullMQ docs](https://docs.bullmq.io/guide/jobs/retrying-job)). If the failed job was already removed (bounded `removeOnFail`), replay adds a new job with the same job id, which BullMQ allows once the old one is gone. Either way the keys above make the replay safe.

---

## 7. Error taxonomy

Every error from a connector is turned into one of three classes by `classifyError` (section 3). The worker only looks at the class.

| Class | Worker action | BullMQ mechanism |
|---|---|---|
| `retryable` | Retry later with exponential backoff and jitter | Throw a normal error; job `attempts` + `backoff: { type: 'exponential', delay, jitter }`; delay is `2^(attempts-1) * delay` ([docs](https://docs.bullmq.io/guide/retrying-failing-jobs)) |
| `rateLimited(retryAfterMs)` | Wait the time the upstream asked for, without using up an attempt | `job.moveToDelayed(Date.now() + retryAfterMs, token)` then `throw new DelayedError()`; this does not increment `attemptsMade` ([docs](https://docs.bullmq.io/patterns/process-step-jobs)) |
| `permanent` | Stop now, mark the delivery `failed` with the error, wait for admin replay | `throw new UnrecoverableError(...)`: moved to failed with no retries ([docs](https://docs.bullmq.io/patterns/stop-retrying-jobs)) |

**Why not BullMQ's queue rate limiter for 429s:** that limiter is queue-wide ([docs](https://docs.bullmq.io/guide/rate-limiting)). A 429 caused by one demo run's fault settings (5.5) would pause every order's job. Delaying only the affected job keeps runs isolated. To stop a job that is rate-limited forever, `maxStartedAttempts` caps how many times it may start (same docs as the delayed pattern). **(2026-11-15)** Starting value 50, a worker option; the job then fails with an UnrecoverableError without running again, and waits for replay.

**Starting values (configurable, not tuned yet):** `attempts: 5`, base `delay: 1000` ms, jitter on. The first retry is at least 1 second after the error, matching Google's backoff advice ([Gmail docs](https://developers.google.com/workspace/gmail/api/guides/handle-errors)). **(2026-11-05, owner's decision)** Base `delay` is **2000 ms** with `jitter: 0.5`: BullMQ's source (`backoffs.js`, v6.3.19) picks a delay between `max × (1 − jitter)` and `max`, with `max = 2^(attempts−1) × delay`, so with 1000 ms the first retry could come after 500 ms (measured 500–999 ms). With 2000 ms and 0.5, retries come after 1–2, 2–4, 4–8 and 8–16 s (measured), so "at least 1 second" holds with jitter on.

**Mapping per error source:**

| Source and error | Class | Note |
|---|---|---|
| Network error, connection reset, our timeout | `retryable` | |
| HTTP 500, 502, 503, 504 (ERP sim, mock payment, Gmail) | `retryable` | Gmail advises backoff for 5xx (Gmail docs) |
| HTTP 429 with `Retry-After` | `rateLimited` | Header value used; if missing, fall back to `retryable` |
| Gmail 403 `userRateLimitExceeded` / `rateLimitExceeded`, Gmail 429 | `rateLimited` (no header: `retryable`) | Gmail docs: retry with exponential backoff |
| Gmail 403 `dailyLimitExceeded` | `permanent` | Project quota; retrying does not help |
| Gmail 401 after the client library's token refresh fails (e.g. token revoked) | `permanent`, code `gmail_reauth_required` | Owner reconnects Gmail from the admin page (plan §5.1). **(2026-11-15, Step 7)** No client library: the connector renews the access token itself once on a 401; a refused refresh (`invalid_grant`, `invalid_client`, `unauthorized_client`), a second 401, or no refresh token at all is this error, and the owner reconnects with `npm run gmail-connect` (5.4 note) |
| HTTP 400, 404, 409 from ERP sim (409 includes `InsufficientStock`, 5.3); Gmail 400 `badRequest` | `permanent` | Bad data, a bug, or our system and the ERP disagreeing: retrying gives the same result |
| ERP sim 401/403 (wrong API key) | `permanent` | Configuration problem |
| **(2026-11-14)** Mock payment provider 4xx other than 408 and 429 (it sends 400 `invalid_request`, 401 `unauthorized`, 404 `payment_not_found`/`not_found`, 409 `idempotency_conflict`/`already_refunded`) | `permanent` | The request itself is wrong ("the client seems to have erred", [RFC 9110 §15.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5)), so a retry fails the same way. 408 stays `retryable` (RFC 9110 §15.5.9: the client "MAY repeat that request"; Google Cloud retries 408, 429 and 5xx, [retry strategy](https://cloud.google.com/storage/docs/retry-strategy)) |
| Circuit breaker open (`err.code === 'EOPENBREAKER'`) | `rateLimited(resetTimeout)` | The job waits until the breaker may half-open, without using an attempt. Checked by code, not only `CircuitBreaker.isOurError(err)`, because that is also true for the breaker's own timeout error (`ETIMEDOUT`), which is `retryable` (section 3; [opossum source](https://github.com/nodeshift/opossum/blob/main/lib/circuit.js)) |
| Our own PostgreSQL or Redis unavailable | `retryable` | |
| Anything unrecognised | `retryable` | Ends in `failed` after the attempts run out, so nothing is silently lost |

**Circuit breaker (opossum) settings:** defaults are `timeout` 10 s, `errorThresholdPercentage` 50, `resetTimeout` 30 s, `volumeThreshold` 0 ([opossum docs](https://nodeshift.dev/opossum/)). We set a `volumeThreshold` above 0 so one failed call cannot open the breaker, and an `errorFilter` that returns true for `permanent` errors, so bad-data errors do not count as the upstream being down (`errorFilter`: a truthy result means the failure is not counted, same docs). **(2026-11-15, built in Step 6)** Values: `timeout` 10 s, `errorThresholdPercentage` 50, `resetTimeout` 30 s, `volumeThreshold` 5, rolling window 10 s (all configurable starting values, not tuned).

**After the final failure:** the delivery row gets `status = failed` and `last_error`, and the admin page lists it for replay (section 6). For an ERP or refund step, the order also moves to `failed` (section 2) and an `order.state` event is sent. For the email job, the order stays `completed`; only `emailStatus` becomes `failed`, sent as an `email.status` event (section 8). So the Gmail errors in the table above (daily limit, reauth required) never fail an order.

**(2026-11-15, built in Step 6) Recovery.** The final-failure handling can itself fail (PostgreSQL unreachable at that moment, which also burns the retries of every job), and a job can be lost. A timer (every 30 s) finds orders that have been in `paid`, `so_submitted`, `invoiced` or `refund_pending` for more than a minute and looks at their queue job: if it is `failed`, it runs the final-failure handling now (order to `failed`, delivery `failed` with the job's last error); if there is no job, it adds it again (the job ids in section 6 make that safe). A job that is waiting, delayed or active is left alone.

---

## 8. SSE events (backend -> browser)

One stream per browser tab carries everything the page animates: the visitor's orders, their demo run, stock and the scoreboard. One stream, not one per order, because browsers allow only 6 connections per browser and domain over HTTP/1.1 (about 100 streams over HTTP/2) ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)).

### 8.1 Endpoint

`GET /api/stream?session=<sessionId>`

- The session id is a query parameter because `EventSource` takes only a URL and a `withCredentials` option, no headers ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource)). The error log lines for this route omit the query string (there is no access log), so session ids are not written to logs.
- Cross-origin: the page opens it with `withCredentials` false (no cookies are used), which is the spec's anonymous CORS mode ([HTML spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)). It is a plain GET with no custom headers, so there is no preflight; the response only needs `Access-Control-Allow-Origin: <portfolio origin>` ([MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)).
- Response headers: `Content-Type: text/event-stream` (required), plus `Cache-Control: no-cache` and `X-Accel-Buffering: no` as in MDN's server example. Express then calls `res.flushHeaders()` so the headers go out before the first event, instead of Node buffering them until the first body chunk ([Node docs](https://nodejs.org/docs/latest-v24.x/api/http.html)).
- Unknown session: reply `401`. Per the spec, any status other than 200 fails the connection and the browser does not reconnect; the page then creates a new session and opens a new stream.
- Cleanup: on the response's `close` event (connection finished or dropped, Node docs above) the server drops that client's subscriptions.

### 8.2 Wire format

Each event uses the standard fields ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)):

```
event: order.state
data: {"orderId":"...","from":"invoiced","to":"completed","at":"2026-10-30T10:15:02Z"}

```

Events carry no `id` field: resume does not use `Last-Event-ID` (8.5).

- First message: `retry: 3000`, so the browser waits 3 s before reconnecting.
- Every 15 s a comment line (`: ping`) keeps idle connections from timing out (MDN: a line starting with a colon is a comment, usable as keep-alive).

### 8.3 Events

"The session's own orders" below means its **non-simulated** orders: shop orders, and the visitor's own order in their demo run (5.1). Simulated buyers' orders are shown only through `run.progress`.

| Event | When | `data` |
|---|---|---|
| `order.state` | Any state change of one of the session's own orders | `orderId`, `from`, `to`, `at`, plus `invoiceNo` when set |
| `email.status` | The `emailStatus` of one of the session's own orders changed (5.1) | `orderId`, `emailStatus` |
| `waitlist.position` | The waitlist position of one of the session's own waitlisted orders changed (1.1) | `orderId`, `waitlistPosition` |
| `delivery.retrying` | A step of one of the session's own orders failed and will retry | `orderId`, `connector`, `action`, `attempt`, `errorClass`, `nextRetryAt` |
| `breaker.state` | A circuit breaker relevant to the session (shared, or its own run's) changes | `connector`, `runId` (null if shared), `state`: `open` / `halfOpen` / `closed` |
| `run.progress` | During the session's demo run, at most every 500 ms | `runId`, `reserved`, `waitlisted`, `paid`, `invoiced`, `refunded`, `expired`, `waitlistEnded`, `failed`, `duplicatesBlocked`, `soldOut`, `stockLeft` |
| `run.ended` | Run finished, stopped or timed out | `runId`, `status`, final counters, invariant results |
| `stock` | Shop stock changed | `gameId`, `stockLeft` |
| `scoreboard` | Reconciler produced a new result | `sold`, `stock`, `oversold`, `lost`, `paidNotInvoicedOrRefunded`, `duplicatesBlocked`, `checkedAt` |

- `breaker.state` comes from opossum's `open`, `halfOpen` and `close` events ([opossum docs](https://nodeshift.dev/opossum/)).
- Simulated buyers' orders do not get one `order.state` each: a 500-buyer run would flood the browser. Their progress is the `run.progress` snapshot, ~~built from per-run counters the worker increments in Redis~~ built from PostgreSQL (note below).
- **(2026-11-15, built in Step 8; supersedes "per-run counters the worker increments in Redis" above)** `run.progress` is computed from PostgreSQL by the reconciler's `runSummary` (cached per run for 500 ms), not from Redis counters: PostgreSQL is the source of truth and the counters would have to be kept in step with every transition. Definitions: `paid` = copies sold (orders that ever reached `paid`), `invoiced` = orders in `invoiced` or `completed`, `soldOut` = `stockLeft` is 0, `stockLeft` is the run stock left in Redis. One more field, `inFlight` = orders of the run not yet finished (`reserved`, `payment_pending`, `waitlisted`, `paid`, `so_submitted`, `invoiced`, `refund_pending`).
- **(2026-11-15, built in Step 8)** `run.ended` carries the `run.progress` fields plus the final counters and invariant results, and is sent when `inFlight` is 0, or 60 s (`stream.settleMs`) after the stream first saw the run ended, whichever comes first: a stopped run still has orders being processed, and the page should not show "ended" before they settle. `scoreboard` sends the reconciler's stored result as it is, so it also holds `completedWithoutInvoice` and `stockMismatches` (the table lists the main fields). `delivery.retrying.nextRetryAt` is set only for a rate-limited failure and is null otherwise (see 4). `breaker.state` is reported only for the worker's breakers (the API process has none that matter to the page): the worker writes the state to the Redis hash `breakers` (field `connector:runId` or `connector:shared`), the stream reads it, and the worker clears the hash at start. A stream follows at most 50 of the session's orders and a session may hold 3 streams (`429 rate_limited` with `Retry-After` beyond that).

### 8.4 Getting events from the worker to the stream

The worker and the API can be different processes, so events travel through Redis Pub/Sub. Pub/Sub is at-most-once: a message is lost if the subscriber is disconnected or fails ([Redis docs](https://redis.io/docs/latest/develop/pubsub/)). So Pub/Sub carries only a **wake-up signal**, never the data itself:

1. The worker commits the state change (and its `order_transitions` row) in PostgreSQL, then publishes `order:<orderId>` on Pub/Sub.
2. The stream handler, on a wake-up for one of its session's own orders, reads that order's `order_transitions` rows with `id` greater than the last one it sent **for that order**, and sends them. The handler keeps one "last sent id" per order, because ids follow commit order only within one order, not across orders (section 4); a single cursor across orders could skip a row for good.
3. A 2-second timer per stream does the same read, so a lost wake-up only delays an update; it never loses it.

Snapshots (`run.progress`, `stock`, `scoreboard`) are read from Redis (~~the run and stock counters~~ the stock counter (`run.progress` comes from PostgreSQL, 8.3 note), and the reconciler's latest result, which the reconciler computes from PostgreSQL and keeps in Redis, section 1) and replace the previous value, so a missed one is corrected by the next.

`email.status` is not a state transition, so it has no `order_transitions` row. The email job publishes the same `order:<orderId>` wake-up after updating its delivery row; on each wake-up and each 2-second tick the handler also reads the `emailStatus` of the session's orders (5.1) and sends `email.status` only when it differs from the value it last sent. `waitlist.position` works the same way: on each tick the handler reads `ZRANK` for the session's waitlisted orders (O(log N), [docs](https://redis.io/docs/latest/commands/zrank/)) and sends it only when it changed. A lost wake-up therefore only delays it, the same as `order.state`.

The API process uses one dedicated Redis connection for subscribing, because a subscribed connection may only issue subscribe-related commands under RESP2 (Redis docs above).

**(2026-11-15, built in Step 8)** How it is built: the database layer takes an `onOrderChange(orderId, sessionId)` hook, called after every committed order insert, transition and delivery change; the API and the worker wire it to `redis.notifyOrder`, which does `PUBLISH order:<orderId>` and never throws (best effort, [PUBLISH](https://redis.io/docs/latest/commands/publish/)). The message of a new order carries its session id, so a stream learns of an order bought in another tab or process within one wake-up instead of waiting for the 2-second tick. The API holds one subscriber connection that does `PSUBSCRIBE order:*` ([PSUBSCRIBE](https://redis.io/docs/latest/commands/psubscribe/)) and receives `pmessage` events ([ioredis](https://github.com/redis/ioredis#pubsub)); ioredis subscribes again by itself after a reconnect (tested by cutting the connection).

### 8.5 Reconnect and resume

When the connection drops, the browser reconnects after the `retry` time. Events carry no `id`, so the browser sends no `Last-Event-ID` (it does so only when its last event id is not empty, [HTML spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)); a single id could not hold one position per order anyway (8.4). On every new connection the handler sends, for each of the session's own orders, its current state (as an `order.state` event from its latest transition), its `email.status` and, if waitlisted, its `waitlist.position`, then fresh snapshots. It then starts its per-order "last sent id" from those latest transitions. After a reconnect the page may skip steps it missed, but it always shows the current state; nothing the page shows depends on a single message arriving.
