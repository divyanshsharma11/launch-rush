// Shared test fixtures. Setup/cleanup SQL here is test-only; app SQL stays in src/services/db.
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Queue } from 'bullmq';
import { createLogger } from '../src/logger.js';

export const SECRET = 'a'.repeat(32);

// A real pino logger whose JSON lines are collected in `lines` (parsed) instead of stdout.
export function captureLogger() {
  const lines = [];
  const logger = createLogger({ level: 'info' }, { write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

// One session + one payment_pending order. Deleting the order cascades to payment_events.
export async function createTestOrder() {
  const admin = new pg.Client();
  const sessionId = randomUUID();
  const orderId = randomUUID();
  await admin.connect();
  await admin.query('INSERT INTO sessions (id) VALUES ($1)', [sessionId]);
  await admin.query(
    `INSERT INTO orders (id, session_id, game_id, amount_minor, currency, state)
     VALUES ($1, $2, 'elden-ring', 580000, 'INR', 'payment_pending')`,
    [orderId, sessionId],
  );
  return {
    admin,
    orderId,
    async remove() {
      await admin.query('DELETE FROM orders WHERE id = $1', [orderId]);
      await admin.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      await admin.end();
    },
  };
}

export async function countPaymentEvents(admin, eventId) {
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM payment_events WHERE event_id = $1', [eventId]);
  return rows[0].n;
}

export function paymentEvent(id, orderId) {
  return {
    id,
    type: 'payment.succeeded',
    created: 1_800_000_000,
    data: { paymentId: 'pay_test', orderId, amountMinor: 580000, currency: 'INR' },
  };
}

// Signs like the mock provider: v1 = HMAC-SHA256(secret, "<t>.<raw body>").
export function signatureHeader(raw, secret = SECRET) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return `t=${t},v1=${v1}`;
}

// A uniquely named queue name plus a reader for it; cleanup() deletes the queue.
export function testQueue(connection) {
  const name = `webhooks-test-${randomUUID()}`;
  const inspect = new Queue(name, { connection });
  return {
    name,
    inspect,
    async cleanup() {
      await inspect.obliterate({ force: true });
      await inspect.close();
    },
  };
}
