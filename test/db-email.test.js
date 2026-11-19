// Email repository functions against the real PostgreSQL container.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/services/db/index.js';
import { captureLogger, createTestShop } from './helpers.js';

const db = createDb({ logger: captureLogger().logger });
let shop;
let sessionId;

// A reserved order that went through Pay with an address, in the given state.
async function order({ email = 'a@example.com', state = 'completed' } = {}) {
  const created = await db.insertOrder({ id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', holdMs: 300_000 });
  await db.transition(created.id, 'reserved', 'payment_pending', { email });
  await shop.admin.query('UPDATE orders SET state = $2 WHERE id = $1', [created.id, state]);
  return created.id;
}
const rowOf = async (orderId) => (await shop.admin.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
const deliveryOf = async (orderId) =>
  (await shop.admin.query('SELECT * FROM deliveries WHERE order_id = $1', [orderId])).rows[0];

before(async () => {
  shop = await createTestShop();
  sessionId = await shop.newSession();
});
after(async () => {
  await shop.remove();
  await db.close();
});

test('getEmailOrder: what the email needs; unknown order is null', async () => {
  const id = await order();
  await shop.admin.query(
    `INSERT INTO erp_documents (order_id, doctype, name, docstatus) VALUES ($1, 'Sales Invoice', 'SINV-0007', 1)`, [id],
  );
  assert.deepEqual(await db.getEmailOrder(id), {
    id, sessionId, runId: null, state: 'completed', isSimulated: false, emailChannel: null, buyerEmail: 'a@example.com',
    amountMinor: 450000, currency: 'INR', gameTitle: 'Test Game', invoiceNo: 'SINV-0007', deliveryStatus: null,
  });
  await db.startDelivery({ orderId: id, connector: 'email-gmail', action: 'email.send' });
  assert.equal((await db.getEmailOrder(id)).deliveryStatus, 'pending');
  assert.equal(await db.getEmailOrder(randomUUID()), null);
});

test('setEmailChannel: decided once; gmail keeps the address, mock clears it', async () => {
  const gmail = await order();
  assert.equal(await db.setEmailChannel(gmail, 'gmail'), 'gmail');
  assert.equal(await db.setEmailChannel(gmail, 'mock'), 'gmail', 'the first decision stays');
  assert.equal((await rowOf(gmail)).buyer_email, 'a@example.com');

  const mock = await order({ email: 'b@example.com' });
  assert.equal(await db.setEmailChannel(mock, 'mock'), 'mock');
  assert.equal((await rowOf(mock)).buyer_email, null, 'no real email will use it');
  assert.equal(await db.setEmailChannel(mock, 'gmail'), 'mock');
  assert.equal((await rowOf(mock)).email_channel, 'mock');
});

test('purgeEmails: only addresses older than the limit are cleared', async () => {
  const old = await order({ email: 'old@example.com' });
  const fresh = await order({ email: 'fresh@example.com' });
  await shop.admin.query(`UPDATE orders SET email_saved_at = now() - interval '25 hours' WHERE id = $1`, [old]);
  assert.ok((await db.purgeEmails(86_400_000)) >= 1);
  assert.equal((await rowOf(old)).buyer_email, null);
  assert.equal((await rowOf(fresh)).buyer_email, 'fresh@example.com');
});

test('failDelivery: creates the failed row, fails a pending one, never touches a succeeded one', async () => {
  const none = await order();
  await db.failDelivery({ orderId: none, connector: 'email-gmail', action: 'email.send', error: 'redis down' });
  assert.deepEqual(
    { status: (await deliveryOf(none)).status, error: (await deliveryOf(none)).last_error, attempts: (await deliveryOf(none)).attempts },
    { status: 'failed', error: 'redis down', attempts: 0 },
  );

  const pending = await order();
  await db.startDelivery({ orderId: pending, connector: 'email-gmail', action: 'email.send' });
  await db.failDelivery({ orderId: pending, connector: 'email-gmail', action: 'email.send', error: 'HTTP 503' });
  assert.equal((await deliveryOf(pending)).status, 'failed');
  assert.equal((await deliveryOf(pending)).attempts, 1);

  const done = await order();
  await db.startDelivery({ orderId: done, connector: 'email-gmail', action: 'email.send' });
  await db.updateDelivery({ orderId: done, action: 'email.send', status: 'succeeded' });
  await db.failDelivery({ orderId: done, connector: 'email-gmail', action: 'email.send', error: 'late hook' });
  assert.equal((await deliveryOf(done)).status, 'succeeded');
});

test('order card: no email is expected from a refunded or waitlist_ended order; an expired one may still be paid', async () => {
  for (const [state, expected] of [['refunded', 'none'], ['waitlist_ended', 'none'], ['reservation_expired', 'pending'], ['completed', 'pending']]) {
    const id = await order({ state });
    assert.equal((await db.getSessionOrder(sessionId, id)).emailStatus, expected, state);
  }
});
