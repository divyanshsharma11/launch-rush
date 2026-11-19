// Order repository functions against the real PostgreSQL container.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/services/db/index.js';
import { captureLogger, createTestShop, paymentEvent } from './helpers.js';

const db = createDb({ logger: captureLogger().logger });
let shop;
let sessionId;

const history = async (orderId) =>
  (await shop.admin.query('SELECT from_state, to_state FROM order_transitions WHERE order_id = $1 ORDER BY id', [orderId]))
    .rows.map((r) => [r.from_state, r.to_state]);

const reserve = (extra = {}) =>
  db.insertOrder({ id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', holdMs: 300_000, ...extra });

before(async () => {
  shop = await createTestShop();
  sessionId = await shop.newSession();
});

after(async () => {
  await shop.remove();
  await db.close();
});

test('sessions: created with a random id, and found', async () => {
  const id = await db.createSession();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(await db.sessionExists(id), true);
  assert.equal(await db.sessionExists(randomUUID()), false);
  await shop.admin.query('DELETE FROM sessions WHERE id = $1', [id]);
});

test('games: the test game is listed with its price and stock; unknown id is null', async () => {
  const game = (await db.listShopGames()).find((g) => g.id === shop.gameId);
  assert.deepEqual(game, { id: shop.gameId, title: 'Test Game', priceMinor: 450000, currency: 'INR', stockTotal: 2 });
  assert.equal((await db.getGame(shop.gameId)).listedInShop, true);
  assert.equal(await db.getGame('no-such-game'), null);
});

test('insertOrder: reserved order with price from the game, hold time, and its creation transition', async () => {
  const before = Date.now();
  const order = await reserve();
  assert.equal(order.state, 'reserved');
  assert.equal(order.amountMinor, 450000);
  assert.equal(order.currency, 'INR');
  const holdMs = order.reservedUntil.getTime() - before;
  assert.ok(holdMs > 299_000 && holdMs < 302_000, `hold ${holdMs} ms`);
  assert.equal(order.waitlistUntil, null);
  assert.deepEqual(await history(order.id), [[null, 'reserved']]);
  await shop.admin.query('DELETE FROM orders WHERE id = $1', [order.id]);
});

test('insertOrder: a waitlisted order waits waitMs, but never past waitEndsAt', async () => {
  const runEnds = new Date(Date.now() + 60_000);
  const order = await db.insertOrder({
    id: randomUUID(), sessionId, gameId: shop.gameId, state: 'waitlisted', waitMs: 600_000, waitEndsAt: runEnds,
  });
  assert.equal(order.reservedUntil, null);
  assert.equal(order.waitlistUntil.getTime(), runEnds.getTime());
  const open = await db.insertOrder({
    id: randomUUID(), sessionId: await shop.newSession(), gameId: shop.gameId, state: 'waitlisted', waitMs: 1000,
  });
  assert.ok(open.waitlistUntil.getTime() - Date.now() < 2000);
  await shop.admin.query('DELETE FROM orders WHERE id = ANY($1)', [[order.id, open.id]]);
});

test('second active shop order for the same session and game: unique violation; the first is findable', async () => {
  const first = await reserve();
  await assert.rejects(reserve(), { code: '23505', constraint: 'orders_one_active_per_session_game' });
  assert.equal((await db.findActiveShopOrder(sessionId, shop.gameId)).id, first.id);
  await shop.admin.query('DELETE FROM orders WHERE id = $1', [first.id]);
});

test('transition: moves only from the expected state and records the history row', async () => {
  const order = await reserve();
  assert.equal(await db.transition(order.id, 'reserved', 'payment_pending', { email: 'a@example.com' }), true);
  assert.equal(await db.transition(order.id, 'reserved', 'payment_pending'), false);
  const { rows } = await shop.admin.query('SELECT buyer_email, email_saved_at FROM orders WHERE id = $1', [order.id]);
  assert.equal(rows[0].buyer_email, 'a@example.com');
  assert.ok(rows[0].email_saved_at);
  assert.deepEqual(await history(order.id), [[null, 'reserved'], ['reserved', 'payment_pending']]);
  await shop.admin.query('DELETE FROM orders WHERE id = $1', [order.id]);
});

test('transition with holdMs: a promoted waiter gets a new hold and no wait time', async () => {
  const order = await db.insertOrder({
    id: randomUUID(), sessionId, gameId: shop.gameId, state: 'waitlisted', waitMs: 600_000,
  });
  assert.equal(await db.transition(order.id, 'waitlisted', 'reserved', { holdMs: 30_000 }), true);
  const promoted = await db.getOrder(order.id);
  assert.equal(promoted.waitlistUntil, null);
  assert.ok(Math.abs(promoted.reservedUntil.getTime() - Date.now() - 30_000) < 2000);
  await shop.admin.query('DELETE FROM orders WHERE id = $1', [order.id]);
});

test('two racing transitions from the same state: exactly one wins', async () => {
  const order = await reserve();
  const results = await Promise.all([
    db.transition(order.id, 'reserved', 'payment_pending'),
    db.transition(order.id, 'reserved', 'reservation_expired'),
  ]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal((await history(order.id)).length, 2);
  await shop.admin.query('DELETE FROM orders WHERE id = $1', [order.id]);
});

test('due holds and waits: only orders whose time has passed', async () => {
  const expired = await reserve({ holdMs: -1000 });
  const fresh = await reserve({ sessionId: await shop.newSession() });
  const waiting = await db.insertOrder({
    id: randomUUID(), sessionId: await shop.newSession(), gameId: shop.gameId, state: 'waitlisted', waitMs: -1000,
  });
  const holds = (await db.dueHolds(1000)).map((o) => o.id);
  assert.ok(holds.includes(expired.id) && !holds.includes(fresh.id));
  assert.ok((await db.dueWaits(1000)).some((o) => o.id === waiting.id));
  await shop.admin.query('DELETE FROM orders WHERE id = ANY($1)', [[expired.id, fresh.id, waiting.id]]);
});

test('order card: own session only, emailStatus derived, invoiceNo from the submitted Sales Invoice', async () => {
  const order = await reserve();
  assert.equal(await db.getSessionOrder(await shop.newSession(), order.id), null);
  let card = await db.getSessionOrder(sessionId, order.id);
  assert.deepEqual(
    { state: card.state, emailStatus: card.emailStatus, invoiceNo: card.invoiceNo },
    { state: 'reserved', emailStatus: 'none', invoiceNo: null },
  );
  await db.transition(order.id, 'reserved', 'payment_pending', { email: 'a@example.com' });
  assert.equal((await db.getSessionOrder(sessionId, order.id)).emailStatus, 'pending');

  await shop.admin.query(
    `INSERT INTO erp_documents (order_id, doctype, name, docstatus) VALUES ($1, 'Sales Invoice', 'SINV-0001', 1)`,
    [order.id],
  );
  await shop.admin.query(
    `INSERT INTO deliveries (order_id, connector, action, status) VALUES ($1, 'email-gmail', 'email.send', 'succeeded')`,
    [order.id],
  );
  await shop.admin.query(`UPDATE orders SET email_channel = 'gmail' WHERE id = $1`, [order.id]);
  card = await db.getSessionOrder(sessionId, order.id);
  assert.deepEqual({ invoiceNo: card.invoiceNo, emailStatus: card.emailStatus }, { invoiceNo: 'SINV-0001', emailStatus: 'sent_gmail' });
  assert.deepEqual((await db.listSessionOrders(sessionId)).map((c) => c.orderId), [order.id]);
  await shop.admin.query('DELETE FROM orders WHERE id = $1', [order.id]);
});

test('payment events, duplicates and deliveries', async () => {
  const order = await reserve();
  const event = paymentEvent(`evt_${randomUUID()}`, order.id);
  await db.insertPaymentEvent(event);
  assert.deepEqual(await db.getPaymentEvent(event.id), event);
  assert.deepEqual(await db.findSucceededPayment(order.id), event);
  assert.equal(await db.findSucceededPayment(randomUUID()), null);

  await db.recordDuplicate(order.id, 'webhook');
  await assert.rejects(db.recordDuplicate(order.id, 'other'), { constraint: 'duplicates_blocked_kind_valid' });

  await db.startDelivery({ orderId: order.id, connector: 'payment-mock', action: 'refund' });
  await db.updateDelivery({ orderId: order.id, action: 'refund', status: 'pending', error: 'HTTP 503' });
  await db.startDelivery({ orderId: order.id, connector: 'payment-mock', action: 'refund' });
  const { rows } = await shop.admin.query('SELECT status, attempts, last_error FROM deliveries WHERE order_id = $1', [order.id]);
  assert.deepEqual(rows, [{ status: 'pending', attempts: 2, last_error: 'HTTP 503' }]);
  await shop.admin.query('DELETE FROM orders WHERE id = $1', [order.id]);
});
