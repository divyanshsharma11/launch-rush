// Dead-letter replay and recovery of orders without a live job, with a real fulfilment worker, the ERP simulator,
// breaker-protected connector, PostgreSQL and Redis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createDb } from '../src/services/db/index.js';
import { createFulfilmentQueue, createWebhookQueue, createWorker } from '../src/services/queue/index.js';
import { createErpConnector } from '../src/services/connectors/erp-sim.js';
import { createBreakers } from '../src/services/connectors/breaker.js';
import { createFulfilment } from '../src/business/fulfilment.js';
import { createPaymentEvents } from '../src/business/payment-events.js';
import { createRecovery } from '../src/business/recovery.js';
import { createReplay } from '../src/business/replay.js';
import { createFulfilmentJob } from '../src/jobs/fulfilment-job.js';
import { addErpItem, captureLogger, createTestShop, paymentEvent, removeErpItem } from './helpers.js';

const base = loadConfig(process.env);
const simConfig = { ...loadErpSimConfig(process.env), port: 0 };
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = new Redis(base.redis);
const suffix = randomUUID();
const jobOptions = { attempts: 2, backoff: { type: 'exponential', delay: 50 }, removeOnComplete: false, removeOnFail: false };
const faultKeys = [];
const cleanups = [];
let shop;
let sim;
let breakers;
let fulfilment;
let fulfilmentQueue;
let inspect;
let webhookQueue;
let hookWorks = true;

before(async () => {
  shop = await createTestShop({ stockTotal: 10 });
  await addErpItem(shop.admin, shop.gameId, 20);
  sim = await startErpSimulator({ config: simConfig, logger: captureLogger().logger });
  breakers = createBreakers({ settings: base.breaker, logger });
  const erp = breakers.protect(
    createErpConnector({ baseUrl: `http://127.0.0.1:${sim.port}`, apiKey: simConfig.apiKey, apiSecret: simConfig.apiSecret }),
  );
  fulfilment = createFulfilment({ db, erp, emailQueue: { add: async () => {} }, config: base.erp, logger });
  const job = createFulfilmentJob({ fulfilment, classifyError: erp.classifyError });

  const name = `fulfilment-test-${suffix}`;
  fulfilmentQueue = createFulfilmentQueue({ redis: base.redis, jobOptions, logger, name });
  inspect = new Queue(name, { connection: base.redis });
  // hookWorks = false stands for "PostgreSQL was down when the last retry failed".
  const worker = createWorker({
    name,
    redis: base.redis,
    concurrency: 3,
    maxStartedAttempts: 10,
    processor: (j, token) => job.process(j, token),
    onFinalFailure: async (j, err) => {
      if (!hookWorks) throw new Error('postgres down');
      await job.onFinalFailure(j, err);
    },
    logger,
  });
  webhookQueue = createWebhookQueue({ redis: base.redis, jobOptions, logger, name: `webhooks-test-${suffix}` });
  cleanups.push(() => worker.close());
});

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await fulfilmentQueue.close();
  await inspect.obliterate({ force: true });
  await inspect.close();
  const webhooks = new Queue(`webhooks-test-${suffix}`, { connection: base.redis });
  await webhooks.obliterate({ force: true });
  await webhooks.close();
  await webhookQueue.close();
  await redis.del(...faultKeys);
  await shop.admin.query('DELETE FROM demo_runs WHERE game_id = $1', [shop.gameId]);
  await removeErpItem(shop.admin, shop.gameId);
  await shop.remove();
  await sim.shutdown();
  breakers.close();
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

