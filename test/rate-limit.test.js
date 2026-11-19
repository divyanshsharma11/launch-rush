// Request limits: the Redis window counter, the business limiter and the /api wiring, against the real containers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createRateLimiter } from '../src/business/rate-limit.js';
import { createApiRouter } from '../src/controllers/api.js';
import { createErrorHandler, notFound } from '../src/controllers/errors.js';
import { captureLogger, createTestShop } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let shop;
let server;
let base;

before(async () => {
  await redis.ready();
  shop = await createTestShop({ stockTotal: 1 });
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 1 }]);
  const orders = createOrders({
    db, redis, stockGate: createStockGate({ db, redis, config: config.stock, logger }),
    payment: { execute: async () => ({}) }, config, logger,
  });
  const limits = { sessionCreate: { limit: 2, windowMs: 5000 }, session: { limit: 3, windowMs: 5000 } };
  const app = express();
  app.set('trust proxy', true); // so each test can pick its own client IP with X-Forwarded-For
  app.use('/api', createApiRouter({ orders, rateLimiter: createRateLimiter({ redis, limits, logger }), logger }));
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

const call = (path, { method = 'GET', session, ip = '203.0.113.1' } = {}) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: { 'X-Forwarded-For': ip, ...(session && { 'X-Session-Id': session }) },
  });
const randomIp = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

test('the window counter: counts up, reports the time left, and starts over when the window ends', async () => {
  const key = `ratelimit:test:${randomUUID()}`;
  const first = await redis.hit(key, 300);
  const second = await redis.hit(key, 300);
  assert.deepEqual([first.count, second.count], [1, 2]);
  assert.ok(second.resetMs > 0 && second.resetMs <= 300);
  await wait(350);
  assert.equal((await redis.hit(key, 300)).count, 1);
});

test('the limiter allows up to the limit, then refuses with the time left; ids are counted apart', async () => {
  const limiter = createRateLimiter({ redis, limits: { demo: { limit: 3, windowMs: 400 } }, logger });
  const id = randomUUID();
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await limiter.check('demo', id), { allowed: true });
  const refused = await limiter.check('demo', id);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 400);
  assert.deepEqual(await limiter.check('demo', randomUUID()), { allowed: true });
  await wait(450);
  assert.deepEqual(await limiter.check('demo', id), { allowed: true });
});

test('if Redis cannot be reached the request is allowed and the problem is logged', async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const broken = createRedis({ redis: { host: '127.0.0.1', port }, logger });
  const limiter = createRateLimiter({ redis: broken, limits: { demo: { limit: 1, windowMs: 1000 } }, logger });

  assert.deepEqual(await limiter.check('demo', 'x'), { allowed: true });
  assert.deepEqual(await limiter.check('demo', 'x'), { allowed: true });
  assert.ok(lines.some((line) => line.msg === 'rate limiter unavailable, request allowed'));
  await broken.close();
});

test('POST /api/session is limited per client IP: 429 rate_limited with Retry-After', async () => {
  const ip = randomIp();
  for (let i = 0; i < 2; i += 1) {
    const res = await call('/session', { method: 'POST', ip });
    assert.equal(res.status, 201);
    shop.trackSession((await res.json()).sessionId);
  }
  const refused = await call('/session', { method: 'POST', ip });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: { code: 'rate_limited', message: 'too many requests; try again later' } });
  const retryAfter = Number(refused.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 5);

  const other = await call('/session', { method: 'POST', ip: randomIp() });
  assert.equal(other.status, 201);
  shop.trackSession((await other.json()).sessionId);
});

test('every other call is limited per session; a second session and unknown sessions are not affected', async () => {
  const session = await shop.newSession();
  const other = await shop.newSession();
  for (let i = 0; i < 3; i += 1) assert.equal((await call('/games', { session })).status, 200);
  const refused = await call('/games', { session });
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).error.code, 'rate_limited');

  assert.equal((await call('/games', { session: other })).status, 200);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call('/games', { session: randomUUID() })).status, 401, 'unknown sessions are not counted');
  }
});
