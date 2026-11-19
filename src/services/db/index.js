// The ONE repository module: all SQL lives here. Connection settings: PG* env vars, read by pg itself.
import pg from 'pg';

// onOrderChange(orderId, sessionId?): called after an order or one of its deliveries changed, so open streams can
// read it (design §8.4); a new order also passes its session. It must not throw or reject; the default does nothing.
export function createDb({ logger, onOrderChange = () => {} }) {
  const pool = new pg.Pool();
  // Without a listener, an idle client's error would crash the process (node-postgres pool docs).
  pool.on('error', (err) => logger.error({ err }, 'postgres idle client error'));

  return {
    // Design §5.2 step 3. Returns true if the event is new, false if it was already stored (duplicate delivery).
    async insertPaymentEvent(event) {
      const { rowCount } = await pool.query(
        `INSERT INTO payment_events (event_id, order_id, type, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.id, event.data.orderId, event.type, event],
      );
      return rowCount === 1;
    },

    async createSession() {
      const { rows } = await pool.query('INSERT INTO sessions DEFAULT VALUES RETURNING id');
      return rows[0].id;
    },
    async sessionExists(id) {
      const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [id]);
      return rowCount === 1;
    },

    async listShopGames() {
      const { rows } = await pool.query(`SELECT ${GAME_COLUMNS} FROM games WHERE listed_in_shop ORDER BY title`);
      return rows.map(toGame);
    },
    async getGame(id) {
      const { rows } = await pool.query(`SELECT ${GAME_COLUMNS}, listed_in_shop FROM games WHERE id = $1`, [id]);
      return rows[0] ? { ...toGame(rows[0]), listedInShop: rows[0].listed_in_shop } : null;
    },

    // Inserts the order and its creation transition in one statement (one implicit transaction).
    // A reserved order gets reserved_until = now + holdMs; a waitlisted one waits waitMs, but never past waitEndsAt.
    async insertOrder({ id, sessionId = null, gameId, state, runId = null, buyerRef = null, isSimulated = false,
      holdMs, waitMs, waitEndsAt = null }) {
      const { rows } = await pool.query(
        `WITH created AS (
           INSERT INTO orders (id, session_id, game_id, amount_minor, currency, state, run_id, buyer_ref, is_simulated,
                               reserved_until, waitlist_until)
           SELECT $1, $2, g.id, g.price_minor, g.currency, $4::text, $5, $6, $7,
                  CASE WHEN $4::text = 'reserved' THEN now() + $8::integer * interval '1 millisecond' END,
                  CASE WHEN $4::text = 'waitlisted' THEN LEAST(now() + $9::integer * interval '1 millisecond', $10::timestamptz) END
           FROM games g WHERE g.id = $3
           RETURNING *),
         history AS (
           INSERT INTO order_transitions (order_id, from_state, to_state) SELECT id, NULL, state FROM created)
         SELECT * FROM created`,
        [id, sessionId, gameId, state, runId, buyerRef, isSimulated, holdMs ?? null, waitMs ?? null, waitEndsAt],
      );
      onOrderChange(id, sessionId);
      return toOrder(rows[0]);
    },

    async getOrder(id) {
      const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
      return rows[0] ? toOrder(rows[0]) : null;
    },
    async findActiveShopOrder(sessionId, gameId) {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE session_id = $1 AND game_id = $2 AND run_id IS NULL
           AND state IN ('waitlisted', 'reserved', 'payment_pending')`,
        [sessionId, gameId],
      );
      return rows[0] ? toOrder(rows[0]) : null;
    },
    // Order cards: only the session's own, non-simulated orders.
    async getSessionOrder(sessionId, orderId) {
      const { rows } = await pool.query(`${CARD_QUERY} WHERE o.session_id = $1 AND o.id = $2`, [sessionId, orderId]);
      return rows[0] ? toCard(rows[0]) : null;
    },
    async listSessionOrders(sessionId) {
      const { rows } = await pool.query(`${CARD_QUERY} WHERE o.session_id = $1 ORDER BY o.created_at`, [sessionId]);
      return rows.map(toCard);
    },

    // One conditional UPDATE plus its order_transitions row, in one statement.
    // Returns false when the order was no longer in `from` (someone else moved it first).
    // holdMs: new reserved_until (waitlist promotion). email: saved with the Pay transition.
    async transition(orderId, from, to, { holdMs = null, email = null } = {}) {
      const { rowCount } = await pool.query(
        `WITH moved AS (
           UPDATE orders SET state = $3, updated_at = now(),
             reserved_until = CASE WHEN $4::integer IS NULL THEN reserved_until
                                   ELSE now() + $4::integer * interval '1 millisecond' END,
             waitlist_until = CASE WHEN $4::integer IS NULL THEN waitlist_until END,
             buyer_email    = COALESCE($5, buyer_email),
             email_saved_at = CASE WHEN $5::text IS NULL THEN email_saved_at ELSE now() END
           WHERE id = $1 AND state = $2
           RETURNING id)
         INSERT INTO order_transitions (order_id, from_state, to_state) SELECT id, $2, $3 FROM moved`,
        [orderId, from, to, holdMs, email],
      );
      if (rowCount === 1) onOrderChange(orderId);
      return rowCount === 1;
    },

    // Expiry sweeper: holds and waits whose time has passed, oldest first.
    async dueHolds(limit) {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE state IN ('reserved', 'payment_pending') AND reserved_until <= now()
         ORDER BY reserved_until LIMIT $1`,
        [limit],
      );
      return rows.map(toOrder);
    },
    async dueWaits(limit) {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE state = 'waitlisted' AND waitlist_until <= now() ORDER BY waitlist_until LIMIT $1`,
        [limit],
      );
      return rows.map(toOrder);
    },

    async getPaymentEvent(eventId) {
      const { rows } = await pool.query('SELECT payload FROM payment_events WHERE event_id = $1', [eventId]);
      return rows[0]?.payload ?? null;
    },
    async findSucceededPayment(orderId) {
      const { rows } = await pool.query(
        `SELECT payload FROM payment_events WHERE order_id = $1 AND type = 'payment.succeeded'
         ORDER BY received_at LIMIT 1`,
        [orderId],
      );
      return rows[0]?.payload ?? null;
    },
    async recordDuplicate(orderId, kind) {
      await pool.query('INSERT INTO duplicates_blocked (order_id, kind) VALUES ($1, $2)', [orderId, kind]);
    },

    async getRun(id) {
      const { rows } = await pool.query('SELECT * FROM demo_runs WHERE id = $1', [id]);
      return rows[0] ? toRun(rows[0]) : null;
    },

    // Demo runs. The global cap and the insert share one transaction and an advisory lock,
    // because two starts at once would both read "2 running" under Read Committed.
    async insertRun({ sessionId, gameId, stockTotal, buyersRequested, faults, durationMs, maxRunning }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [RUN_START_LOCK]);
        const { rows: [{ running }] } = await client.query(
          `SELECT count(*)::int AS running FROM demo_runs WHERE status = 'running'`,
        );
        if (running >= maxRunning) {
          await client.query('ROLLBACK');
          return { outcome: 'busy' };
        }
        const { rows } = await client.query(
          `INSERT INTO demo_runs (session_id, game_id, stock_total, buyers_requested, faults, status, ends_at)
           VALUES ($1, $2, $3, $4, $5, 'running', now() + $6::integer * interval '1 millisecond') RETURNING *`,
          [sessionId, gameId, stockTotal, buyersRequested, faults, durationMs],
        );
        await client.query('COMMIT');
        return { outcome: 'created', run: toRun(rows[0]) };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.constraint === 'demo_runs_one_running_per_session') return { outcome: 'active' };
        throw err;
      } finally {
        client.release();
      }
    },
    // Both return false when the run was no longer running (someone else ended it first).
    async endRun(id, status) {
      const { rowCount } = await pool.query(`UPDATE demo_runs SET status = $2 WHERE id = $1 AND status = 'running'`, [id, status]);
      return rowCount === 1;
    },
    async setRunFaults(id, faults) {
      const { rowCount } = await pool.query(`UPDATE demo_runs SET faults = $2 WHERE id = $1 AND status = 'running'`, [id, faults]);
      return rowCount === 1;
    },
    async listRunningRuns() {
      const { rows } = await pool.query(`SELECT * FROM demo_runs WHERE status = 'running' ORDER BY created_at`);
      return rows.map(toRun);
    },
    async dueRuns(limit) {
      const { rows } = await pool.query(
        `SELECT * FROM demo_runs WHERE status = 'running' AND ends_at <= now() ORDER BY ends_at LIMIT $1`,
        [limit],
      );
      return rows.map(toRun);
    },
    async runWaitlisted(runId) {
      const { rows } = await pool.query(`SELECT * FROM orders WHERE run_id = $1 AND state = 'waitlisted'`, [runId]);
      return rows.map(toOrder);
    },
    // The simulated buyers' orders, for the run driver.
    async runSimulatedOrders(runId) {
      const { rows } = await pool.query(
        'SELECT id, buyer_ref, state, reserved_until FROM orders WHERE run_id = $1 AND is_simulated',
        [runId],
      );
      return rows.map((row) => ({ id: row.id, buyerRef: row.buyer_ref, state: row.state, reservedUntil: row.reserved_until }));
    },
    // Cleanup: ended runs older than olderThanMs; deleting a run cascades to its orders.
    async endedRunsBefore(olderThanMs, limit) {
      const { rows } = await pool.query(
        `SELECT id FROM demo_runs
         WHERE status <> 'running' AND ends_at < now() - $1::integer * interval '1 millisecond' LIMIT $2`,
        [olderThanMs, limit],
      );
      return rows.map((row) => row.id);
    },
    async deleteRun(id) {
      await pool.query('DELETE FROM demo_runs WHERE id = $1', [id]);
    },

    // Deliveries: one row per order and action; every attempt adds 1. A new attempt clears the last failure's class,
    // so a row with an error_class is one whose last attempt failed (the stream shows it only while the row is pending).
    async startDelivery({ orderId, connector, action }) {
      await pool.query(
        `INSERT INTO deliveries (order_id, connector, action, attempts) VALUES ($1, $2, $3, 1)
         ON CONFLICT (order_id, action)
         DO UPDATE SET attempts = deliveries.attempts + 1, status = 'pending', error_class = NULL, next_retry_at = NULL`,
        [orderId, connector, action],
      );
    },
    // failure: the connector's classifyError result for a failed attempt, { kind, retryAfterMs? }.
    async updateDelivery({ orderId, action, status, error = null, failure = null }) {
      await pool.query(
        `UPDATE deliveries SET status = $3, last_error = $4, error_class = $5,
           next_retry_at = CASE WHEN $6::integer IS NULL THEN NULL ELSE now() + $6::integer * interval '1 millisecond' END
         WHERE order_id = $1 AND action = $2`,
        [orderId, action, status, error, failure?.kind ?? null, failure?.retryAfterMs ?? null],
      );
      onOrderChange(orderId);
    },

    // After the last retry: the order's pending deliveries of that connector are failed for good.
    async failPendingDeliveries(orderId, connector, error) {
      await pool.query(
        `UPDATE deliveries SET status = 'failed', last_error = $3
         WHERE order_id = $1 AND connector = $2 AND status = 'pending'`,
        [orderId, connector, error],
      );
    },

    // What the ERP created for an order: one row per document type (design §4).
    async saveErpDocument({ orderId, doctype, name, docstatus }) {
      await pool.query(
        `INSERT INTO erp_documents (order_id, doctype, name, docstatus) VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id, doctype) DO UPDATE SET name = EXCLUDED.name, docstatus = EXCLUDED.docstatus`,
        [orderId, doctype, name, docstatus],
      );
    },

    // Shop restock (design §1.2 step 1). Returns the new receipt's id, or null when its dedupe key was already recorded.
    async insertReceipt({ gameId, dedupeKey, qty }) {
      const { rows } = await pool.query(
        `INSERT INTO stock_receipts (game_id, dedupe_key, qty) VALUES ($1, $2, $3)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [gameId, dedupeKey, qty],
      );
      return rows[0]?.id ?? null;
    },
    // Receipts whose copies are not yet in Redis: every tick finishes them (design §1.2 crash safety).
    async pendingReceipts(limit) {
      const { rows } = await pool.query(
        'SELECT id, game_id, qty FROM stock_receipts WHERE redis_applied_at IS NULL ORDER BY created_at LIMIT $1',
        [limit],
      );
      return rows.map((row) => ({ id: row.id, gameId: row.game_id, qty: row.qty }));
    },
    async markReceiptDone(id) {
      await pool.query(
        'UPDATE stock_receipts SET erp_applied_at = COALESCE(erp_applied_at, now()), redis_applied_at = now() WHERE id = $1',
        [id],
      );
    },

    // Of these order ids, the ones that cannot hold a copy: no such order, or a state that gave its copy back.
    // Waiting and failed orders are left out: the sweeper and replay settle their copies (design §1.1, §2).
    async ordersWithoutCopy(orderIds) {
      const { rows } = await pool.query(
        `SELECT i.id FROM unnest($1::uuid[]) AS i(id) LEFT JOIN orders o ON o.id = i.id
         WHERE o.id IS NULL OR o.state IN ('reservation_expired', 'waitlist_ended', 'refund_pending', 'refunded')`,
        [orderIds],
      );
      return rows.map((row) => row.id);
    },

    // Reconciler counts. Scope: { runId } or { gameId } (shop; all games if omitted).
    // graceMs: how long an order may sit in a pipeline state before it counts as stuck.
    async invariantCounts({ runId = null, gameId = null }, graceMs) {
      const scope = `CASE WHEN $1::uuid IS NOT NULL THEN o.run_id = $1
                          ELSE o.run_id IS NULL AND ($2::text IS NULL OR o.game_id = $2) END`;
      const { rows } = await pool.query(
        `WITH scoped AS (SELECT * FROM orders o WHERE ${scope})
         SELECT
           (SELECT count(*)::int FROM scoped s WHERE EXISTS (
              SELECT 1 FROM order_transitions t WHERE t.order_id = s.id AND t.to_state = 'paid')) AS sold,
           (SELECT count(*)::int FROM scoped s WHERE s.state IN ('payment_pending', 'reservation_expired') AND EXISTS (
              SELECT 1 FROM payment_events e WHERE e.order_id = s.id AND e.type = 'payment.succeeded'
                AND e.received_at < now() - $3::integer * interval '1 millisecond')) AS lost,
           (SELECT count(*)::int FROM scoped s WHERE s.state = 'failed' OR (s.state IN ('paid', 'so_submitted', 'invoiced')
              AND s.updated_at < now() - $3::integer * interval '1 millisecond')) AS stuck,
           (SELECT count(*)::int FROM scoped s WHERE s.state = 'completed' AND NOT EXISTS (
              SELECT 1 FROM erp_documents d WHERE d.order_id = s.id AND d.doctype = 'Sales Invoice' AND d.docstatus = 1))
              AS completed_without_invoice,
           (SELECT count(*)::int FROM duplicates_blocked b JOIN scoped s ON s.id = b.order_id) AS duplicates_blocked`,
        [runId, gameId, graceMs],
      );
      const { rows: byState } = await pool.query(
        `SELECT o.state, count(*)::int AS n FROM orders o WHERE ${scope} GROUP BY o.state`,
        [runId, gameId],
      );
      const counts = rows[0];
      return {
        sold: counts.sold,
        lost: counts.lost,
        paidNotInvoicedOrRefunded: counts.stuck,
        completedWithoutInvoice: counts.completed_without_invoice,
        duplicatesBlocked: counts.duplicates_blocked,
        byState: Object.fromEntries(byState.map((row) => [row.state, row.n])),
      };
    },
    // Per listed shop game: starting stock + recorded receipts, the part of the receipts
    // already added to Redis, whether any receipt is still in progress, and how many orders were sold.
    async shopStockTotals(gameId = null) {
      const { rows } = await pool.query(
        `SELECT g.id, g.stock_total AS start,
                COALESCE((SELECT sum(r.qty) FROM stock_receipts r WHERE r.game_id = g.id), 0)::int AS received,
                COALESCE((SELECT sum(r.qty) FROM stock_receipts r
                          WHERE r.game_id = g.id AND r.redis_applied_at IS NOT NULL), 0)::int AS received_in_redis,
                EXISTS (SELECT 1 FROM stock_receipts r WHERE r.game_id = g.id AND r.redis_applied_at IS NULL) AS in_progress,
                (SELECT count(*)::int FROM orders o WHERE o.game_id = g.id AND o.run_id IS NULL AND EXISTS (
                   SELECT 1 FROM order_transitions t WHERE t.order_id = o.id AND t.to_state = 'paid')) AS sold
         FROM games g WHERE g.listed_in_shop AND ($1::text IS NULL OR g.id = $1) ORDER BY g.id`,
        [gameId],
      );
      return rows.map((row) => ({
        gameId: row.id,
        start: row.start,
        received: row.received,
        receivedInRedis: row.received_in_redis,
        inProgress: row.in_progress,
        sold: row.sold,
      }));
    },

    // Dead-letter list for the admin page (design §5.4): deliveries that failed for good.
    async listFailedDeliveries(limit) {
      const { rows } = await pool.query(
        `SELECT id, order_id, connector, action, attempts, last_error FROM deliveries
         WHERE status = 'failed' ORDER BY id LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({
        id: row.id, orderId: row.order_id, connector: row.connector, action: row.action,
        attempts: row.attempts, lastError: row.last_error,
      }));
    },
    async getDelivery(id) {
      const { rows } = await pool.query('SELECT order_id, connector, action, status FROM deliveries WHERE id = $1', [id]);
      return rows[0]
        ? { orderId: rows[0].order_id, connector: rows[0].connector, action: rows[0].action, status: rows[0].status }
        : null;
    },
    // Replay, in one statement: a failed delivery becomes pending again and its order goes back to the state it
    // had before it failed (the from_state of its latest transition into failed, design §2). Returns the delivery's
    // order and connector, or null if the delivery was not failed (a second click loses).
    async reopenDelivery(id) {
      const { rows } = await pool.query(
        `WITH reopened AS (
           UPDATE deliveries SET status = 'pending' WHERE id = $1 AND status = 'failed'
           RETURNING order_id, connector),
         last_good AS (
           SELECT t.order_id, t.from_state FROM order_transitions t JOIN reopened r ON r.order_id = t.order_id
           WHERE t.to_state = 'failed' ORDER BY t.id DESC LIMIT 1),
         moved AS (
           UPDATE orders o SET state = g.from_state, updated_at = now() FROM last_good g
           WHERE o.id = g.order_id AND o.state = 'failed' RETURNING o.id, g.from_state),
         logged AS (
           INSERT INTO order_transitions (order_id, from_state, to_state)
           SELECT id, 'failed', from_state FROM moved)
         SELECT order_id, connector FROM reopened`,
        [id],
      );
      if (rows[0]) onOrderChange(rows[0].order_id);
      return rows[0] ? { orderId: rows[0].order_id, connector: rows[0].connector } : null;
    },
    // Recovery: orders in an ERP or refund step for longer than graceMs, oldest first, one page at a time.
    async stuckOrders(graceMs, limit, offset = 0) {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE state IN ('paid', 'so_submitted', 'invoiced', 'refund_pending')
           AND updated_at < now() - $1::integer * interval '1 millisecond'
         ORDER BY updated_at, id LIMIT $2 OFFSET $3`,
        [graceMs, limit, offset],
      );
      return rows.map(toOrder);
    },

    // Email job (design §5.1, §5.3): the order with what the email needs. deliveryStatus: the email.send row, if any.
    async getEmailOrder(orderId) {
      const { rows } = await pool.query(
        `SELECT o.id, o.session_id, o.run_id, o.state, o.is_simulated, o.email_channel, o.buyer_email,
                o.amount_minor, o.currency, g.title,
                (SELECT name FROM erp_documents d
                  WHERE d.order_id = o.id AND d.doctype = 'Sales Invoice' AND d.docstatus = 1) AS invoice_no,
                e.status AS delivery_status
         FROM orders o JOIN games g ON g.id = o.game_id
         LEFT JOIN deliveries e ON e.order_id = o.id AND e.action = 'email.send'
         WHERE o.id = $1`,
        [orderId],
      );
      const row = rows[0];
      return row ? {
        id: row.id, sessionId: row.session_id, runId: row.run_id, state: row.state, isSimulated: row.is_simulated,
        emailChannel: row.email_channel, buyerEmail: row.buyer_email, amountMinor: row.amount_minor,
        currency: row.currency, gameTitle: row.title, invoiceNo: row.invoice_no, deliveryStatus: row.delivery_status,
      } : null;
    },
    // The channel is decided once: an order that already has one keeps it (a retried email job). A visitor's order
    // that ends on mock loses its address at once, because no real email will use it. Returns the stored channel.
    async setEmailChannel(orderId, channel) {
      const { rows } = await pool.query(
        `UPDATE orders SET email_channel = COALESCE(email_channel, $2),
           buyer_email = CASE WHEN COALESCE(email_channel, $2) = 'mock' AND NOT is_simulated THEN NULL ELSE buyer_email END
         WHERE id = $1 RETURNING email_channel`,
        [orderId, channel],
      );
      return rows[0].email_channel;
    },
    // Email purge (design §1.2): addresses are kept afterMs after they were saved. Returns how many were cleared.
    async purgeEmails(afterMs) {
      const { rowCount } = await pool.query(
        `UPDATE orders SET buyer_email = NULL
         WHERE buyer_email IS NOT NULL AND email_saved_at < now() - $1::integer * interval '1 millisecond'`,
        [afterMs],
      );
      return rowCount;
    },
    // A delivery that failed for good, also when the job never got as far as writing its row. A delivery that
    // already succeeded is left alone.
    async failDelivery({ orderId, connector, action, error }) {
      await pool.query(
        `INSERT INTO deliveries (order_id, connector, action, status, last_error) VALUES ($1, $2, $3, 'failed', $4)
         ON CONFLICT (order_id, action) DO UPDATE SET status = 'failed', last_error = EXCLUDED.last_error
         WHERE deliveries.status <> 'succeeded'`,
        [orderId, connector, action, error],
      );
      onOrderChange(orderId);
    },

    // Live stream (design §8.4): what a session's stream reads. The newest `limit` orders, as cards.
    async streamCards(sessionId, limit) {
      const { rows } = await pool.query(
        `${CARD_QUERY} WHERE o.session_id = $1 ORDER BY o.created_at DESC LIMIT $2`,
        [sessionId, limit],
      );
      return rows.map(toCard);
    },
    // Each order's latest transition: where a new connection starts.
    async latestTransitions(orderIds) {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (order_id) id, order_id, from_state, to_state, at FROM order_transitions
         WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, id DESC`,
        [orderIds],
      );
      return rows.map(toTransition);
    },
    // The transitions after each order's last sent id, oldest first. cursors: { orderId: lastId }. An order without
    // a cursor is read from its first transition. Ids are compared per order only: across orders a smaller id can
    // become visible later (design §4).
    async transitionsAfter(orderIds, cursors) {
      const { rows } = await pool.query(
        `SELECT id, order_id, from_state, to_state, at FROM order_transitions
         WHERE order_id = ANY($1::uuid[]) AND id > COALESCE(($2::jsonb ->> order_id::text)::bigint, 0)
         ORDER BY id`,
        [orderIds, cursors],
      );
      return rows.map(toTransition);
    },
    // Deliveries whose last attempt failed and that will be tried again (startDelivery clears the class).
    async retryingDeliveries(orderIds) {
      const { rows } = await pool.query(
        `SELECT order_id, connector, action, attempts, error_class, next_retry_at FROM deliveries
         WHERE order_id = ANY($1::uuid[]) AND status = 'pending' AND error_class IN ('retryable', 'rateLimited')`,
        [orderIds],
      );
      return rows.map((row) => ({
        orderId: row.order_id, connector: row.connector, action: row.action, attempt: row.attempts,
        errorClass: row.error_class, nextRetryAt: row.next_retry_at,
      }));
    },
    async latestRunOfSession(sessionId) {
      const { rows } = await pool.query('SELECT * FROM demo_runs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [sessionId]);
      return rows[0] ? toRun(rows[0]) : null;
    },

    close: () => pool.end(),
  };
}

