// /admin routes over real HTTP, with real PostgreSQL and Redis. The login uses a random test password.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createFulfilmentQueue, createWebhookQueue } from '../src/services/queue/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createAdmin } from '../src/business/admin.js';
import { createAdminAuth, hashPassword } from '../src/business/admin-auth.js';
import { createRateLimiter } from '../src/business/rate-limit.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createReplay } from '../src/business/replay.js';
import { createRestock } from '../src/business/restock.js';
import { createRuns } from '../src/business/runs.js';
import { createAdminRouter } from '../src/controllers/admin.js';
import { createErrorHandler, notFound } from '../src/controllers/errors.js';
import { captureLogger, createTestShop, testQueue } from './helpers.js';

const base = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: base.redis, logger });
const raw = new Redis(base.redis);
const PASSWORD = 'correct horse battery';
const salt = randomBytes(16);
const ttl = 600;
const suffix = randomUUID();
const connectorId = `test-admin-${suffix}`;
const stockGate = createStockGate({ db, redis, config: base.stock, logger });
const reconciler = createReconciler({ db, redis, config: base.reconciler });
let erpDown = false;
const erp = {
  id: 'erp',
  execute: async () => {
    if (erpDown) throw new Error('ERP 503');
    return {};
  },
  healthCheck: async () => true,
};
const runs = createRuns({ db, redis, erp, stockGate, runQueue: { add: async () => {} }, reconciler, config: base, logger });
const servers = [];
const sessionKeys = [];
let fulfilmentQueue;
let webhookQueue;
let fulfilmentTest;
let webhookTest;
let shop;
let auth;
let origin;
let cookie;
let savedFaults;
let savedRush;
let savedBoard;

const allowAll = { check: async () => ({ allowed: true }) };

// An admin router on its own port. The admin origin is that port, so the router is added after listening.
async function serve(rateLimiter = allowAll) {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  const adminOrigin = `http://127.0.0.1:${server.address().port}`;
  app.use('/admin', createAdminRouter({
    auth,
    admin: createAdmin({
      redis,
      connectors: {
        stub: { id: connectorId, healthCheck: async () => true },
        down: { id: `${connectorId}-down`, healthCheck: async () => false },
      },
      queues: { fulfilment: fulfilmentQueue, webhooks: webhookQueue },
      logger,
    }),
    replay: createReplay({ db, fulfilmentQueue, webhookQueue }),
    restock: createRestock({ db, redis, erp, stockGate, config: base, logger }),
    runs,
    rateLimiter,
    origin: adminOrigin,
    sessionTtlSeconds: ttl,
    logger,
  }));
  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  return adminOrigin;
}

