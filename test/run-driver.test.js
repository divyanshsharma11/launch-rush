// The run driver: simulated buyers' behaviours against real PostgreSQL and Redis.
// Short times so a run lasts about 2 s. The provider call is a recording stand-in (no webhook comes back).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, runPool } from '../src/services/redis/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createRuns } from '../src/business/runs.js';
import { createRunDriver } from '../src/business/run-driver.js';
import { createTimer } from '../src/jobs/timer.js';
import { captureLogger, createTestShop } from './helpers.js';

const base = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: base.redis, logger });
const charges = [];
const payment = {
  id: 'payment-mock',
  async execute(action, payload, ctx) {
    const { state } = await db.getOrder(ctx.orderId);
    charges.push({ action, payload, ctx, state });
    return {};
  },
};
const runIds = [];
let shop;

// One run of `buyers` buyers who all follow `behaviour`, driven until it ends. The sweeper runs beside it.
// No webhook comes back here, so a charged order is still payment_pending and expires with its hold.
async function runWith(behaviour, { buyers, stock, holdMs = 400, sweep = true }) {
  const config = {
    ...base,
    stock: { ...base.stock, runHoldMs: holdMs },
    runs: { ...base.runs, maxDurationMs: 2000, tickMs: 20, arrivalWindowMs: 100, lateDelayMs: 300, behaviours: { [behaviour]: 1 } },
  };
  const stockGate = createStockGate({ db, redis, config: config.stock, logger });
  const orders = createOrders({ db, redis, stockGate, payment, config, logger });
  const reconciler = createReconciler({ db, redis, config: config.reconciler });
  const runs = createRuns({ db, redis, erp: { execute: async () => ({}) }, stockGate, runQueue: { add: async () => {} }, reconciler, config, logger });
  const sweeper = createTimer({ name: 'sweeper', run: () => stockGate.sweep(100), intervalMs: 50, logger });

  const { runId } = await runs.start(await shop.newSession(), { gameId: shop.gameId, buyers, stock });
  runIds.push(runId);
  if (sweep) sweeper.start();
  await createRunDriver({ db, orders, config, logger }).drive(runId);
  await sweeper.stop();
  await runs.closeDue();
  return runId;
}

const orderStates = async (runId) =>
  (await shop.admin.query('SELECT state FROM orders WHERE run_id = $1 ORDER BY created_at', [runId])).rows.map((r) => r.state);
const duplicates = async (runId) =>
  (await shop.admin.query(
    'SELECT count(*)::int AS n FROM duplicates_blocked b JOIN orders o ON o.id = b.order_id WHERE o.run_id = $1', [runId],
  )).rows[0].n;

before(() => redis.ready());

beforeEach(async () => {
  charges.length = 0;
  if (shop) await shop.remove();
  for (const id of runIds.splice(0)) await redis.deleteRun(id);
  shop = await createTestShop({ stockTotal: 5 });
});

after(async () => {
  for (const id of runIds) await redis.deleteRun(id);
  await shop.remove();
  await redis.close();
  await db.close();
});

test('buyers who pay: each sends one charge for its own order, tagged with the run, inside the hold', async () => {
  const runId = await runWith('pays', { buyers: 3, stock: 3 });
  const { rows: paying } = await shop.admin.query(
    `SELECT count(*)::int AS n FROM order_transitions t JOIN orders o ON o.id = t.order_id
     WHERE o.run_id = $1 AND t.from_state = 'reserved' AND t.to_state = 'payment_pending'`, [runId]);
  assert.equal(paying[0].n, 3);
  assert.equal(charges.length, 3);
  for (const { action, ctx } of charges) {
    assert.equal(action, 'charge');
    assert.equal(ctx.runId, runId);
    assert.equal(ctx.idempotencyKey, `charge-${ctx.orderId}`);
  }
  assert.equal(new Set(charges.map((c) => c.ctx.orderId)).size, 3);
  const { rows } = await shop.admin.query(`SELECT count(*)::int AS n FROM orders WHERE run_id = $1 AND is_simulated`, [runId]);
  assert.equal(rows[0].n, 3);
});