// order_transitions.id is a bigint, which pg returns as a string; it stays one (used only as a cursor).
const toTransition = (row) => ({
  id: row.id, orderId: row.order_id, from: row.from_state, to: row.to_state, at: row.at,
});

// Any fixed number; only run starts use it.
const RUN_START_LOCK = 2026111401;

const GAME_COLUMNS = 'id, title, price_minor, currency, stock_total';
const toGame = (row) => ({
  id: row.id, title: row.title, priceMinor: row.price_minor, currency: row.currency, stockTotal: row.stock_total,
});

const toOrder = (row) => ({
  id: row.id,
  sessionId: row.session_id,
  gameId: row.game_id,
  runId: row.run_id,
  buyerRef: row.buyer_ref,
  isSimulated: row.is_simulated,
  hasEmail: row.buyer_email !== null,
  state: row.state,
  amountMinor: row.amount_minor,
  currency: row.currency,
  reservedUntil: row.reserved_until,
  waitlistUntil: row.waitlist_until,
});

const toRun = (row) => ({
  id: row.id,
  sessionId: row.session_id,
  gameId: row.game_id,
  stockTotal: row.stock_total,
  buyersRequested: row.buyers_requested,
  faults: row.faults,
  status: row.status,
  createdAt: row.created_at,
  endsAt: row.ends_at,
});

