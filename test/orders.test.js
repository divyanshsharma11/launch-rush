// Storefront rules (Buy, Pay, cards, Duplicate resend) against the real PostgreSQL and Redis containers.
// The payment connector is a recording stand-in passed in (no module mocking); the real one is covered elsewhere.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, runPool, shopPool } from '../src/services/redis/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { captureLogger, createTestShop, paymentEvent } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
const stockGate = createStockGate({ db, redis, config: config.stock, logger });
const calls = [];
const payment = {
  failNext: false,
  async execute(action, payload, ctx) {
    calls.push({ action, payload, ctx });
    if (this.failNext) throw new Error('provider down');
    return {};
  },
};
const orders = createOrders({ db, redis, stockGate, payment, config, logger });
const pools = [];
let shop;

const rejectsWith = (promise, code, fields) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.code, code);
    if (fields) assert.deepEqual(err.fields, fields);
    return true;
  });

async function newShop(stockTotal) {
  if (shop) await shop.remove();
  shop = await createTestShop({ stockTotal });
  pools.push(shopPool(shop.gameId));
  await redis.initShopStock([{ id: shop.gameId, stockTotal }]);
}

async function newRun({ sessionId, stockTotal = 1, endsInMs = 60_000, status = 'running' }) {
  const { rows } = await shop.admin.query(
    `INSERT INTO demo_runs (session_id, game_id, stock_total, buyers_requested, status, ends_at)
     VALUES ($1, $2, $3, 0, $4, now() + $5::integer * interval '1 millisecond') RETURNING id`,
    [sessionId, shop.gameId, stockTotal, status, endsInMs],
  );
  pools.push(runPool(rows[0].id));
  await redis.initRunStock(rows[0].id, stockTotal);
  return rows[0].id;
}

before(() => redis.ready());

beforeEach(async () => {
  calls.length = 0;
  payment.failNext = false;
  await newShop(1);
});

after(async () => {
  for (const pool of pools) await redis.deletePool(pool);
  await shop.remove();
  await redis.close();
  await db.close();
});

test('catalog: listed games with price and live stock from Redis', async () => {
  const game = (await orders.listGames()).find((g) => g.id === shop.gameId);
  assert.deepEqual(game, { id: shop.gameId, title: 'Test Game', priceMinor: 450000, currency: 'INR', stockTotal: 1, stockLeft: 1 });
});

test('buy: reserved with hold time and buyer number; sold out joins the waitlist with a position', async () => {
  const first = await orders.buy(await shop.newSession(), { gameId: shop.gameId });
  assert.equal(first.state, 'reserved');
  assert.equal(first.buyerNumber, 1);
  assert.ok(first.reservedUntil instanceof Date);

  const second = await orders.buy(await shop.newSession(), { gameId: shop.gameId });
  assert.deepEqual(Object.keys(second), ['orderId', 'state', 'waitlistPosition', 'waitlistUntil']);
  assert.equal(second.waitlistPosition, 1);
  assert.equal((await orders.buy(await shop.newSession(), { gameId: shop.gameId })).waitlistPosition, 2);
});

test('second Buy of the same game by the same session: 409 with the first order; the copy is given back', async () => {
  await newShop(2);
  const sessionId = await shop.newSession();
  const first = await orders.buy(sessionId, { gameId: shop.gameId });
  await rejectsWith(orders.buy(sessionId, { gameId: shop.gameId }), 'already_reserved', { orderId: first.orderId, state: 'reserved' });
  assert.deepEqual(await redis.stockLeft([shopPool(shop.gameId)]), [1]);
  const { rows } = await shop.admin.query('SELECT kind FROM duplicates_blocked WHERE order_id = $1', [first.orderId]);
  assert.deepEqual(rows, [{ kind: 'buy' }]);
});

test('buy input errors: unknown game, bad body, unknown or foreign run', async () => {
  const sessionId = await shop.newSession();
  await rejectsWith(orders.buy(sessionId, { gameId: 'no-such-game' }), 'unknown_game');
  await rejectsWith(orders.buy(sessionId, {}), 'invalid_input');
  await rejectsWith(orders.buy(sessionId, { gameId: 'a\u0000b' }), 'invalid_input');
  await rejectsWith(orders.buy(sessionId, { gameId: shop.gameId, runId: 'abc' }), 'invalid_input');
  await rejectsWith(orders.buy(sessionId, { gameId: shop.gameId, runId: randomUUID() }), 'not_found');
  const foreignRun = await newRun({ sessionId: await shop.newSession() });
  await rejectsWith(orders.buy(sessionId, { gameId: shop.gameId, runId: foreignRun }), 'not_found');
});

test('buy with Redis unreachable: unavailable, and no order is created', async () => {
  const down = createRedis({ redis: { host: '127.0.0.1', port: 1 }, logger });
  const offline = createOrders({ db, redis: down, stockGate, payment, config, logger });
  const sessionId = await shop.newSession();
  await rejectsWith(offline.buy(sessionId, { gameId: shop.gameId }), 'unavailable');
  assert.deepEqual(await orders.listOrders(sessionId), []);
  await down.close();
});

