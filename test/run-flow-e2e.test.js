// End to end: one demo run with simulated buyers through the real pieces (in one process):
// run driver -> Buy/Pay -> mock provider (signs and delivers webhooks, every run payment twice) -> ingress -> webhook job
// -> paid / re-reserve / refund, with the sweeper and the reconciler. Real PostgreSQL and Redis.
// There is no ERP simulator yet: paid orders get their fulfilment job but stay `paid` here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { loadProviderConfig } from '../sims/payment-provider/config.js';
import { startProvider } from '../sims/payment-provider/start.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis } from '../src/services/redis/index.js';
import { createFulfilmentQueue, createWebhookQueue, createWorker } from '../src/services/queue/index.js';
import { createInboundVerifier, createPaymentConnector } from '../src/services/connectors/payment-mock.js';
import { createPayments } from '../src/business/payments.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createPaymentEvents } from '../src/business/payment-events.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createRuns } from '../src/business/runs.js';
import { createRunDriver } from '../src/business/run-driver.js';
import { createWebhookJob } from '../src/jobs/webhook-job.js';
import { createTimer } from '../src/jobs/timer.js';
import { createWebhookRouter } from '../src/controllers/webhook.js';
import { createErrorHandler } from '../src/controllers/errors.js';
import { captureLogger, createTestShop } from './helpers.js';

const env = process.env;
const base = loadConfig({ ...env, PAYMENT_WEBHOOK_SECRET: env.PAYMENT_WEBHOOK_SECRET });
const providerBase = loadProviderConfig(env);
const { logger } = captureLogger();
const suffix = randomUUID();
const queueNames = { webhooks: `webhooks-e2e-${suffix}`, fulfilment: `fulfilment-e2e-${suffix}` };
const inspect = { webhooks: new Queue(queueNames.webhooks, { connection: base.redis }), fulfilment: new Queue(queueNames.fulfilment, { connection: base.redis }) };

const db = createDb({ logger });
const redis = createRedis({ redis: base.redis, logger });
let shop;
let server;
let provider;
let worker;
let webhookQueue;
let fulfilmentQueue;
const runIds = [];
const scenarios = {}; // run id and summary of each scenario, read by the tests

