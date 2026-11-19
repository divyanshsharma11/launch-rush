// Demo runs: start, caps, faults, stop, kill switch, closing and cleanup, against real PostgreSQL and Redis.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, runPool } from '../src/services/redis/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createRuns } from '../src/business/runs.js';
import { captureLogger, createTestShop } from './helpers.js';

const base = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const config = { ...base, runs: { ...base.runs, maxRunning: 2 } };
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
const stockGate = createStockGate({ db, redis, config: config.stock, logger });
const reconciler = createReconciler({ db, redis, config: config.reconciler });
const queued = [];
const erpCalls = [];
let erpFailing = new Set();
const erp = {
  execute: async (action, payload) => {
    erpCalls.push({ action, payload });
    if (erpFailing.has(action)) throw new Error('ERP unreachable');
    return {};
  },
};
const runs = createRuns({ db, redis, erp, stockGate, runQueue: { add: async (id) => queued.push(id) }, reconciler, config, logger });
const runIds = [];
let shop;

const body = (extra = {}) => ({ gameId: shop.gameId, buyers: 10, stock: 3, ...extra });
const start = async (sessionId, extra) => {
  const { runId } = await runs.start(sessionId, body(extra));
  runIds.push(runId);
  return runId;
};
const rejectsWith = (promise, code) => assert.rejects(promise, (err) => err.code === code);
const statusOf = async (runId) => (await db.getRun(runId)).status;

before(() => redis.ready());

beforeEach(async () => {
  queued.length = 0;
  erpCalls.length = 0;
  erpFailing = new Set();
  if (shop) await shop.remove();
  for (const id of runIds.splice(0)) await redis.deleteRun(id);
  shop = await createTestShop({ stockTotal: 5 });
});

after(async () => {
  await redis.setRushEnabled(true);
  for (const id of runIds) await redis.deleteRun(id);
  await shop.remove();
  await redis.close();
  await db.close();
});

test('start: run row, Redis stock and faults, a queued job and its end time', async () => {
  const sessionId = await shop.newSession();
  const before = Date.now();
  const { runId, endsAt } = await runs.start(sessionId, body({ faults: { latencyMs: 200, down: true } }));
  runIds.push(runId);

  const run = await db.getRun(runId);
  assert.deepEqual(
    { status: run.status, stockTotal: run.stockTotal, buyers: run.buyersRequested, faults: run.faults },
    { status: 'running', stockTotal: 3, buyers: 10, faults: { latencyMs: 200, down: true, rateLimitPerSec: 0, failureRate: 0 } },
  );
  assert.ok(Math.abs(endsAt.getTime() - before - config.runs.maxDurationMs) < 3000);
  assert.deepEqual(await redis.stockLeft([runPool(runId)]), [3]);
  assert.deepEqual(queued, [runId]);
  assert.deepEqual(erpCalls, [{ action: 'stock.add', payload: { receiptId: `run-${runId}`, itemCode: shop.gameId, qty: 3, runId } }]);
});

test('start with no stock adds nothing in the ERP', async () => {
  await start(await shop.newSession(), { buyers: 0, stock: 0 });
  assert.deepEqual(erpCalls, []);
});

test('start when the ERP is unreachable: the run ends as stopped and the caller gets unavailable', async () => {
  const sessionId = await shop.newSession();
  erpFailing.add('stock.add');
  await rejectsWith(runs.start(sessionId, body()), 'unavailable');
  assert.deepEqual(queued, []);
  const { rows } = await shop.admin.query('SELECT id FROM demo_runs WHERE session_id = $1', [sessionId]);
  runIds.push(...rows.map((r) => r.id)); // its Redis keys stay until cleanup
  assert.equal((await db.listRunningRuns()).filter((r) => r.sessionId === sessionId).length, 0);
  erpFailing.clear();
  await start(sessionId);
});

