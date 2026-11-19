// /api routes over real HTTP, with real PostgreSQL and Redis. The payment connector is a stand-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createApiRouter } from '../src/controllers/api.js';
import { createErrorHandler, notFound } from '../src/controllers/errors.js';
import { captureLogger, createTestShop } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
const payment = { calls: [], async execute(action, payload, ctx) { this.calls.push({ action, payload, ctx }); return {}; } };
const orders = createOrders({ db, redis, stockGate: createStockGate({ db, redis, config: config.stock, logger }), payment, config, logger });
let shop;
let server;
let base;

const call = (path, { method = 'GET', session, body, raw } = {}) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: { ...(session && { 'X-Session-Id': session }), ...((body || raw) && { 'Content-Type': 'application/json' }) },
    body: raw ?? (body && JSON.stringify(body)),
  });

const newSession = async () => {
  const { sessionId } = await (await call('/session', { method: 'POST' })).json();
  shop.trackSession(sessionId);
  return sessionId;
};
const errorOf = async (res) => (await res.json()).error;

before(async () => {
  await redis.ready();
  shop = await createTestShop({ stockTotal: 1 });
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 1 }]);
  const app = express();
  app.use('/api', createApiRouter({ orders, logger }));
  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await redis.deletePool(shopPool(shop.gameId));
  await shop.remove();
  await redis.close();
  await db.close();
});

test('POST /api/session: 201 with a new session id; other routes need it (401 session_required)', async () => {
  const res = await call('/session', { method: 'POST' });
  assert.equal(res.status, 201);
  const { sessionId } = await res.json();
  shop.trackSession(sessionId);
  assert.match(sessionId, /^[0-9a-f-]{36}$/);

  for (const session of [undefined, 'nope', '00000000-0000-4000-8000-000000000000']) {
    const denied = await call('/games', { session });
    assert.equal(denied.status, 401);
    assert.equal((await errorOf(denied)).code, 'session_required');
  }
});

test('GET /api/games: the listed game with its starting stock and live stock', async () => {
  const res = await call('/games', { session: await newSession() });
  assert.equal(res.status, 200);
  const game = (await res.json()).games.find((g) => g.id === shop.gameId);
  assert.deepEqual(game, { id: shop.gameId, title: 'Test Game', priceMinor: 450000, currency: 'INR', stockTotal: 1, stockLeft: 1 });
});

test('Buy, order card, Pay and My orders over HTTP', async () => {
  const session = await newSession();
  const buy = await call('/orders', { method: 'POST', session, body: { gameId: shop.gameId } });
  assert.equal(buy.status, 201);
  const { orderId, state, buyerNumber } = await buy.json();
  assert.deepEqual([state, buyerNumber], ['reserved', 1]);

  const again = await call('/orders', { method: 'POST', session, body: { gameId: shop.gameId } });
  assert.equal(again.status, 409);
  assert.deepEqual(await errorOf(again), { code: 'already_reserved', message: 'an active order already exists', orderId, state: 'reserved' });

  const pay = await call(`/orders/${orderId}/pay`, { method: 'POST', session, body: { email: 'visitor@example.com' } });
  assert.equal(pay.status, 202);
  assert.deepEqual(await pay.json(), { orderId, state: 'payment_pending' });
  assert.equal(payment.calls.at(-1).ctx.idempotencyKey, `charge-${orderId}`);

  const card = await (await call(`/orders/${orderId}`, { session })).json();
  assert.deepEqual([card.orderId, card.state, card.emailStatus], [orderId, 'payment_pending', 'pending']);
  assert.deepEqual((await (await call('/orders', { session })).json()).orders.map((c) => c.orderId), [orderId]);
});

test('sold out: Buy replies 201 waitlisted with the position', async () => {
  const buy = await call('/orders', { method: 'POST', session: await newSession(), body: { gameId: shop.gameId } });
  assert.equal(buy.status, 201);
  const waiting = await buy.json();
  assert.deepEqual([waiting.state, waiting.waitlistPosition], ['waitlisted', 1]);
});

test('error replies: unknown game 404, bad body 400, bad email 400, other session 404, bad id 404, no payment 409', async () => {
  const session = await newSession();
  const other = await newSession();
  const unknown = await call('/orders', { method: 'POST', session, body: { gameId: 'no-such-game' } });
  assert.deepEqual([unknown.status, (await errorOf(unknown)).code], [404, 'unknown_game']);
  const noGame = await call('/orders', { method: 'POST', session, body: {} });
  assert.deepEqual([noGame.status, (await errorOf(noGame)).code], [400, 'invalid_input']);
  const nulGame = await call('/orders', { method: 'POST', session, body: { gameId: 'a\u0000b' } });
  assert.deepEqual([nulGame.status, (await errorOf(nulGame)).code], [400, 'invalid_input']);
  const notObject = await call('/orders', { method: 'POST', session, raw: '[1]' });
  assert.deepEqual([notObject.status, (await errorOf(notObject)).code], [400, 'invalid_input']);

  const { orderId } = await (await call('/orders', { method: 'POST', session: other, body: { gameId: shop.gameId } })).json();
  const foreign = await call(`/orders/${orderId}`, { session });
  assert.deepEqual([foreign.status, (await errorOf(foreign)).code], [404, 'not_found']);
  const badId = await call('/orders/nope', { session });
  assert.deepEqual([badId.status, (await errorOf(badId)).code], [404, 'not_found']);
  const badEmail = await call(`/orders/${orderId}/pay`, { method: 'POST', session: other, body: { email: 'x' } });
  assert.deepEqual([badEmail.status, (await errorOf(badEmail)).code], [400, 'invalid_email']);
  const noPayment = await call(`/orders/${orderId}/resend-webhook`, { method: 'POST', session: other });
  assert.deepEqual([noPayment.status, (await errorOf(noPayment)).code], [409, 'invalid_state']);
});

test('a session id sent in upper case is the same session: its own order is found, not a 404', async () => {
  const session = await newSession();
  const { orderId } = await (await call('/orders', { method: 'POST', session, body: { gameId: shop.gameId } })).json();
  const pay = await call(`/orders/${orderId}/pay`, { method: 'POST', session: session.toUpperCase() });
  assert.ok([202, 409].includes(pay.status), `own order answered ${pay.status}`);
});

test('4xx raised before a route is invalid_input with that status: malformed JSON 400, malformed %-escape 400', async () => {
  const session = await newSession();
  const badJson = await call('/orders', { method: 'POST', session, raw: '{"gameId":' });
  assert.deepEqual([badJson.status, (await errorOf(badJson)).code], [400, 'invalid_input']);
  const badPath = await call('/orders/%E0%A4%A', { session });
  assert.deepEqual([badPath.status, (await errorOf(badPath)).code], [400, 'invalid_input']);
  assert.ok(lines.some((line) => line.msg === 'request rejected' && line.status === 400));
});

test('an unexpected error is 500 internal_error with no details', async () => {
  const broken = createOrders({ db, redis, stockGate: null, payment, config, logger });
  broken.listGames = async () => { throw new Error('boom'); };
  const app = express();
  app.use('/api', createApiRouter({ orders: broken, logger }));
  app.use(createErrorHandler({ logger }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  const session = await db.createSession();
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/games`, { headers: { 'X-Session-Id': session } });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: { code: 'internal_error', message: 'internal error' } });
  await new Promise((resolve) => srv.close(resolve));
  await shop.admin.query('DELETE FROM sessions WHERE id = $1', [session]);
});
