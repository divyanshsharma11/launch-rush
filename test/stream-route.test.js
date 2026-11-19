// GET /api/stream over real HTTP (design §8.1, §8.2): status codes, headers, the wire format, the per-session cap and
// the shutdown of open streams.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createWakeups } from '../src/services/redis/wakeups.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createStream } from '../src/business/stream.js';
import { createApiRouter } from '../src/controllers/api.js';
import { createStreamRouter } from '../src/controllers/stream.js';
import { createErrorHandler, notFound } from '../src/controllers/errors.js';
import { captureLogger, createTestShop } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger, lines } = captureLogger();
const redis = createRedis({ redis: config.redis, logger });
const db = createDb({ logger, onOrderChange: (orderId, sessionId) => redis.notifyOrder(orderId, sessionId) });
const wakeups = createWakeups({ redis: config.redis, logger });
const streamConfig = { ...config.stream, pingMs: 60, maxPerSession: 2 };
const payment = { async execute() { return {}; } };
let shop;
let streamRouter;
let server;
let base;
const controllers = [];

before(async () => {
  await redis.ready();
  await wakeups.ready();
  shop = await createTestShop({ stockTotal: 1 });
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 1 }]);
  const orders = createOrders({ db, redis, stockGate: createStockGate({ db, redis, config: config.stock, logger }), payment, config, logger });
  const reconciler = createReconciler({ db, redis, config: config.reconciler });
  const stream = createStream({ db, redis, wakeups, reconciler, config: streamConfig, logger });
  streamRouter = createStreamRouter({ orders, stream, config: streamConfig, logger });
  const app = express();
  app.use('/api', createApiRouter({ orders, cors: config.cors, streamRouter, logger }));
  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  controllers.forEach((controller) => controller.abort());
  await new Promise((resolve) => setTimeout(resolve, 50));
  streamRouter.endAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await redis.deletePool(shopPool(shop.gameId));
  await shop.remove();
  await wakeups.close();
  await redis.close();
  await db.close();
});

const newSession = async () => {
  const { sessionId } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
  shop.trackSession(sessionId);
  return sessionId;
};

// Opens the stream; read(until) collects text until the condition holds.
async function connect(sessionId) {
  const controller = new AbortController();
  controllers.push(controller);
  const res = await fetch(`${base}/api/stream?session=${sessionId}`, { signal: controller.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    res,
    abort: () => controller.abort(),
    async read(until) {
      for (const stop = Date.now() + 5000; Date.now() < stop && !until(text);) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      assert.ok(until(text), `not reached: ${JSON.stringify(text)}`);
      return text;
    },
    // Reads until the server ends the stream.
    async ended() {
      const timeout = setTimeout(() => controller.abort(), 3000);
      for (;;) {
        const { done } = await reader.read();
        if (done) return clearTimeout(timeout);
      }
    },
  };
}

test('unknown or missing session: 401 session_required as JSON, with the CORS origin', async () => {
  for (const query of ['', '?session=nope', `?session=${randomUUID()}`]) {
    const res = await fetch(`${base}/api/stream${query}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'session_required');
    assert.equal(res.headers.get('access-control-allow-origin'), config.cors.allowedOrigin);
  }
});

test('headers and wire format: retry first, then named events with one JSON data line, then ping comments', async () => {
  const session = await newSession();
  const id = randomUUID();
  await db.insertOrder({ id, sessionId: session, gameId: shop.gameId, state: 'reserved', holdMs: 300_000 });

  const view = await connect(session);
  assert.equal(view.res.status, 200);
  assert.match(view.res.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(view.res.headers.get('cache-control'), 'no-cache');
  assert.equal(view.res.headers.get('x-accel-buffering'), 'no');
  assert.equal(view.res.headers.get('access-control-allow-origin'), config.cors.allowedOrigin);

  const text = await view.read((t) => t.includes('event: order.state') && t.includes(': ping'));
  assert.ok(text.startsWith('retry: 3000\n\n'));
  const frame = text.split('\n\n').find((f) => f.startsWith('event: order.state'));
  const [eventLine, dataLine] = frame.split('\n');
  assert.equal(eventLine, 'event: order.state');
  assert.equal(dataLine.startsWith('data: '), true);
  assert.deepEqual(JSON.parse(dataLine.slice(6)).orderId, id);
  assert.ok(!text.includes('\nid:'), 'events carry no id (design §8.2)');
  view.abort();
});

test('at most maxPerSession streams per session: the next is 429 with Retry-After; closing one frees a place', async () => {
  const session = await newSession();
  const first = await connect(session);
  await connect(session);
  const refused = await fetch(`${base}/api/stream?session=${session}`);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '5');
  assert.equal((await refused.json()).error.code, 'rate_limited');

  first.abort();
  for (const stop = Date.now() + 3000; Date.now() < stop; await new Promise((r) => setTimeout(r, 30))) {
    const again = await fetch(`${base}/api/stream?session=${session}`, { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (again?.status === 200) return again.body.cancel();
  }
  assert.fail('the place was not freed');
});

test('endAll ends every open stream (shutdown), and the session id is not in the logs', async () => {
  const session = await newSession();
  const view = await connect(session);
  await view.read((t) => t.includes('retry:'));
  streamRouter.endAll();
  await view.ended();
  assert.ok(!JSON.stringify(lines).includes(session));
});

test('a client that leaves during the session lookup opens no stream and takes no place', async () => {
  let opened = 0;
  const slow = createStreamRouter({
    orders: { sessionExists: () => new Promise((resolve) => setTimeout(() => resolve(true), 150)) },
    stream: { open: () => (opened += 1, () => {}) },
    config: streamConfig,
    logger,
  });
  const app = express();
  app.use('/api', slow);
  const slowServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => slowServer.once('listening', resolve));
  const url = `http://127.0.0.1:${slowServer.address().port}/api/stream?session=${randomUUID()}`;
  try {
    for (let i = 0; i < streamConfig.maxPerSession + 1; i += 1) {
      await fetch(url, { signal: AbortSignal.timeout(40) }).catch(() => null);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(opened, 0);
    const alive = await fetch(url, { signal: AbortSignal.timeout(1000) });
    assert.equal(alive.status, 200);
    await alive.body.cancel();
  } finally {
    slow.endAll();
    slowServer.closeAllConnections();
    await new Promise((resolve) => slowServer.close(resolve));
  }
});
