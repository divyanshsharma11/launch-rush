// Mock payment provider: all paysim SQL. pg reads the PG* env vars itself.
import pg from 'pg';

// pg's defaults are "no timeout": a frozen DB would make every query wait forever.
export function createProviderDb({ logger, connectTimeoutMs = 5_000, queryTimeoutMs = 5_000 }) {
  const pool = new pg.Pool({ connectionTimeoutMillis: connectTimeoutMs, query_timeout: queryTimeoutMs });
  // Without a listener, an idle client's error would crash the process.
  pool.on('error', (err) => logger.error({ err }, 'postgres idle client error'));

  return {
    // Payment, event and deliveries in one transaction. sends: 2 when a run payment's webhook is sent twice.
    // Outcomes: 'created', 'existing' (same key and body), 'conflict' (same key, other body).
    async createCharge({ payment, event, sends = 1 }) {
      const client = await pool.connect();
      let created;
      let failed;
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
        failed = err;
        await rollback(client);
        throw err;
      } finally {
        client.release(failed);
      }
      if (created) return { outcome: 'created', payment };

      // The key exists (maybe from a racing request; this new statement sees its committed row).
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

    // Full refund. Outcomes: 'created', 'existing', 'conflict', 'payment_not_found', 'already_refunded'.
    async createRefund({ refund, eventId }) {
      const client = await pool.connect();
      let failed;
      try {
        await client.query('BEGIN');
        const result = await insertRefund(client, refund, eventId);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        failed = err;
        await rollback(client);
        throw err;
      } finally {
        client.release(failed);
      }
    },

    // "Duplicate": sends the stored payment.succeeded event again (same id, same bytes).
    async resendWebhook(paymentId) {
      const { rows } = await pool.query(
        `INSERT INTO paysim.deliveries (event_id)
         SELECT id FROM paysim.events WHERE payment_id = $1 AND type = 'payment.succeeded'
         RETURNING event_id`,
        [paymentId],
      );
      return rows.length === 1 ? { outcome: 'queued', eventId: rows[0].event_id } : { outcome: 'payment_not_found' };
    },

    // Deliveries that gave up go back to pending with fresh attempts: recent shop events only (run events are
    // cleaned up soon), and not when another send of the same event was delivered. Returns how many.
    async redeliverFailed(maxAgeMs) {
      const { rowCount } = await pool.query(
        `UPDATE paysim.deliveries d
         SET status = 'pending', attempts = 0, next_attempt_at = now()
         FROM paysim.events e JOIN paysim.payments p ON p.id = e.payment_id
         WHERE e.id = d.event_id AND d.status = 'failed' AND p.run_id IS NULL
           AND d.created_at > now() - $1::integer * interval '1 millisecond'
           AND NOT EXISTS (SELECT 1 FROM paysim.deliveries x WHERE x.event_id = d.event_id AND x.status = 'delivered')`,
        [maxAgeMs],
      );
      return rowCount;
    },

    // Claims due deliveries with a lease: if the process dies mid-send, the row is claimed again after leaseMs.
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

    // Only pending rows change, so a late update cannot undo delivered/failed.
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
    async ping() {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}

// A stuck connection (query timeout) fails the ROLLBACK too; release(err) then discards it.
async function rollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // the caller gets the original error
  }
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

  // No conflict target: skips on the key or on one-refund-per-payment.
  const { rowCount } = await client.query(
    `INSERT INTO paysim.refunds (id, idempotency_key, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [refund.id, refund.idempotencyKey, refund.paymentId],
  );
  if (rowCount === 0) return (await savedRefund(client, refund)) ?? { outcome: 'already_refunded' };

  const body = JSON.stringify({
    id: eventId,
    type: 'payment.refunded',
    created: Math.floor(Date.now() / 1000),
    data: { refundId: refund.id, paymentId: refund.paymentId, orderId: payment.order_id, amountMinor: payment.amount_minor, currency: payment.currency },
  });
  await client.query(
    `INSERT INTO paysim.events (id, type, payment_id, body) VALUES ($1, 'payment.refunded', $2, $3)`,
    [eventId, refund.paymentId, body],
  );
  await client.query('INSERT INTO paysim.deliveries (event_id) VALUES ($1)', [eventId]);
  return { outcome: 'created', refund };
}

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