test('run buy: competes in the run pool; one active order per buyer; wrong game, ended run', async () => {
  const sessionId = await shop.newSession();
  const runId = await newRun({ sessionId });
  const first = await orders.buy(sessionId, { gameId: shop.gameId, runId });
  assert.equal(first.state, 'reserved');
  assert.deepEqual(await redis.stockLeft([shopPool(shop.gameId), runPool(runId)]), [1, 0]);
  const saved = await db.getOrder(first.orderId);
  assert.deepEqual([saved.runId, saved.buyerRef, saved.isSimulated], [runId, sessionId, false]);
  const { rows: [{ now }] } = await shop.admin.query('SELECT now() AS now'); // reserved_until comes from the database clock
  assert.ok(saved.reservedUntil - now <= config.stock.runHoldMs);
  await rejectsWith(orders.buy(sessionId, { gameId: shop.gameId, runId }), 'already_reserved', { orderId: first.orderId, state: 'reserved' });

  const ended = await newRun({ sessionId: await shop.newSession(), status: 'finished' });
  const { rows } = await shop.admin.query('SELECT session_id FROM demo_runs WHERE id = $1', [ended]);
  await rejectsWith(orders.buy(rows[0].session_id, { gameId: shop.gameId, runId: ended }), 'run_ended');

  await shop.admin.query(`INSERT INTO games (id, title, price_minor, currency, stock_total, listed_in_shop)
    VALUES ($1, 'Other', 1, 'INR', 1, true)`, [`${shop.gameId}-x`]);
  await rejectsWith(orders.buy(sessionId, { gameId: `${shop.gameId}-x`, runId }), 'invalid_input');
  await shop.admin.query('DELETE FROM games WHERE id = $1', [`${shop.gameId}-x`]);
});

test('pay: reserved -> payment_pending, email saved, charge sent with charge-<orderId>; a repeat re-sends it', async () => {
  const sessionId = await shop.newSession();
  const { orderId } = await orders.buy(sessionId, { gameId: shop.gameId });
  assert.deepEqual(await orders.pay(sessionId, orderId, { email: 'visitor@example.com' }), { orderId, state: 'payment_pending' });
  assert.deepEqual(calls[0].payload, { orderId, amountMinor: 450000, currency: 'INR' });
  assert.deepEqual(
    { key: calls[0].ctx.idempotencyKey, runId: calls[0].ctx.runId, timeoutMs: calls[0].ctx.timeoutMs },
    { key: `charge-${orderId}`, runId: null, timeoutMs: config.payment.callTimeoutMs },
  );

  await orders.pay(sessionId, orderId, { email: 'other@example.com' });
  assert.equal(calls[1].ctx.idempotencyKey, `charge-${orderId}`);
  const { rows } = await shop.admin.query('SELECT buyer_email FROM orders WHERE id = $1', [orderId]);
  assert.equal(rows[0].buyer_email, 'visitor@example.com');
});

test('pay errors: invalid email, other session, malformed id, waitlisted order, provider down', async () => {
  const sessionId = await shop.newSession();
  const { orderId } = await orders.buy(sessionId, { gameId: shop.gameId });
  await rejectsWith(orders.pay(sessionId, orderId, { email: 'not an email' }), 'invalid_email');
  await rejectsWith(orders.pay(sessionId, orderId, { email: 5 }), 'invalid_email');
  await rejectsWith(orders.pay(await shop.newSession(), orderId), 'not_found');
  await rejectsWith(orders.pay(sessionId, 'nope'), 'not_found');

  const waiter = await shop.newSession();
  const waiting = await orders.buy(waiter, { gameId: shop.gameId });
  await rejectsWith(orders.pay(waiter, waiting.orderId), 'invalid_state', { state: 'waitlisted' });

  payment.failNext = true;
  await rejectsWith(orders.pay(sessionId, orderId), 'payment_unavailable');
  assert.equal((await db.getOrder(orderId)).state, 'payment_pending');
  assert.equal(calls.length, 1);
});

test('order cards: own orders only; a waitlisted card has its live position', async () => {
  const holder = await shop.newSession();
  const waiter = await shop.newSession();
  const held = await orders.buy(holder, { gameId: shop.gameId });
  const waiting = await orders.buy(waiter, { gameId: shop.gameId });

  const card = await orders.getOrder(holder, held.orderId);
  assert.deepEqual(Object.keys(card), ['orderId', 'gameId', 'state', 'invoiceNo', 'emailStatus', 'reservedUntil']);
  const waitCard = await orders.getOrder(waiter, waiting.orderId);
  assert.equal(waitCard.waitlistPosition, 1);
  assert.ok(waitCard.waitlistUntil instanceof Date);
  await rejectsWith(orders.getOrder(waiter, held.orderId), 'not_found');
  assert.deepEqual((await orders.listOrders(waiter)).map((c) => c.orderId), [waiting.orderId]);
});

test('Duplicate resend: needs a stored payment; then asks the provider for the same payment', async () => {
  const sessionId = await shop.newSession();
  const { orderId } = await orders.buy(sessionId, { gameId: shop.gameId });
  await rejectsWith(orders.resendWebhook(sessionId, orderId), 'invalid_state', { state: 'reserved' });

  await db.insertPaymentEvent(paymentEvent(`evt_${randomUUID()}`, orderId));
  await orders.resendWebhook(sessionId, orderId);
  assert.deepEqual([calls[0].action, calls[0].payload], ['resend_webhook', { paymentId: 'pay_test' }]);
  await rejectsWith(orders.resendWebhook(await shop.newSession(), orderId), 'not_found');
});

test('sessions: a malformed or unknown id does not exist', async () => {
  assert.equal(await orders.sessionExists('nope'), false);
  assert.equal(await orders.sessionExists(randomUUID()), false);
  assert.equal(await orders.sessionExists(await shop.newSession()), true);
});
