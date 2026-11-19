// Webhook job handling against the real PostgreSQL and Redis containers.
// The provider call is a recording stand-in; the error classes come from the real payment connector.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createFulfilmentQueue, createWebhookQueue, createWorker } from '../src/services/queue/index.js';
import { createPaymentConnector, ProviderHttpError } from '../src/services/connectors/payment-mock.js';
import { createStockGate, poolOf } from '../src/business/waitlist-stock.js';
import { createPaymentEvents } from '../src/business/payment-events.js';
import { createWebhookJob } from '../src/jobs/webhook-job.js';
import { captureLogger, createTestShop, paymentEvent } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
const stockGate = createStockGate({ db, redis, config: config.stock, logger });
const { classifyError } = createPaymentConnector({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k'.repeat(32) });

const suffix = randomUUID();
const fulfilmentName = `fulfilment-test-${suffix}`;
const webhookName = `webhooks-test-${suffix}`;
const fulfilmentQueue = createFulfilmentQueue({ redis: config.redis, jobOptions: config.webhookJob, logger, name: fulfilmentName });
const inspectFulfilment = new Queue(fulfilmentName, { connection: config.redis });
const retryOptions = { ...config.webhookJob, attempts: 3, backoff: { type: 'fixed', delay: 20 } };
const inspectWebhooks = new Queue(webhookName, { connection: config.redis });
const webhookQueue = createWebhookQueue({ redis: config.redis, jobOptions: retryOptions, logger, name: webhookName });

const refundCalls = [];
const provider = { id: 'payment-mock', failures: [], classifyError, async execute(action, payload, ctx) {
  refundCalls.push({ action, payload, ctx });
  const failure = this.failures.shift();
  if (failure) throw failure;
  return {};
} };
const paymentEvents = createPaymentEvents({
  db, redis, payment: provider, fulfilmentQueue, config: { callTimeoutMs: 5000 }, logger,
});
const webhookJob = createWebhookJob({ db, paymentEvents, classifyError });
const worker = createWorker({
  name: webhookName,
  redis: config.redis,
  processor: (job, token) => webhookJob.process(job, token),
  onFinalFailure: (job, err) => webhookJob.onFinalFailure(job, err),
  logger,
});

let shop;

// An order that bought the single copy (reserved) and then started payment.
async function pendingOrder() {
  const id = randomUUID();
  const sessionId = await shop.newSession();
  const { result } = await redis.buy(shopPool(shop.gameId), id);
  const order = await db.insertOrder({ id, sessionId, gameId: shop.gameId, state: result, holdMs: 300_000, waitMs: 1000 });
  if (result === 'reserved') await db.transition(id, 'reserved', 'payment_pending');
  return order;
}

// The sweeper's path: the hold ran out, the copy is released.
async function expire(order) {
  await db.transition(order.id, 'payment_pending', 'reservation_expired');
  await stockGate.release(order);
}

const eventFor = (order, type = 'payment.succeeded') => ({ ...paymentEvent(`evt_${randomUUID()}`, order.id), type });
const stateOf = async (order) => (await db.getOrder(order.id)).state;
const fulfilJobs = (order) => inspectFulfilment.getJob(`fulfil-${order.id}`);
const history = async (order) =>
  (await shop.admin.query('SELECT to_state FROM order_transitions WHERE order_id = $1 ORDER BY id', [order.id])).rows.map((r) => r.to_state);

before(() => redis.ready());

beforeEach(async () => {
  refundCalls.length = 0;
  provider.failures = [];
  if (shop) {
    await redis.deletePool(shopPool(shop.gameId));
    await shop.remove();
  }
  shop = await createTestShop({ stockTotal: 1 });
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 1 }]);
});

after(async () => {
  await worker.close();
  await redis.deletePool(shopPool(shop.gameId));
  await shop.remove();
  await inspectFulfilment.obliterate({ force: true });
  await inspectFulfilment.close();
  await inspectWebhooks.obliterate({ force: true });
  await inspectWebhooks.close();
  await fulfilmentQueue.close();
  await webhookQueue.close();
  await redis.close();
  await db.close();
});

test('payment_pending -> paid and one fulfilment job; a repeat (state paid) adds no second job', async () => {
  const order = await pendingOrder();
  const event = eventFor(order);
  await paymentEvents.process(event);
  assert.equal(await stateOf(order), 'paid');
  assert.deepEqual((await fulfilJobs(order)).data, { orderId: order.id });
  await paymentEvents.process(event);
  assert.equal(await stateOf(order), 'paid');
  assert.equal((await inspectFulfilment.getJobCounts('waiting')).waiting, 1);
  assert.deepEqual(await history(order), ['reserved', 'payment_pending', 'paid']);
});