const call = (path, { method = 'GET', body, cookieValue = cookie, from = origin, at = origin } = {}) =>
  fetch(`${at}/admin${path}`, {
    method,
    headers: {
      ...(from && { Origin: from }),
      ...(cookieValue && { Cookie: cookieValue }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const codeOf = async (res) => (await res.json()).error.code;
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

before(async () => {
  await redis.ready();
  fulfilmentTest = testQueue(base.redis);
  webhookTest = testQueue(base.redis);
  fulfilmentQueue = createFulfilmentQueue({ redis: base.redis, jobOptions: base.webhookJob, logger, name: fulfilmentTest.name });
  webhookQueue = createWebhookQueue({ redis: base.redis, jobOptions: base.webhookJob, logger, name: webhookTest.name });
  await Promise.all([fulfilmentQueue.ready(), webhookQueue.ready()]);
  shop = await createTestShop({ stockTotal: 3 });
  auth = createAdminAuth({
    admin: { passwordHash: await hashPassword(PASSWORD, salt), passwordSalt: salt, sessionTtlSeconds: ttl },
    redis,
  });
  origin = await serve();
  savedFaults = await raw.get('faults:shared');
  savedRush = await redis.rushEnabled();
  savedBoard = await raw.get('scoreboard:latest');
  const login = await call('/login', { method: 'POST', body: { password: PASSWORD }, cookieValue: null });
  cookie = cookieOf(login);
  sessionKeys.push(`admin:session:${cookie.split('=')[1]}`);
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await redis.setRushEnabled(savedRush);
  await (savedBoard === null ? raw.del('scoreboard:latest') : raw.set('scoreboard:latest', savedBoard));
  await (savedFaults === null ? raw.del('faults:shared') : raw.set('faults:shared', savedFaults));
  const pool = shopPool(shop.gameId);
  await raw.del(...['stock', 'holds', 'waitlist', 'tickets', 'grants', 'buyers', 'receipts'].map((kind) => `${kind}:${pool}`));
  await raw.del(...sessionKeys);
  await fulfilmentQueue.close();
  await webhookQueue.close();
  await fulfilmentTest.cleanup();
  await webhookTest.cleanup();
  await shop.remove();
  raw.disconnect();
  await redis.close();
  await db.close();
});

test('login: 204 with a cookie that is HttpOnly, Secure, SameSite=Strict, Path=/admin and lasts the session time', async () => {
  const res = await call('/login', { method: 'POST', body: { password: PASSWORD }, cookieValue: null });
  assert.equal(res.status, 204);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^admin_session=[A-Za-z0-9_-]{43};/);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/admin', `Max-Age=${ttl}`]) {
    assert.ok(setCookie.includes(part), `${part} in ${setCookie}`);
  }
  sessionKeys.push(`admin:session:${cookieOf(res).split('=')[1]}`);
});

test('login: a wrong, missing or non-string password is 401 bad_credentials, logged without the password', async () => {
  for (const body of [{ password: 'wrong password' }, {}, { password: 5 }]) {
    const res = await call('/login', { method: 'POST', body, cookieValue: null });
    assert.deepEqual([res.status, await codeOf(res), res.headers.get('set-cookie')], [401, 'bad_credentials', null]);
  }
  assert.ok(lines.some((line) => line.msg === 'admin login failed'));
  assert.ok(!JSON.stringify(lines).includes('wrong password'));
});

test('login: a body that is not JSON is 400 invalid_input, and neither the reply nor the log quotes the body', async () => {
  const res = await fetch(`${origin}/admin/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"password":hunter2secret}',
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.equal(JSON.parse(text).error.code, 'invalid_input');
  assert.ok(!text.includes('hunter2'));
  assert.ok(lines.some((line) => line.msg === 'request rejected' && line.url === '/admin/login'));
  assert.ok(!JSON.stringify(lines).includes('hunter2'));
});

test('login is limited per IP: over the limit is 429 rate_limited with Retry-After', async () => {
  // Own counter key, so a login made by another test or a running API in the last minute does not count here.
  const limiter = createRateLimiter({ redis, limits: { adminLogin: { limit: 2, windowMs: 60_000 } }, logger });
  const limited = await serve({ check: (scope, id) => limiter.check(scope, `${suffix}:${id}`) });
  try {
    for (let i = 0; i < 3; i += 1) {
      const crossSite = await call('/login', { method: 'POST', body: { password: 'x' }, cookieValue: null, at: limited, from: 'https://evil.example' });
      assert.equal(crossSite.status, 403); // refused before the limiter: it uses up no attempt
    }
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await call('/login', { method: 'POST', body: { password: 'wrong password' }, cookieValue: null, at: limited, from: limited });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.equal(await codeOf(res), 'rate_limited');
        assert.ok(Number(res.headers.get('retry-after')) >= 1);
      }
    }
    assert.deepEqual(statuses, [401, 401, 429]);
  } finally {
    const own = await raw.keys(`ratelimit:adminLogin:${suffix}:*`);
    if (own.length) await raw.del(...own);
  }
});

test('a POST or PUT without the backend Origin is 403 bad_origin; GET needs no Origin', async () => {
  for (const from of [null, 'null', 'https://evil.example', `${origin}/`]) {
    const post = await call('/login', { method: 'POST', body: { password: PASSWORD }, from, cookieValue: null });
    assert.deepEqual([post.status, await codeOf(post)], [403, 'bad_origin']);
    const put = await call('/rush', { method: 'PUT', body: { enabled: true }, from });
    assert.deepEqual([put.status, await codeOf(put)], [403, 'bad_origin']);
  }
  assert.equal((await call('/health', { from: null })).status, 200);
});

test('without a valid session every route except login is 401 admin_required', async () => {
  const bogus = `admin_session=${randomBytes(32).toString('base64url')}`;
  const routes = [
    ['/logout', 'POST'], ['/health', 'GET'], ['/scoreboard', 'GET'], ['/deliveries?status=failed', 'GET'], [`/deliveries/${randomUUID()}/replay`, 'POST'],
    ['/stock/reset', 'POST'], ['/rush', 'PUT'], ['/erp-sim/faults', 'PUT'],
  ];
  for (const cookieValue of [null, bogus, 'admin_session=x']) {
    for (const [path, method] of routes) {
      const res = await call(path, { method, body: method === 'GET' ? undefined : {}, cookieValue });
      assert.deepEqual([path, res.status, await codeOf(res)], [path, 401, 'admin_required']);
    }
  }
});

test('health: each connector with its check and breaker state, and every queue with its counts', async () => {
  const fields = [`${connectorId}-down:shared`, `${connectorId}:${randomUUID()}`];
  await redis.setBreakerState({ connector: `${connectorId}-down`, runId: null, state: 'open' });
  await redis.setBreakerState({ connector: connectorId, runId: fields[1].split(':')[1], state: 'open' }); // a run's breaker: not shown
  try {
    const res = await call('/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { connectors, queues } = await res.json();
    assert.deepEqual(connectors, [
      { id: connectorId, healthy: true, breaker: 'closed' },
      { id: `${connectorId}-down`, healthy: false, breaker: 'open' },
    ]);
    assert.deepEqual(Object.keys(queues), ['fulfilment', 'webhooks']);
    const settings = await call('/health').then((r) => r.json());
    assert.equal(typeof settings.rushEnabled, 'boolean');
    assert.deepEqual(Object.keys(settings.erpFaults).sort(), ['down', 'failureRate', 'latencyMs', 'rateLimitPerSec']);
    for (const counts of Object.values(queues)) {
      assert.deepEqual(Object.keys(counts).sort(), ['active', 'delayed', 'failed', 'waiting']);
    }
  } finally {
    await raw.hdel('breakers', ...fields);
  }
});

// A failed fulfilment delivery for a test order: paid -> failed, as the worker leaves it after the last attempt.
async function failedDelivery() {
  const sessionId = await shop.newSession();
  const order = await db.insertOrder({ id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', holdMs: 300_000 });
  await db.transition(order.id, 'reserved', 'payment_pending');
  await db.transition(order.id, 'payment_pending', 'paid');
  await db.transition(order.id, 'paid', 'failed');
  const { rows } = await shop.admin.query(
    `INSERT INTO deliveries (order_id, connector, action, status, attempts, last_error)
     VALUES ($1, 'erp-sim', 'sales_order.submit', 'failed', 5, 'ERP 503') RETURNING id`, [order.id],
  );
  return { orderId: order.id, deliveryId: rows[0].id };
}

test('deliveries: only status=failed is listed; any other status is 400', async () => {
  const { orderId, deliveryId } = await failedDelivery();
  const res = await call('/deliveries?status=failed');
  assert.equal(res.status, 200);
  const { deliveries } = await res.json();
  assert.deepEqual(deliveries.find((d) => d.id === deliveryId),
    { id: deliveryId, orderId, connector: 'erp-sim', action: 'sales_order.submit', attempts: 5, lastError: 'ERP 503' });
  assert.equal((await call('/deliveries')).status, 200);
  const other = await call('/deliveries?status=pending');
  assert.deepEqual([other.status, await codeOf(other)], [400, 'invalid_input']);
});

test('replay: 202 reopens the delivery, the order goes back to paid and the job is queued; a second click is 409', async () => {
  const { orderId, deliveryId } = await failedDelivery();
  const res = await call(`/deliveries/${deliveryId}/replay`, { method: 'POST' });
  assert.equal(res.status, 202);
  assert.equal((await db.getOrder(orderId)).state, 'paid');
  assert.equal((await shop.admin.query('SELECT status FROM deliveries WHERE id = $1', [deliveryId])).rows[0].status, 'pending');
  assert.ok(await fulfilmentQueue.find(orderId), 'fulfilment job exists');
  const again = await call(`/deliveries/${deliveryId}/replay`, { method: 'POST' });
  assert.deepEqual([again.status, await codeOf(again)], [409, 'invalid_state']);
});

test('replay: an unknown or malformed id is 404 not_found', async () => {
  for (const id of [randomUUID(), 'nope']) {
    const res = await call(`/deliveries/${id}/replay`, { method: 'POST' });
    assert.deepEqual([res.status, await codeOf(res)], [404, 'not_found']);
  }
});

test('stock reset: refills one game up to its starting level (202 with what was added); bad input is 400', async () => {
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 3 }]);
  await redis.buy(shopPool(shop.gameId), randomUUID());
  assert.deepEqual(await redis.stockLeft([shopPool(shop.gameId)]), [2]);

  const res = await call('/stock/reset', { method: 'POST', body: { gameId: shop.gameId } });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { refilled: [{ gameId: shop.gameId, qty: 1 }] });
  assert.deepEqual(await redis.stockLeft([shopPool(shop.gameId)]), [3]);

  const full = await call('/stock/reset', { method: 'POST', body: { gameId: shop.gameId } });
  assert.deepEqual(await full.json(), { refilled: [] });
  for (const body of [{ gameId: 'no-such-game' }, { gameId: 5 }]) {
    const bad = await call('/stock/reset', { method: 'POST', body });
    assert.deepEqual([bad.status, await codeOf(bad)], [400, 'invalid_input']);
  }
});

test('stock reset while the ERP is down: 500, the receipt stays recorded for the worker to finish, Redis is untouched', async () => {
  await redis.buy(shopPool(shop.gameId), randomUUID());
  const before = await redis.stockLeft([shopPool(shop.gameId)]);
  erpDown = true;
  try {
    const res = await call('/stock/reset', { method: 'POST', body: { gameId: shop.gameId } });
    assert.deepEqual([res.status, await codeOf(res)], [500, 'internal_error']);
  } finally {
    erpDown = false;
  }
  assert.deepEqual(await redis.stockLeft([shopPool(shop.gameId)]), before);
  const { rows } = await shop.admin.query(
    "SELECT qty, erp_applied_at, redis_applied_at FROM stock_receipts WHERE game_id = $1 AND dedupe_key LIKE 'admin:%' ORDER BY created_at DESC LIMIT 1",
    [shop.gameId],
  );
  assert.deepEqual([rows[0].qty, rows[0].erp_applied_at, rows[0].redis_applied_at], [1, null, null]);
});

test('rush kill switch: 204 turns it off and on; anything but true or false is 400', async () => {
  const off = await call('/rush', { method: 'PUT', body: { enabled: false } });
  assert.equal(off.status, 204);
  assert.equal(await redis.rushEnabled(), false);
  const on = await call('/rush', { method: 'PUT', body: { enabled: true } });
  assert.equal(on.status, 204);
  assert.equal(await redis.rushEnabled(), true);
  for (const body of [{}, { enabled: 'no' }, { enabled: 0 }]) {
    const bad = await call('/rush', { method: 'PUT', body });
    assert.deepEqual([bad.status, await codeOf(bad)], [400, 'invalid_input']);
  }
});

test('scoreboard: the reconciler result as stored, or null before its first pass', async () => {
  await raw.del('scoreboard:latest');
  assert.deepEqual(await (await call('/scoreboard')).json(), { scoreboard: null });
  const board = { sold: 7, stock: 10, oversold: 0, lost: 0, checkedAt: '2026-11-16T10:00:00.000Z' };
  await raw.set('scoreboard:latest', JSON.stringify(board));
  assert.deepEqual(await (await call('/scoreboard')).json(), { scoreboard: board });
});

test('health shows every fault off when none were ever set', async () => {
  await raw.del('faults:shared');
  assert.deepEqual((await (await call('/health')).json()).erpFaults, { latencyMs: 0, down: false, rateLimitPerSec: 0, failureRate: 0 });
});

test('health shows the kill switch and the shop ERP faults as set now', async () => {
  await call('/rush', { method: 'PUT', body: { enabled: false } });
  await call('/erp-sim/faults', { method: 'PUT', body: { down: true, latencyMs: 40 } });
  const health = await (await call('/health')).json();
  assert.equal(health.rushEnabled, false);
  assert.deepEqual(health.erpFaults, { latencyMs: 40, down: true, rateLimitPerSec: 0, failureRate: 0 });
  await call('/rush', { method: 'PUT', body: { enabled: true } });
  await call('/erp-sim/faults', { method: 'PUT', body: {} });
  const clear = await (await call('/health')).json();
  assert.equal(clear.rushEnabled, true);
  assert.equal(clear.erpFaults.down, false);
});

test('ERP faults for the shop: 204 stores them for the simulator; {} clears them; bad values are 400', async () => {
  const set = await call('/erp-sim/faults', { method: 'PUT', body: { latencyMs: 250, down: true, rateLimitPerSec: 5, failureRate: 0.5 } });
  assert.equal(set.status, 204);
  assert.deepEqual(JSON.parse(await raw.get('faults:shared')), { latencyMs: 250, down: true, rateLimitPerSec: 5, failureRate: 0.5 });
  const clear = await call('/erp-sim/faults', { method: 'PUT', body: {} });
  assert.equal(clear.status, 204);
  assert.deepEqual(JSON.parse(await raw.get('faults:shared')), { latencyMs: 0, down: false, rateLimitPerSec: 0, failureRate: 0 });
  for (const body of [{ latencyMs: -1 }, { down: 'yes' }, { failureRate: 2 }, { bogus: 1 }, []]) {
    const bad = await call('/erp-sim/faults', { method: 'PUT', body });
    assert.deepEqual([bad.status, await codeOf(bad)], [400, 'invalid_input']);
  }
});

test('logout: 204 clears the cookie and the session no longer works', async () => {
  const login = await call('/login', { method: 'POST', body: { password: PASSWORD }, cookieValue: null });
  const own = cookieOf(login);
  assert.equal((await call('/health', { cookieValue: own })).status, 200);
  assert.equal((await call('/health', { cookieValue: `theme=dark; ${own}; other=1` })).status, 200); // among other cookies
  const out = await call('/logout', { method: 'POST', cookieValue: own });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /^admin_session=;.*Path=\/admin/);
  const after = await call('/health', { cookieValue: own });
  assert.deepEqual([after.status, await codeOf(after)], [401, 'admin_required']);
});