test('start input errors: bad numbers, unknown or out-of-range faults, missing or unknown game', async () => {
  const sessionId = await shop.newSession();
  const bad = [
    { gameId: undefined },
    { gameId: 'a\u0000b' },
    { buyers: config.runs.maxBuyers + 1 },
    { buyers: 2.5 },
    { buyers: -1 },
    { stock: 11 },
    { stock: '3' },
    { faults: [] },
    { faults: { latency: 5 } },
    { faults: { down: 'yes' } },
    { faults: { latencyMs: 10_001 } },
    { faults: { latencyMs: 1.5 } },
    { faults: { failureRate: 1.5 } },
    { faults: { rateLimitPerSec: -1 } },
  ];
  for (const extra of bad) await rejectsWith(runs.start(sessionId, body(extra)), 'invalid_input');
  await rejectsWith(runs.start(sessionId, body({ gameId: 'no-such-game' })), 'unknown_game');
  assert.equal(await db.listRunningRuns().then((list) => list.filter((r) => r.sessionId === sessionId).length), 0);
});

test('a faults-only run (no buyers, no stock) is allowed; fractional failureRate is allowed', async () => {
  const runId = await start(await shop.newSession(), { buyers: 0, stock: 0, faults: { failureRate: 0.25 } });
  assert.equal(await statusOf(runId), 'running');
});

test('one run per session, and at most maxRunning runs at once', async () => {
  const [a, b, c] = [await shop.newSession(), await shop.newSession(), await shop.newSession()];
  await start(a);
  await rejectsWith(runs.start(a, body()), 'run_active');
  await start(b);
  await rejectsWith(runs.start(c, body()), 'runs_busy');
  const results = await Promise.allSettled([runs.start(await shop.newSession(), body()), runs.start(await shop.newSession(), body())]);
  assert.deepEqual(results.map((r) => r.reason.code), ['runs_busy', 'runs_busy']);
});

test('two starts racing for the last place: exactly one wins', async () => {
  const sessions = [await shop.newSession(), await shop.newSession(), await shop.newSession()];
  await start(sessions[0]);
  const results = await Promise.allSettled([runs.start(sessions[1], body()), runs.start(sessions[2], body())]);
  const created = results.filter((r) => r.status === 'fulfilled');
  assert.equal(created.length, 1);
  runIds.push(created[0].value.runId);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'runs_busy');
});

test('kill switch: off blocks new runs and stops running ones (waiting orders end); on allows runs again', async () => {
  const sessionId = await shop.newSession();
  const runId = await start(sessionId);
  const waiting = await db.insertOrder({
    id: randomUUID(), sessionId, gameId: shop.gameId, state: 'waitlisted', runId, buyerRef: sessionId, waitMs: 600_000,
  });

  assert.equal(await runs.setRushEnabled(false), 1);
  assert.equal(await statusOf(runId), 'stopped');
  assert.equal((await db.getOrder(waiting.id)).state, 'waitlist_ended');
  await rejectsWith(runs.start(await shop.newSession(), body()), 'rush_disabled');

  await runs.setRushEnabled(true);
  await start(await shop.newSession());
});

test('summary: own run only; counts, oversold and the Redis copy check', async () => {
  const sessionId = await shop.newSession();
  const runId = await start(sessionId);
  const summary = await runs.summary(sessionId, runId);
  assert.deepEqual(
    { sold: summary.sold, stockTotal: summary.stockTotal, stockLeft: summary.stockLeft, oversold: summary.oversold, mismatch: summary.stockMismatch },
    { sold: 0, stockTotal: 3, stockLeft: 3, oversold: 0, mismatch: false },
  );
  await rejectsWith(runs.summary(await shop.newSession(), runId), 'not_found');
  await rejectsWith(runs.summary(sessionId, 'nope'), 'not_found');
});

