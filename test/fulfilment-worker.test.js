// The fulfilment queue with a real BullMQ worker: one job per order, retries, permanent failure, a delay on 429.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createDb } from '../src/services/db/index.js';
import { createFulfilmentQueue, createWorker } from '../src/services/queue/index.js';
import { createErpConnector } from '../src/services/connectors/erp-sim.js';
import { createFulfilment } from '../src/business/fulfilment.js';
import { createFulfilmentJob } from '../src/jobs/fulfilment-job.js';
import { addErpItem, captureLogger, createTestShop, removeErpItem } from './helpers.js';

const base = loadConfig(process.env);
const simConfig = { ...loadErpSimConfig(process.env), port: 0 };
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = new Redis(base.redis);
const queueName = `fulfilment-test-${randomUUID()}`;
const jobOptions = { attempts: 2, backoff: { type: 'exponential', delay: 50 }, removeOnComplete: false, removeOnFail: false };
const faultKeys = [];
let shop;
let sim;
let queue;
let inspect;
let worker;

before(async () => {
  shop = await createTestShop({ stockTotal: 10 });
  await addErpItem(shop.admin, shop.gameId, 10);
  sim = await startErpSimulator({ config: simConfig, logger: captureLogger().logger });
  const erp = createErpConnector({ baseUrl: `http://127.0.0.1:${sim.port}`, apiKey: simConfig.apiKey, apiSecret: simConfig.apiSecret });
  const fulfilment = createFulfilment({ db, erp, emailQueue: { add: async () => {} }, config: base.erp, logger });
  const job = createFulfilmentJob({ fulfilment, classifyError: erp.classifyError });

  queue = createFulfilmentQueue({ redis: base.redis, jobOptions, logger, name: queueName });
  inspect = new Queue(queueName, { connection: base.redis });
  worker = createWorker({
    name: queueName,
    redis: base.redis,
    concurrency: 3,
    processor: (j, token) => job.process(j, token),
    onFinalFailure: (j, err) => job.onFinalFailure(j, err),
    logger,
  });
});

after(async () => {
  await worker.close();
  await queue.close();
  await inspect.obliterate({ force: true });
  await inspect.close();
  await redis.del(...faultKeys);
  await shop.admin.query('DELETE FROM demo_runs WHERE game_id = $1', [shop.gameId]);
  await removeErpItem(shop.admin, shop.gameId);
  await shop.remove();
  await sim.shutdown();
  await redis.quit();
  await db.close();
});

async function waitFor(check, what, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// A paid order in a new demo run with its own ERP quantity (and so its own fault settings).
async function paidRunOrder(erpQty) {
  const sessionId = await shop.newSession();
  const { rows } = await shop.admin.query(
    `INSERT INTO demo_runs (session_id, game_id, stock_total, buyers_requested, faults, status, ends_at)
     VALUES ($1, $2, 5, 5, '{}', 'running', now() + interval '5 minutes') RETURNING id`,
    [sessionId, shop.gameId],
  );
  const runId = rows[0].id;
  faultKeys.push(`faults:${runId}`);
  if (erpQty > 0) {
    const body = JSON.stringify({ receiptId: `run-${runId}`, itemCode: shop.gameId, qty: erpQty, runId });
    const res = await fetch(`http://127.0.0.1:${sim.port}/sim/stock-receipts`, {
      method: 'POST', body,
      headers: { Authorization: `token ${simConfig.apiKey}:${simConfig.apiSecret}`, 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 200);
  }
  const order = await db.insertOrder({
    id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', runId, buyerRef: randomUUID(), holdMs: 300_000,
  });
  await db.transition(order.id, 'reserved', 'payment_pending');
  await db.transition(order.id, 'payment_pending', 'paid');
  return { orderId: order.id, runId };
}

const stateOf = async (orderId) => (await db.getOrder(orderId)).state;
const erpDocuments = async (orderId) => (await shop.admin.query(
  'SELECT count(*)::int AS n FROM erpsim.documents WHERE order_ref = $1', [orderId],
)).rows[0].n;

test('a fulfilment job completes the order; a second job for the same order is ignored (one job per order)', async () => {
  const { orderId } = await paidRunOrder(2);
  const first = await queue.add(orderId);
  const second = await queue.add(orderId);
  assert.equal(second.id, first.id);
  assert.equal(first.id, `fulfil-${orderId}`);
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order');
  assert.equal(await erpDocuments(orderId), 4);
});

test('ERP down for good: the job retries, then the order moves to failed and its delivery fails', async () => {
  const { orderId, runId } = await paidRunOrder(2);
  await redis.set(`faults:${runId}`, JSON.stringify({ down: true }));
  await queue.add(orderId);

  await waitFor(async () => (await stateOf(orderId)) === 'failed', 'failed order');
  const job = await inspect.getJob(`fulfil-${orderId}`);
  assert.equal(job.attemptsMade, 2, 'every attempt was used');
  const { rows } = await shop.admin.query('SELECT action, status, attempts FROM deliveries WHERE order_id = $1', [orderId]);
  assert.deepEqual(rows, [{ action: 'sales_order.submit', status: 'failed', attempts: 2 }]);
});

test('a permanent ERP error stops at once: one attempt, then failed', async () => {
  const { orderId } = await paidRunOrder(0); // the ERP has no copy for this run
  await queue.add(orderId);

  await waitFor(async () => (await stateOf(orderId)) === 'failed', 'failed order');
  const job = await inspect.getJob(`fulfil-${orderId}`);
  assert.equal(job.attemptsMade, 1);
  assert.match(job.failedReason, /InsufficientStock/);
});

test('429 with Retry-After: the job is delayed without using an attempt, then completes once the ERP lets it through', async () => {
  const { orderId, runId } = await paidRunOrder(2);
  await redis.set(`faults:${runId}`, JSON.stringify({ rateLimitPerSec: 1 }));
  await queue.add(orderId);

  const jobId = `fulfil-${orderId}`;
  await waitFor(async () => (await inspect.getJob(jobId))?.getState().then((state) => state === 'delayed'), 'a delayed job');
  await redis.del(`faults:${runId}`);
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order');
  await waitFor(async () => (await inspect.getJob(jobId))?.getState().then((state) => state === 'completed'), 'a completed job');
  const job = await inspect.getJob(jobId);
  assert.equal(job.attemptsMade, 1, 'only the run that succeeded counts: the delay used no attempt');
  assert.ok(job.attemptsStarted >= 2, 'the job was started again after the delay');
});