// emailStatus is derived, not stored. invoiceNo: the submitted Sales Invoice.
const CARD_QUERY = `
  SELECT o.id, o.game_id, o.run_id, o.state, o.reserved_until, o.waitlist_until,
    (SELECT name FROM erp_documents d
      WHERE d.order_id = o.id AND d.doctype = 'Sales Invoice' AND d.docstatus = 1) AS invoice_no,
    CASE
      WHEN e.status = 'failed' THEN 'failed'
      WHEN e.status = 'succeeded' AND o.email_channel = 'gmail' THEN 'sent_gmail'
      WHEN e.status = 'succeeded' AND o.is_simulated THEN 'simulated'
      WHEN e.status = 'succeeded' THEN 'simulated_limit'
      WHEN o.state IN ('refunded', 'waitlist_ended') THEN 'none'
      WHEN o.is_simulated OR o.email_channel IS NOT NULL OR o.buyer_email IS NOT NULL THEN 'pending'
      ELSE 'none'
    END AS email_status
  FROM orders o
  LEFT JOIN deliveries e ON e.order_id = o.id AND e.action = 'email.send'`;

const toCard = (row) => ({
  orderId: row.id,
  gameId: row.game_id,
  runId: row.run_id,
  state: row.state,
  invoiceNo: row.invoice_no,
  emailStatus: row.email_status,
  reservedUntil: row.reserved_until,
  waitlistUntil: row.waitlist_until,
});