async function waitFor(check, what, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

before(async () => {
  await redis.ready();
  shop = await createTestShop({ stockTotal: 4 });

  webhookQueue = createWebhookQueue({
    redis: base.redis, jobOptions: base.webhookJob, logger, name: queueNames.webhooks,
  });
  await webhookQueue.ready();
  const payments = createPayments({
    verifier: createInboundVerifier({ secret: providerBase.webhookSecret }), db, webhookQueue, logger,
  });
  const app = express();
  app.use(createWebhookRouter({ payments, logger }));
  app.use(createErrorHandler({ logger }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  provider = await startProvider({
    config: {
      ...providerBase,
      port: 0,
      webhookUrl: `http://127.0.0.1:${server.address().port}/webhooks/payment`,
      delivery: { ...providerBase.delivery, pollMs: 50 },
      runDuplicateShare: 1, // every run payment's webhook goes out twice
    },
    logger,
  });
  const payment = createPaymentConnector({ baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: providerBase.apiKey });

  fulfilmentQueue = createFulfilmentQueue({
    redis: base.redis, jobOptions: base.webhookJob, logger, name: queueNames.fulfilment,
  });
  const paymentEvents = createPaymentEvents({
    db, redis, payment, fulfilmentQueue, config: base.payment, logger,
  });
  const webhookJob = createWebhookJob({ db, paymentEvents, classifyError: payment.classifyError });
  worker = createWorker({
    name: queueNames.webhooks,
    redis: base.redis,
    processor: (job, token) => webhookJob.process(job, token),
    onFinalFailure: (job, err) => webhookJob.onFinalFailure(job, err),
    logger,
  });


  // One run to its end: the driver acts for the buyers while the sweeper and the run closer work beside it.
  async function scenario({ behaviours, buyers, stock, holdMs, lateDelayMs }) {
    const config = {
      ...base,
      stock: { ...base.stock, runHoldMs: holdMs },
      runs: { ...base.runs, maxDurationMs: 6000, tickMs: 50, arrivalWindowMs: 1000, lateDelayMs, behaviours },
      reconciler: { ...base.reconciler, graceMs: 500 },
    };
    const stockGate = createStockGate({ db, redis, config: config.stock, logger });
    const orders = createOrders({ db, redis, stockGate, payment, config, logger });
    const reconciler = createReconciler({ db, redis, config: config.reconciler });
    const runs = createRuns({ db, redis, erp: { execute: async () => ({}) }, stockGate, runQueue: { add: async () => {} }, reconciler, config, logger });
    const timers = [
      createTimer({ name: 'sweeper', run: () => stockGate.sweep(100), intervalMs: 100, logger }),
      createTimer({ name: 'run-closer', run: () => runs.closeDue(), intervalMs: 100, logger }),
    ];
    timers.forEach((timer) => timer.start());

    const sessionId = await shop.newSession();
    const { runId } = await runs.start(sessionId, { gameId: shop.gameId, buyers, stock });
    runIds.push(runId);
    await createRunDriver({ db, orders, config, logger }).drive(runId);
    await waitFor(async () => (await db.getRun(runId)).status === 'finished', 'the run to finish');
    await Promise.all(timers.map((timer) => timer.stop()));

    // Webhooks still in flight: wait until every provider delivery for this run's payments is done.
    await waitFor(async () => {
      const { rows } = await shop.admin.query(
        `SELECT count(*)::int AS open FROM paysim.deliveries d JOIN paysim.events e ON e.id = d.event_id
         JOIN paysim.payments p ON p.id = e.payment_id
         WHERE p.run_id = $1 AND d.status = 'pending'`, [runId]);
      return rows[0].open === 0;
    }, 'the provider deliveries');
    await new Promise((resolve) => setTimeout(resolve, 1000)); // webhook jobs and refunds finish
    return { runId, summary: await runs.summary(sessionId, runId) };
  }

  scenarios.mixed = await scenario({
    behaviours: base.runs.behaviours, buyers: 12, stock: 4, holdMs: 1500, lateDelayMs: 2000,
  });
  // Everybody pays after the hold ended: late payments meet re-reserve or refund.
  scenarios.late = await scenario({ behaviours: { late: 1 }, buyers: 6, stock: 2, holdMs: 1000, lateDelayMs: 1500 });
});

after(async () => {
  const orderIds = 'SELECT id FROM orders WHERE game_id = $1';
  const payments = `SELECT id FROM paysim.payments WHERE order_id IN (${orderIds})`;
  await shop.admin.query(`DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id IN (${payments}))`, [shop.gameId]);
  await shop.admin.query(`DELETE FROM paysim.events WHERE payment_id IN (${payments})`, [shop.gameId]);
  await shop.admin.query(`DELETE FROM paysim.refunds WHERE payment_id IN (${payments})`, [shop.gameId]);
  await shop.admin.query(`DELETE FROM paysim.payments WHERE order_id IN (${orderIds})`, [shop.gameId]);
  await worker?.close();
  await provider?.shutdown();
  await new Promise((resolve) => server.close(resolve));
  for (const id of runIds) await redis.deleteRun(id);
  for (const queue of Object.values(inspect)) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await webhookQueue.close();
  await fulfilmentQueue.close();
  await shop.remove();
  await redis.close();
  await db.close();
});

const count = async (sql, runId) => (await shop.admin.query(sql, [runId])).rows[0].n;

for (const name of ['mixed', 'late']) {
  test(`${name}: no overselling, nothing lost, the Redis copies add up, nobody left waiting`, (t) => {
    const { summary } = scenarios[name];
    t.diagnostic(JSON.stringify(summary));
    assert.equal(summary.status, 'finished');
    assert.deepEqual(
      { oversold: summary.oversold, lost: summary.lost, stockMismatch: summary.stockMismatch, failed: summary.failed, waitlisted: summary.waitlisted },
      { oversold: 0, lost: 0, stockMismatch: false, failed: 0, waitlisted: 0 },
    );
    assert.ok(summary.sold >= 1 && summary.sold <= summary.stockTotal);
  });

  test(`${name}: every order ended in a state the design allows`, async () => {
    const { rows } = await shop.admin.query('SELECT DISTINCT state FROM orders WHERE run_id = $1', [scenarios[name].runId]);
    const allowed = new Set(['reserved', 'paid', 'refunded', 'reservation_expired', 'waitlist_ended']);
    for (const { state } of rows) assert.ok(allowed.has(state), `unexpected state ${state}`);
  });

  test(`${name}: each paid order has exactly one fulfilment job, refunded orders have none`, async () => {
    const { runId, summary } = scenarios[name];
    const paid = (await shop.admin.query(`SELECT id FROM orders WHERE run_id = $1 AND state = 'paid'`, [runId])).rows.map((r) => r.id);
    const jobs = await inspect.fulfilment.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    const wanted = new Set(paid.map((id) => `fulfil-${id}`));
    assert.equal(paid.length, summary.sold);
    assert.deepEqual(jobs.map((job) => job.id).filter((id) => wanted.has(id)).sort(), [...wanted].sort());
  });

  test(`${name}: every refund went once through refund_pending, with a succeeded delivery`, async () => {
    const { runId, summary } = scenarios[name];
    assert.equal(await count(
      `SELECT count(*)::int AS n FROM paysim.refunds r JOIN paysim.payments p ON p.id = r.payment_id WHERE p.run_id = $1`, runId), summary.refunded);
    assert.equal(await count(
      `SELECT count(*)::int AS n FROM order_transitions t JOIN orders o ON o.id = t.order_id
       WHERE o.run_id = $1 AND t.from_state = 'refund_pending' AND t.to_state = 'refunded'`, runId), summary.refunded);
    assert.equal(await count(
      `SELECT count(*)::int AS n FROM deliveries d JOIN orders o ON o.id = d.order_id
       WHERE o.run_id = $1 AND d.action = 'refund' AND d.status = 'succeeded'`, runId), summary.refunded);
  });

  test(`${name}: one stored event per payment, and every second delivery was counted as blocked`, async () => {
    const { runId } = scenarios[name];
    const stored = await count(
      `SELECT count(*)::int AS n FROM payment_events e JOIN orders o ON o.id = e.order_id
       WHERE o.run_id = $1 AND e.type = 'payment.succeeded'`, runId);
    const charged = await count('SELECT count(*)::int AS n FROM paysim.payments WHERE run_id = $1', runId);
    assert.equal(stored, charged, 'one stored event for each charge');
    const blocked = await count(
      `SELECT count(*)::int AS n FROM duplicates_blocked b JOIN orders o ON o.id = b.order_id
       WHERE o.run_id = $1 AND b.kind = 'webhook'`, runId);
    assert.equal(blocked, stored, 'every charge was delivered twice, so one repeat each was blocked');
  });
}

test('late: payments after the hold ended were refunded (no copy left) or re-reserved', () => {
  const { summary } = scenarios.late;
  assert.ok(summary.refunded >= 1, 'at least one late payer found no copy and was refunded');
  assert.ok(summary.sold >= 1, 'at least one late payer got a copy back');
});
