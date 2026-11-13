// The ONE repository module (plan §6 item 4): all SQL lives here. Connection settings: PG* env vars, read by pg itself.
import pg from 'pg';

export function createDb({ logger }) {
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
    close: () => pool.end(),
  };
}