test('faults: changed while running (database and Redis); a finished run refuses', async () => {
  const sessionId = await shop.newSession();
  const runId = await start(sessionId);
  await runs.setFaults(sessionId, runId, { down: true, latencyMs: 50 });
  assert.deepEqual((await db.getRun(runId)).faults, { latencyMs: 50, down: true, rateLimitPerSec: 0, failureRate: 0 });
  await rejectsWith(runs.setFaults(sessionId, runId, { down: 'x' }), 'invalid_input');
  await rejectsWith(runs.setFaults(await shop.newSession(), runId, {}), 'not_found');

  await runs.stop(sessionId, runId);
  await rejectsWith(runs.setFaults(sessionId, runId, {}), 'run_ended');
});

test('stop ends the run and its waiting orders; stopping again does nothing', async () => {
  const sessionId = await shop.newSession();
  const runId = await start(sessionId);
  const waiting = await db.insertOrder({
    id: randomUUID(), sessionId, gameId: shop.gameId, state: 'waitlisted', runId, buyerRef: sessionId, waitMs: 600_000,
  });
  await runs.stop(sessionId, runId);
  assert.equal(await statusOf(runId), 'stopped');
  assert.equal((await db.getOrder(waiting.id)).state, 'waitlist_ended');
  await runs.stop(sessionId, runId);
  assert.equal(await statusOf(runId), 'stopped');
});

test('closeDue finishes only runs whose time is up', async () => {
  const [a, b] = [await shop.newSession(), await shop.newSession()];
  const overdue = await start(a);
  const fresh = await start(b);
  await shop.admin.query(`UPDATE demo_runs SET ends_at = now() - interval '1 second' WHERE id = $1`, [overdue]);
  assert.deepEqual(await runs.closeDue(), { runsFinished: 1 });
  assert.deepEqual([await statusOf(overdue), await statusOf(fresh)], ['finished', 'running']);
});

test('cleanup deletes old ended runs with their orders and Redis keys, and keeps recent and running ones', async () => {
  const [a, b, c] = [await shop.newSession(), await shop.newSession(), await shop.newSession()];
  const old = await start(a);
  const recent = await start(b);
  await runs.stop(a, old);
  await runs.stop(b, recent);
  const order = await db.insertOrder({
    id: randomUUID(), sessionId: a, gameId: shop.gameId, state: 'reserved', runId: old, buyerRef: a, holdMs: 1000,
  });
  await shop.admin.query(`UPDATE demo_runs SET ends_at = now() - interval '3 hours' WHERE id = $1`, [old]);

  assert.deepEqual(await runs.cleanup(), { runsDeleted: 1 });
  assert.equal(await db.getRun(old), null);
  assert.equal(await db.getOrder(order.id), null);
  assert.deepEqual(await redis.stockLeft([runPool(old)]), [0]);
  assert.equal((await db.getRun(recent)).status, 'stopped');
  assert.deepEqual(await runs.cleanup(), { runsDeleted: 0 });
  assert.deepEqual(erpCalls.filter((call) => call.action === 'run.delete'), [{ action: 'run.delete', payload: { runId: old } }]);
  await start(c);
});

test('cleanup keeps a run whose ERP data cannot be deleted yet and still cleans the others', async () => {
  const [a, b] = [await shop.newSession(), await shop.newSession()];
  const stuck = await start(a);
  const clean = await start(b);
  await runs.stop(a, stuck);
  await runs.stop(b, clean);
  await shop.admin.query(`UPDATE demo_runs SET ends_at = now() - interval '3 hours' WHERE id = ANY($1)`, [[stuck, clean]]);
  erp.execute = async (action, payload) => {
    if (action === 'run.delete' && payload.runId === stuck) throw new Error('ERP unreachable');
    return {};
  };

  assert.deepEqual(await runs.cleanup(), { runsDeleted: 1 });
  assert.equal((await db.getRun(stuck)).status, 'stopped');
  assert.equal(await db.getRun(clean), null);
  erp.execute = async () => ({});
  assert.deepEqual(await runs.cleanup(), { runsDeleted: 1 });
  assert.equal(await db.getRun(stuck), null);
});
