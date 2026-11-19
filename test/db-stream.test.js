// What the live stream reads from PostgreSQL (design §8.4), the wake-up hook, and the delivery failure class.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/services/db/index.js';
import { captureLogger, createTestShop } from './helpers.js';

const { logger } = captureLogger();
const changed = [];
const db = createDb({ logger, onOrderChange: (orderId, sessionId) => changed.push(sessionId ? [orderId, sessionId] : [orderId]) });
let shop;

// One active order per session and game (design §5.1), so each order gets its own session unless one is given.
const newOrder = async (session) =>
  (await db.insertOrder({ id: randomUUID(), sessionId: session ?? (await shop.newSession()), gameId: shop.gameId, state: 'reserved', holdMs: 300_000 })).id;
const delivery = (orderId, action = 'sales_order.submit') => ({ orderId, connector: 'erp-sim', action });
const rowOf = async (orderId, action = 'sales_order.submit') =>
  (await shop.admin.query('SELECT status, attempts, error_class, next_retry_at FROM deliveries WHERE order_id = $1 AND action = $2', [orderId, action])).rows[0];

before(async () => {
  shop = await createTestShop();
});

after(async () => {
  await shop.remove();
  await db.close();
});

test('onOrderChange: after an insert and a winning transition, not after a lost one', async () => {
  const session = await shop.newSession();
  changed.length = 0;
  const id = await newOrder(session);
  assert.deepEqual(changed, [[id, session]]); // a new order names its session
  assert.equal(await db.transition(id, 'reserved', 'payment_pending'), true);
  assert.equal(await db.transition(id, 'reserved', 'payment_pending'), false); // already moved
  assert.deepEqual(changed, [[id, session], [id]]);
});

test('onOrderChange: after a delivery update, a failed delivery and a replay', async () => {
  const id = await newOrder();
  await db.startDelivery(delivery(id));
  changed.length = 0;
  await db.updateDelivery({ ...delivery(id), status: 'succeeded' });
  await db.failDelivery({ ...delivery(id, 'email.send'), error: 'boom' });
  const { rows } = await shop.admin.query(`UPDATE deliveries SET status = 'failed' WHERE order_id = $1 AND action = $2 RETURNING id`, [id, 'sales_order.submit']);
  await db.reopenDelivery(rows[0].id);
  assert.deepEqual(changed, [[id], [id], [id]]);
});

test('a failed attempt keeps its class; the next attempt clears it; rateLimited stores the time the upstream named', async () => {
  const id = await newOrder();
  await db.startDelivery(delivery(id));
  await db.updateDelivery({ ...delivery(id), status: 'pending', error: 'HTTP 503', failure: { kind: 'retryable' } });
  let row = await rowOf(id);
  assert.deepEqual([row.status, row.attempts, row.error_class, row.next_retry_at], ['pending', 1, 'retryable', null]);

  await db.startDelivery(delivery(id));
  row = await rowOf(id);
  assert.deepEqual([row.attempts, row.error_class], [2, null]);

  const before = Date.now();
  await db.updateDelivery({ ...delivery(id), status: 'pending', error: 'HTTP 429', failure: { kind: 'rateLimited', retryAfterMs: 5000 } });
  row = await rowOf(id);
  assert.equal(row.error_class, 'rateLimited');
  assert.ok(row.next_retry_at - before >= 4000 && row.next_retry_at - before <= 7000);

  await db.updateDelivery({ ...delivery(id), status: 'succeeded' });
  row = await rowOf(id);
  assert.deepEqual([row.status, row.error_class, row.next_retry_at], ['succeeded', null, null]);
});

test('retryingDeliveries: pending with a retryable or rateLimited failure only', async () => {
  const [retry, limited, permanent, running, done] = [await newOrder(), await newOrder(), await newOrder(), await newOrder(), await newOrder()];
  for (const id of [retry, limited, permanent, running, done]) await db.startDelivery(delivery(id));
  await db.updateDelivery({ ...delivery(retry), status: 'pending', failure: { kind: 'retryable' } });
  await db.updateDelivery({ ...delivery(limited), status: 'pending', failure: { kind: 'rateLimited', retryAfterMs: 1000 } });
  await db.updateDelivery({ ...delivery(permanent), status: 'pending', failure: { kind: 'permanent' } });
  await db.updateDelivery({ ...delivery(done), status: 'succeeded' });

  const found = await db.retryingDeliveries([retry, limited, permanent, running, done]);
  assert.deepEqual(found.map((d) => [d.orderId, d.errorClass, d.attempt]).sort(), [[retry, 'retryable', 1], [limited, 'rateLimited', 1]].sort());
  assert.equal(found.find((d) => d.orderId === retry).nextRetryAt, null);
  assert.deepEqual(await db.retryingDeliveries([]), []);
});

test('streamCards: the session\'s newest orders first, limited; other sessions\' orders are not included', async () => {
  const mine = await shop.newSession();
  const first = await newOrder(mine);
  await db.transition(first, 'reserved', 'reservation_expired');
  const second = await newOrder(mine);
  await newOrder(await shop.newSession());
  assert.deepEqual((await db.streamCards(mine, 10)).map((card) => card.orderId), [second, first]);
  assert.deepEqual((await db.streamCards(mine, 1)).map((card) => card.orderId), [second]);
  const [card] = await db.streamCards(mine, 1);
  assert.deepEqual([card.state, card.emailStatus, card.invoiceNo, card.gameId], ['reserved', 'none', null, shop.gameId]);
});

test('latestTransitions and transitionsAfter work per order, from each order\'s own cursor', async () => {
  const a = await newOrder();
  const b = await newOrder();
  await db.transition(a, 'reserved', 'payment_pending');
  await db.transition(b, 'reserved', 'payment_pending');
  await db.transition(a, 'payment_pending', 'paid');

  const latest = await db.latestTransitions([a, b]);
  assert.deepEqual(latest.map((t) => [t.orderId, t.from, t.to]).sort(), [[a, 'payment_pending', 'paid'], [b, 'reserved', 'payment_pending']].sort());

  const all = await db.transitionsAfter([a, b], {});
  assert.deepEqual(all.filter((t) => t.orderId === a).map((t) => t.to), ['reserved', 'payment_pending', 'paid']);
  assert.deepEqual(all.filter((t) => t.orderId === b).map((t) => t.to), ['reserved', 'payment_pending']);
  assert.equal(all[0].from, null); // an order's creation

  const cursors = Object.fromEntries(latest.map((t) => [t.orderId, t.id]));
  assert.deepEqual(await db.transitionsAfter([a, b], cursors), []);
  await db.transition(b, 'payment_pending', 'paid');
  const next = await db.transitionsAfter([a, b], cursors);
  assert.deepEqual(next.map((t) => [t.orderId, t.to]), [[b, 'paid']]);
  assert.ok(next[0].at instanceof Date);
});

test('latestRunOfSession: the newest run of that session, or null', async () => {
  const session = await shop.newSession();
  assert.equal(await db.latestRunOfSession(session), null);
  const insert = () => db.insertRun({ sessionId: session, gameId: shop.gameId, stockTotal: 1, buyersRequested: 2, faults: {}, durationMs: 60_000, maxRunning: 1000 });
  const first = (await insert()).run;
  await db.endRun(first.id, 'stopped');
  const second = (await insert()).run;
  assert.equal((await db.latestRunOfSession(session)).id, second.id);
});