test('late payment with a free copy: re-reserved, paid, fulfilment queued', async () => {
  const order = await pendingOrder();
  await expire(order);
  assert.deepEqual(await redis.stockLeft([shopPool(shop.gameId)]), [1]);
  await paymentEvents.process(eventFor(order));
  assert.equal(await stateOf(order), 'paid');
  assert.deepEqual(await redis.stockLeft([shopPool(shop.gameId)]), [0]);
  assert.ok(await fulfilJobs(order));
  assert.equal(refundCalls.length, 0);
});

test('late payment with no copy left: refund_pending, refund with refund-<orderId>, then refunded', async () => {
  const late = await pendingOrder();
  await expire(late);
  const taker = await pendingOrder(); // takes the freed copy
  assert.equal(taker.state, 'reserved');

  const event = eventFor(late);
  await paymentEvents.process(event);
  assert.equal(await stateOf(late), 'refunded');
  assert.deepEqual(await history(late), ['reserved', 'payment_pending', 'reservation_expired', 'refund_pending', 'refunded']);
  assert.deepEqual(refundCalls.map((c) => [c.action, c.payload, c.ctx.idempotencyKey]), [
    ['refund', { paymentId: 'pay_test' }, `refund-${late.id}`],
  ]);
  const { rows } = await shop.admin.query('SELECT status, attempts FROM deliveries WHERE order_id = $1', [late.id]);
  assert.deepEqual(rows, [{ status: 'succeeded', attempts: 1 }]);
  assert.equal(await fulfilJobs(late), undefined);
  assert.equal(await stateOf(taker), 'payment_pending');
});

test('crash after the refund decision: a retry finds refund_pending and finishes the refund', async () => {
  const late = await pendingOrder();
  await expire(late);
  await pendingOrder();
  await db.transition(late.id, 'reservation_expired', 'refund_pending');
  await paymentEvents.process(eventFor(late));
  assert.equal(await stateOf(late), 'refunded');
  assert.equal(refundCalls.length, 1);
});

test('states already past payment, and payment.refunded events, change nothing', async () => {
  const order = await pendingOrder();
  await db.transition(order.id, 'payment_pending', 'paid');
  await db.transition(order.id, 'paid', 'so_submitted');
  await paymentEvents.process(eventFor(order));
  assert.equal(await stateOf(order), 'so_submitted');
  assert.equal(await fulfilJobs(order), undefined);

  await paymentEvents.process(eventFor(order, 'payment.refunded'));
  assert.equal(await stateOf(order), 'so_submitted');
});

test('webhook job: a retryable provider failure is retried, then the refund goes through', async () => {
  const late = await pendingOrder();
  await expire(late);
  await pendingOrder();
  const event = eventFor(late);
  await db.insertPaymentEvent(event);
  provider.failures = [new ProviderHttpError(503, null, null)];

  await webhookQueue.add(event.id);
  await waitFor(async () => (await stateOf(late)) === 'refunded');
  assert.equal(refundCalls.length, 2);
  const { rows } = await shop.admin.query('SELECT status, attempts, last_error FROM deliveries WHERE order_id = $1', [late.id]);
  assert.deepEqual(rows, [{ status: 'succeeded', attempts: 2, last_error: null }]);
});

test('webhook job: a permanent provider failure stops at once; the order and the delivery become failed', async () => {
  const late = await pendingOrder();
  await expire(late);
  await pendingOrder();
  const event = eventFor(late);
  await db.insertPaymentEvent(event);
  provider.failures = [new ProviderHttpError(404, 'payment_not_found', null)];

  await webhookQueue.add(event.id);
  await waitFor(async () => (await stateOf(late)) === 'failed');
  assert.equal(refundCalls.length, 1);
  const { rows } = await shop.admin.query('SELECT status, last_error FROM deliveries WHERE order_id = $1', [late.id]);
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].last_error, /404 payment_not_found/);
  assert.deepEqual((await history(late)).slice(-2), ['refund_pending', 'failed']);
});

test('webhook job: retries used up (3 attempts) also ends as failed', async () => {
  const late = await pendingOrder();
  await expire(late);
  await pendingOrder();
  const event = eventFor(late);
  await db.insertPaymentEvent(event);
  provider.failures = [1, 2, 3].map(() => new ProviderHttpError(503, null, null));

  await webhookQueue.add(event.id);
  await waitFor(async () => (await stateOf(late)) === 'failed');
  assert.equal(refundCalls.length, 3);
});

async function waitFor(check, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('condition not reached in time');
}
