// /api/runs routes over real HTTP, with real PostgreSQL and Redis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis } from '../src/services/redis/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createRuns } from '../src/business/runs.js';
import { createApiRouter } from '../src/controllers/api.js';
import { createErrorHandler, notFound } from '../src/controllers/errors.js';
import { captureLogger, createTestShop } from './helpers.js';

const base = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const config = { ...base, runs: { ...base.runs, maxRunning: 1000 } };
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
const stockGate = createStockGate({ db, redis, config: config.stock, logger });
const orders = createOrders({ db, redis, stockGate, payment: {}, config, logger });
const reconciler = createReconciler({ db, redis, config: config.reconciler });
const runs = createRuns({ db, redis, erp: { execute: async () => ({}) }, stockGate, runQueue: { add: async () => {} }, reconciler, config, logger });
const runIds = [];
let shop;
let server;
let origin;

const call = (path, { method = 'GET', session, body } = {}) =>
  fetch(`${origin}/api${path}`, {
    method,
    headers: { 'X-Session-Id': session, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
const startRun = async (session, extra) => {
  const res = await call('/runs', { method: 'POST', session, body: { gameId: shop.gameId, buyers: 5, stock: 2, ...extra } });
  if (res.status === 201) runIds.push((await res.clone().json()).runId);
  return res;
};
const codeOf = async (res) => (await res.json()).error.code;

before(async () => {
  await redis.ready();
  shop = await createTestShop({ stockTotal: 3 });
  const app = express();
  app.use('/api', createApiRouter({ orders, runs, logger }));
  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const id of runIds) await redis.deleteRun(id);
  await shop.remove();
  await redis.close();
  await db.close();
});

test('start 201 with runId and endsAt; a second start for the session is 409 run_active', async () => {
  const session = await shop.newSession();
  const res = await startRun(session);
  assert.equal(res.status, 201);
  const { runId, endsAt } = await res.json();
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(endsAt) > Date.now());
  const again = await startRun(session);
  assert.deepEqual([again.status, await codeOf(again)], [409, 'run_active']);
});

test('start errors: unknown game 404, bad input 400, kill switch 503', async () => {
  const session = await shop.newSession();
  const unknown = await startRun(session, { gameId: 'no-such-game' });
  assert.deepEqual([unknown.status, await codeOf(unknown)], [404, 'unknown_game']);
  const invalid = await startRun(session, { stock: 9 });
  assert.deepEqual([invalid.status, await codeOf(invalid)], [400, 'invalid_input']);

  await runs.setRushEnabled(false);
  const off = await startRun(session);
  assert.deepEqual([off.status, await codeOf(off)], [503, 'rush_disabled']);
  await runs.setRushEnabled(true);
});

test('summary, faults and stop for the own run; other sessions and bad ids get 404', async () => {
  const session = await shop.newSession();
  const { runId } = await (await startRun(session)).json();

  const summary = await call(`/runs/${runId}`, { session });
  assert.equal(summary.status, 200);
  assert.deepEqual(
    (({ runId: id, status, sold, stockTotal, oversold }) => ({ id, status, sold, stockTotal, oversold }))(await summary.json()),
    { id: runId, status: 'running', sold: 0, stockTotal: 2, oversold: 0 },
  );

  const faults = await call(`/runs/${runId}/faults`, { method: 'PUT', session, body: { down: true } });
  assert.equal(faults.status, 204);
  const badFaults = await call(`/runs/${runId}/faults`, { method: 'PUT', session, body: { latencyMs: -5 } });
  assert.deepEqual([badFaults.status, await codeOf(badFaults)], [400, 'invalid_input']);

  const other = await shop.newSession();
  assert.equal((await call(`/runs/${runId}`, { session: other })).status, 404);
  assert.equal((await call('/runs/nope', { session })).status, 404);

  assert.equal((await call(`/runs/${runId}/stop`, { method: 'POST', session })).status, 204);
  const ended = await call(`/runs/${runId}/faults`, { method: 'PUT', session, body: { down: false } });
  assert.deepEqual([ended.status, await codeOf(ended)], [409, 'run_ended']);
});
