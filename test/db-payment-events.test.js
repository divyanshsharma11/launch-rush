// insertPaymentEvent (design §5.2 step 3) against the real PostgreSQL container.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/services/db/index.js';
import { captureLogger, createTestOrder, countPaymentEvents, paymentEvent } from './helpers.js';

const db = createDb({ logger: captureLogger().logger });
let order;

// Non-ASCII text in the payload checks the jsonb round trip.
const event = (id, orderId = order.orderId) => {
  const e = paymentEvent(id, orderId);
  return { ...e, data: { ...e.data, note: 'Ragnarök' } };
};

before(async () => {
  order = await createTestOrder();
});

after(async () => {
  await order.remove();
  await db.close();
});

test('first insert returns true, a duplicate event id returns false and leaves one row', async () => {
  const id = `evt_${randomUUID()}`;
  assert.equal(await db.insertPaymentEvent(event(id)), true);
  assert.equal(await db.insertPaymentEvent(event(id)), false);
  assert.equal(await countPaymentEvents(order.admin, id), 1);
});

test('payload is stored as jsonb and reads back equal', async () => {
  const id = `evt_${randomUUID()}`;
  await db.insertPaymentEvent(event(id));
  const { rows } = await order.admin.query('SELECT payload FROM payment_events WHERE event_id = $1', [id]);
  assert.deepEqual(rows[0].payload, event(id));
});

test('an unknown order id is rejected by the foreign key', async () => {
  await assert.rejects(db.insertPaymentEvent(event(`evt_${randomUUID()}`, randomUUID())), { code: '23503' });
});