// A paid order in its own demo run (so its own ERP fault settings and quantity).
async function paidRunOrder() {
  const sessionId = await shop.newSession();
  const { rows } = await shop.admin.query(
    `INSERT INTO demo_runs (session_id, game_id, stock_total, buyers_requested, faults, status, ends_at)
     VALUES ($1, $2, 5, 5, '{}', 'running', now() + interval '5 minutes') RETURNING id`,
    [sessionId, shop.gameId],
  );
  const runId = rows[0].id;
  faultKeys.push(`faults:${runId}`);
  const body = JSON.stringify({ receiptId: `run-${runId}`, itemCode: shop.gameId, qty: 2, runId });
  const res = await fetch(`http://127.0.0.1:${sim.port}/sim/stock-receipts`, {
    method: 'POST', body,
    headers: { Authorization: `token ${simConfig.apiKey}:${simConfig.apiSecret}`, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const order = await db.insertOrder({
    id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', runId, buyerRef: randomUUID(), holdMs: 300_000,
  });
  await db.transition(order.id, 'reserved', 'payment_pending');
  await db.transition(order.id, 'payment_pending', 'paid');
  return { orderId: order.id, runId };
}

const stateOf = async (orderId) => (await db.getOrder(orderId)).state;
const deliveryOf = async (orderId) => (await shop.admin.query(
  'SELECT id, status, last_error FROM deliveries WHERE order_id = $1', [orderId],
)).rows[0];
const setFaults = (runId, faults) => redis.set(`faults:${runId}`, JSON.stringify(faults));
// Recovery acts on this test's orders only; the other orders in the database are not its business.
// Pass orderId to look at one order only.
function recoveryFor(graceMs, orderId = null, batchSize = 100) {
  const ownOrders = {
    ...db,
    stuckOrders: async (...args) =>
      (await db.stuckOrders(...args)).filter((o) => o.gameId === shop.gameId && (!orderId || o.id === orderId)),
  };
  const paymentEvents = createPaymentEvents({
    db, redis: {}, payment: { id: 'payment-mock' }, fulfilmentQueue, config: base.payment, logger,
  });
  return createRecovery({
    db: ownOrders, fulfilment, paymentEvents, fulfilmentQueue, webhookQueue, config: { graceMs, batchSize }, logger,
  });
}

test('replay: a failed order goes back to its last good state and its retried job completes it', async () => {
  const { orderId, runId } = await paidRunOrder();
  await setFaults(runId, { down: true });
  await fulfilmentQueue.add(orderId);
  await waitFor(async () => (await stateOf(orderId)) === 'failed', 'failed order');

  const replay = createReplay({ db, fulfilmentQueue, webhookQueue });
  const failed = (await replay.listFailed(1000)).find((d) => d.orderId === orderId);
  assert.equal(failed.action, 'sales_order.submit');
  assert.match(failed.lastError, /503/);

  await redis.del(`faults:${runId}`);
  await replay.replay(failed.id);
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order after replay');

  const history = await shop.admin.query(
    'SELECT from_state, to_state FROM order_transitions WHERE order_id = $1 ORDER BY id', [orderId],
  );
  assert.deepEqual(
    history.rows.map((t) => `${t.from_state}>${t.to_state}`).slice(-5),
    ['paid>failed', 'failed>paid', 'paid>so_submitted', 'so_submitted>invoiced', 'invoiced>completed'],
  );
  assert.equal((await deliveryOf(orderId)).status, 'succeeded');
  assert.equal((await replay.listFailed(1000)).some((d) => d.orderId === orderId), false);
});

test('replay: a second click, an unknown id and a delivery that is not failed are refused', async () => {
  const { orderId, runId } = await paidRunOrder();
  await setFaults(runId, { down: true });
  await fulfilmentQueue.add(orderId);
  await waitFor(async () => (await stateOf(orderId)) === 'failed', 'failed order');
  await redis.del(`faults:${runId}`);
  const replay = createReplay({ db, fulfilmentQueue, webhookQueue });
  const { id } = await deliveryOf(orderId);

  await replay.replay(id);
  await assert.rejects(replay.replay(id), { code: 'invalid_state' });
  await assert.rejects(replay.replay(randomUUID()), { code: 'not_found' });
  await assert.rejects(replay.replay('not-a-uuid'), { code: 'not_found' });
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order');
});

test('replay: if BullMQ no longer has the failed job, a new job is added', async () => {
  const { orderId, runId } = await paidRunOrder();
  await setFaults(runId, { down: true });
  await fulfilmentQueue.add(orderId);
  await waitFor(async () => (await stateOf(orderId)) === 'failed', 'failed order');
  await (await inspect.getJob(`fulfil-${orderId}`)).remove();
  await redis.del(`faults:${runId}`);

  await createReplay({ db, fulfilmentQueue, webhookQueue }).replay((await deliveryOf(orderId)).id);
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order');
});

test('replay of a failed refund: the order is refund_pending again and the event job is queued', async () => {
  const { orderId } = await paidRunOrder();
  const event = paymentEvent(`evt_${randomUUID().replaceAll('-', '')}`, orderId);
  await db.insertPaymentEvent(event);
  await db.transition(orderId, 'paid', 'refund_pending');
  await db.startDelivery({ orderId, connector: 'payment-mock', action: 'refund' });
  await db.updateDelivery({ orderId, action: 'refund', status: 'failed', error: 'provider replied HTTP 500' });
  await db.transition(orderId, 'refund_pending', 'failed');

  await createReplay({ db, fulfilmentQueue, webhookQueue }).replay((await deliveryOf(orderId)).id);

  assert.equal(await stateOf(orderId), 'refund_pending');
  assert.equal((await deliveryOf(orderId)).status, 'pending');
  assert.equal((await webhookQueue.find(event.id)).state, 'waiting');
});

test('replay: deliveries of a connector without a replay path are refused and left failed', async () => {
  const { orderId } = await paidRunOrder();
  await db.startDelivery({ orderId, connector: 'telegram', action: 'message.send' });
  await db.updateDelivery({ orderId, action: 'message.send', status: 'failed', error: 'x' });
  const { id } = await deliveryOf(orderId);
  await assert.rejects(createReplay({ db, fulfilmentQueue, webhookQueue }).replay(id), { code: 'invalid_state' });
  assert.equal((await deliveryOf(orderId)).status, 'failed');
});

test('recovery: the final-failure hook could not run; the order is moved to failed with the real error', async () => {
  const { orderId, runId } = await paidRunOrder();
  hookWorks = false;
  await setFaults(runId, { down: true });
  await fulfilmentQueue.add(orderId);
  await waitFor(async () => (await inspect.getJob(`fulfil-${orderId}`))?.isFailed(), 'failed job');
  hookWorks = true;
  assert.equal(await stateOf(orderId), 'paid', 'the hook did not run, so the order is still paid');

  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await recoveryFor(0, orderId).run();

  assert.equal(result.recoveredFailed, 1);
  assert.equal(await stateOf(orderId), 'failed');
  const delivery = await deliveryOf(orderId);
  assert.equal(delivery.status, 'failed');
  assert.match(delivery.last_error, /503/);
  assert.equal((await recoveryFor(0, orderId).run()).recoveredFailed, 0, 'a second pass finds nothing');
});

test('recovery: an order whose job is gone gets its job back and completes', async () => {
  const { orderId } = await paidRunOrder();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = await recoveryFor(0, orderId).run();

  assert.equal(result.recoveredRequeued, 1);
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order');
});

test('recovery: leaves alone an order whose job is still alive, and an order younger than the grace time', async () => {
  const { orderId } = await paidRunOrder();
  await inspect.add('fulfil-order', { orderId }, { jobId: `fulfil-${orderId}`, delay: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const alive = await recoveryFor(0, orderId).run();
  assert.deepEqual(alive, { recoveredFailed: 0, recoveredRequeued: 0 });

  const young = await paidRunOrder();
  const tooYoung = await recoveryFor(60_000, young.orderId).run();
  assert.deepEqual(tooYoung, { recoveredFailed: 0, recoveredRequeued: 0 });
  assert.equal(await stateOf(young.orderId), 'paid');
  await (await inspect.getJob(`fulfil-${orderId}`)).remove();
});

test('recovery: a stuck refund whose event job failed is moved to failed', async () => {
  const { orderId } = await paidRunOrder();
  const event = paymentEvent(`evt_${randomUUID().replaceAll('-', '')}`, orderId);
  await db.insertPaymentEvent(event);
  await db.transition(orderId, 'paid', 'refund_pending');
  await db.startDelivery({ orderId, connector: 'payment-mock', action: 'refund' });
  await db.updateDelivery({ orderId, action: 'refund', status: 'pending', error: 'provider replied HTTP 500' });

  const failing = createWorker({
    name: `webhooks-test-${suffix}`,
    redis: base.redis,
    processor: async () => { throw new UnrecoverableError('provider replied HTTP 500'); },
    logger,
  });
  await webhookQueue.add(event.id);
  await waitFor(async () => (await webhookQueue.find(event.id))?.state === 'failed', 'failed webhook job');
  await failing.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = await recoveryFor(0, orderId).run();

  assert.equal(result.recoveredFailed, 1);
  assert.equal(await stateOf(orderId), 'failed');
  assert.equal((await deliveryOf(orderId)).status, 'failed');
});

test('recovery: orders whose job is alive do not hide a stuck order behind them (one order per page)', async () => {
  const alive = [await paidRunOrder(), await paidRunOrder()];
  for (const { orderId } of alive) {
    await inspect.add('fulfil-order', { orderId }, { jobId: `fulfil-${orderId}`, delay: 60_000 });
  }
  const lost = await paidRunOrder();
  await new Promise((resolve) => setTimeout(resolve, 20));

  await recoveryFor(0, null, 1).run();

  await waitFor(async () => (await stateOf(lost.orderId)) === 'completed', 'the order behind the live ones completed');
  for (const { orderId } of alive) {
    assert.equal(await stateOf(orderId), 'paid');
    await (await inspect.getJob(`fulfil-${orderId}`)).remove();
  }
});