test('buyers who never pay: no charge; their holds expire and the copies go back to stock', async () => {
  const runId = await runWith('never', { buyers: 3, stock: 3 });
  assert.equal(charges.length, 0);
  assert.deepEqual(await orderStates(runId), ['reservation_expired', 'reservation_expired', 'reservation_expired']);
  assert.deepEqual(await redis.stockLeft([runPool(runId)]), [3]);
});

test('late buyers: they click Pay in time, the hold expires, then the charge is sent', async () => {
  const runId = await runWith('late', { buyers: 2, stock: 2 });
  assert.equal(charges.length, 2);
  assert.deepEqual(await orderStates(runId), ['reservation_expired', 'reservation_expired']);
  const { rows } = await shop.admin.query(
    `SELECT count(*)::int AS n FROM order_transitions t JOIN orders o ON o.id = t.order_id
     WHERE o.run_id = $1 AND t.from_state = 'reserved' AND t.to_state = 'payment_pending'`, [runId]);
  assert.equal(rows[0].n, 2);
});

test('late buyers when the sweeper is behind: the charge meets payment_pending, which the webhook job handles', async () => {
  await runWith('late', { buyers: 2, stock: 2, sweep: false });
  assert.deepEqual(charges.map((charge) => charge.state), ['payment_pending', 'payment_pending']);
});

test('buyers who click Buy twice: the second click is refused and counted, then they pay', async () => {
  const runId = await runWith('doubleClick', { buyers: 2, stock: 2 });
  assert.equal((await orderStates(runId)).length, 2);
  assert.equal(await duplicates(runId), 2);
  assert.equal(charges.length, 2);
});

test('more buyers than copies: the rest wait, and when the run ends their waits end', async () => {
  const runId = await runWith('never', { buyers: 4, stock: 2, holdMs: 60_000 });
  assert.deepEqual((await orderStates(runId)).sort(), ['reserved', 'reserved', 'waitlist_ended', 'waitlist_ended']);
  assert.equal((await db.getRun(runIds.at(-1))).status, 'finished');
});

test('a waiter is promoted when a hold expires and then follows its own behaviour', async () => {
  const runId = await runWith('never', { buyers: 2, stock: 1 });
  const { rows } = await shop.admin.query(
    `SELECT t.to_state FROM order_transitions t JOIN orders o ON o.id = t.order_id
     WHERE o.run_id = $1 AND o.state = 'reservation_expired' ORDER BY o.id, t.id`, [runId]);
  assert.deepEqual((await orderStates(runId)).sort(), ['reservation_expired', 'reservation_expired']);
  assert.equal(rows.filter((r) => r.to_state === 'waitlisted').length, 1); // one of the two first waited, then was promoted
});

test('a missing run is ignored', async () => {
  const config = { ...base };
  const stockGate = createStockGate({ db, redis, config: config.stock, logger });
  const orders = createOrders({ db, redis, stockGate, payment, config, logger });
  const driver = createRunDriver({ db, orders, config, logger });
  await driver.drive('00000000-0000-4000-8000-000000000000');
  assert.equal(charges.length, 0);
});

test('an aborted signal stops the driver at once and reports that the run is not over', async () => {
  const config = { ...base, runs: { ...base.runs, maxDurationMs: 2000, tickMs: 20 } };
  const stockGate = createStockGate({ db, redis, config: config.stock, logger });
  const orders = createOrders({ db, redis, stockGate, payment, config, logger });
  const reconciler = createReconciler({ db, redis, config: config.reconciler });
  const runs = createRuns({ db, redis, erp: { execute: async () => ({}) }, stockGate, runQueue: { add: async () => {} }, reconciler, config, logger });
  const sessionId = await shop.newSession();
  const { runId } = await runs.start(sessionId, { gameId: shop.gameId, buyers: 2, stock: 2 });
  runIds.push(runId);

  assert.equal(await createRunDriver({ db, orders, config, logger }).drive(runId, AbortSignal.abort()), false);
  assert.equal((await db.getRun(runId)).status, 'running');
  await runs.stop(sessionId, runId);
});
