// Mock payment provider: all paysim SQL lives here (one repository, like src/services/db). PG* env vars, read by pg itself.
import pg from 'pg';

export function createProviderDb({ logger }) {
  const pool = new pg.Pool();
  // Without a listener, an idle client's error would crash the process (node-postgres pool docs).
  pool.on('error', (err) => logger.error({ err }, 'postgres idle client error'));

  return {
    // Charge (design §5.2, §6). The payment, its payment.succeeded event and its deliveries are written in one
    // transaction (transactional outbox, plan §5.6), so a charge never exists without its webhook queued.
    // sends: 1, or 2 when a run payment's webhook is sent twice (§5.5).
    // A repeated idempotency key creates nothing: 'existing' returns the saved payment, 'conflict' means the
    // same key came with a different body (409, as Stripe).
    async createCharge({ payment, event, sends = 1 }) {
      const client = await pool.connect(); // a transaction needs one client for all its statements (node-postgres docs)
      let created;
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
          `INSERT INTO paysim.payments (id, idempotency_key, order_id, amount_minor, currency, run_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [payment.id, payment.idempotencyKey, payment.orderId, payment.amountMinor, payment.currency, payment.runId],
        );
        created = rowCount === 1;
        if (created) {
          await client.query(
            `INSERT INTO paysim.events (id, type, payment_id, body) VALUES ($1, 'payment.succeeded', $2, $3)`,
            [event.id, payment.id, event.body],
          );
          for (let i = 0; i < sends; i++) {
            await client.query('INSERT INTO paysim.deliveries (event_id) VALUES ($1)', [event.id]);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      if (created) return { outcome: 'created', payment };

      // The key already exists, possibly from a request that won a race: under Read Committed this new statement
      // sees its committed row. Compared in SQL, so the uuid comparison ignores letter case.
      const { rows } = await pool.query(
        `SELECT id, order_id, amount_minor, currency, run_id,
                (order_id = $2 AND amount_minor = $3 AND currency = $4) AS same_body
         FROM paysim.payments WHERE idempotency_key = $1`,
        [payment.idempotencyKey, payment.orderId, payment.amountMinor, payment.currency],
      );
      const row = rows[0];
      return {
        outcome: row.same_body ? 'existing' : 'conflict',
        payment: {
          id: row.id,
          idempotencyKey: payment.idempotencyKey,
          orderId: row.order_id,
          amountMinor: row.amount_minor,
          currency: row.currency,
          runId: row.run_id,
        },
      };
    },

    // Refund of the full payment (design §5.2 refund(paymentId), §6 key 'refund-<orderId>'). Checks in Stripe's order
    // (plan §10 Step 3 decision 2026-11-13): the idempotency key first, then the payment, then the insert. The refund,
    // its payment.refunded event and one delivery are written in one transaction, as for a charge.
    // Outcomes: 'created', 'existing' (same key, same paymentId), 'conflict' (same key, other paymentId),
    // 'payment_not_found', 'already_refunded' (refunded under another key; one refund per payment, 014).
    async createRefund({ refund, eventId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await insertRefund(client, refund, eventId);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // Deliveries (plan §10 Step 3 decision 2026-11-13: lease claim). One statement claims up to `limit` due pending
    // rows: SKIP LOCKED passes over rows another claimer holds, attempts is counted now, and next_attempt_at moves
    // forward by the lease. The send happens after this, outside any transaction; if the process dies mid-send the
    // row is still pending and is claimed again once the lease runs out (one duplicate at most; our ingress dedupes).
    // Returns the exact event body to send. id is a bigint, which pg returns as a string.
    async claimDueDeliveries({ limit, leaseMs }) {
      const { rows } = await pool.query(
        `UPDATE paysim.deliveries d
         SET attempts = d.attempts + 1, next_attempt_at = now() + $2::integer * interval '1 millisecond'
         FROM paysim.events e
         WHERE e.id = d.event_id
           AND d.id IN (SELECT id FROM paysim.deliveries
                        WHERE status = 'pending' AND next_attempt_at <= now()
                        ORDER BY next_attempt_at LIMIT $1
                        FOR UPDATE SKIP LOCKED)
         RETURNING d.id, d.event_id, d.attempts, e.body`,
        [limit, leaseMs],
      );
      return rows.map((r) => ({ id: r.id, eventId: r.event_id, attempts: r.attempts, body: r.body }));
    },

    // The updates after a send. Each only touches a row that is still pending, so a late update cannot undo a final state.
    async markDelivered(id) {
      await pool.query(`UPDATE paysim.deliveries SET status = 'delivered' WHERE id = $1 AND status = 'pending'`, [id]);
    },
    async scheduleRetry({ id, delayMs, error }) {
      await pool.query(
        `UPDATE paysim.deliveries SET next_attempt_at = now() + $2::integer * interval '1 millisecond', last_error = $3
         WHERE id = $1 AND status = 'pending'`,
        [id, delayMs, error],
      );
    },
    async markFailed({ id, error }) {
      await pool.query(
        `UPDATE paysim.deliveries SET status = 'failed', last_error = $2 WHERE id = $1 AND status = 'pending'`,
        [id, error],
      );
    },
    close: () => pool.end(),
  };
}

async function insertRefund(client, refund, eventId) {
  const saved = await savedRefund(client, refund);
  if (saved) return saved;

  const { rows } = await client.query(
    'SELECT order_id, amount_minor, currency FROM paysim.payments WHERE id = $1',
    [refund.paymentId],
  );
  const payment = rows[0];
  if (!payment) return { outcome: 'payment_not_found' };

  // No conflict target: skips on either unique rule (the key, or one refund per payment). Under Read Committed a
  // racing insert of the same key is waited for, then skipped; the next statement sees its committed row.
  const { rowCount } = await client.query(
    `INSERT INTO paysim.refunds (id, idempotency_key, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [refund.id, refund.idempotencyKey, refund.paymentId],
  );
  if (rowCount === 0) return (await savedRefund(client, refund)) ?? { outcome: 'already_refunded' };

  const body = JSON.stringify({
    id: eventId,
    type: 'payment.refunded',
    data: { refundId: refund.id, paymentId: refund.paymentId, orderId: payment.order_id, amountMinor: payment.amount_minor, currency: payment.currency },
  });
  await client.query(
    `INSERT INTO paysim.events (id, type, payment_id, body) VALUES ($1, 'payment.refunded', $2, $3)`,
    [eventId, refund.paymentId, body],
  );
  await client.query('INSERT INTO paysim.deliveries (event_id) VALUES ($1)', [eventId]);
  return { outcome: 'created', refund };
}

// The refund already saved under this key, compared with the request ('existing' or 'conflict'), or null.
async function savedRefund(client, refund) {
  const { rows } = await client.query(
    'SELECT id, payment_id FROM paysim.refunds WHERE idempotency_key = $1',
    [refund.idempotencyKey],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    outcome: row.payment_id === refund.paymentId ? 'existing' : 'conflict',
    refund: { id: row.id, idempotencyKey: refund.idempotencyKey, paymentId: row.payment_id },
  };
}
