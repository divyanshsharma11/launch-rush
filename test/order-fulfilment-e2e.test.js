// Step 5 end to end, in one process with real parts: buy and pay → mock provider → signed webhook → ingress →
// webhook worker → fulfilment worker → ERP simulator → completed order with an invoice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadConfig } from '../src/config.js';
import { loadProviderConfig } from '../sims/payment-provider/config.js';
import { startProvider } from '../sims/payment-provider/start.js';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createWakeups } from '../src/services/redis/wakeups.js';
import { createFulfilmentQueue, createWebhookQueue, createWorker } from '../src/services/queue/index.js';
import { createInboundVerifier, createPaymentConnector } from '../src/services/connectors/payment-mock.js';
import { createErpConnector } from '../src/services/connectors/erp-sim.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createPayments } from '../src/business/payments.js';
import { createPaymentEvents } from '../src/business/payment-events.js';
import { createFulfilment } from '../src/business/fulfilment.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createStream } from '../src/business/stream.js';
import { createWebhookRouter } from '../src/controllers/webhook.js';
import { createWebhookJob } from '../src/jobs/webhook-job.js';
import { createFulfilmentJob } from '../src/jobs/fulfilment-job.js';
import { addErpItem, captureLogger, createTestShop, erpShopQty, removeErpItem } from './helpers.js';

const base = loadConfig(process.env);
const providerBase = loadProviderConfig(process.env);
const simConfig = { ...loadErpSimConfig(process.env), port: 0 };
const { logger } = captureLogger();
const redis = createRedis({ redis: base.redis, logger });
const db = createDb({ logger, onOrderChange: (orderId, sessionId) => redis.notifyOrder(orderId, sessionId) });
const wakeups = createWakeups({ redis: base.redis, logger });
const raw = new Redis(base.redis);
const suffix = randomUUID();
const jobOptions = { attempts: 8, backoff: { type: 'fixed', delay: 100 }, removeOnComplete: true, removeOnFail: true };
const emailJobs = [];
const orderIds = [];
let shop;
let provider;
let sim;
let ingress;
let webhookQueue;
let fulfilmentQueue;
let orders;
let reconciler;
let stream;
const workers = [];
const inspect = [];

before(async () => {
  await redis.ready();
  shop = await createTestShop({ stockTotal: 3 });
  await addErpItem(shop.admin, shop.gameId, 3);
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 3 }]);

  sim = await startErpSimulator({ config: simConfig, logger: captureLogger().logger });
  const erp = createErpConnector({ baseUrl: `http://127.0.0.1:${sim.port}`, apiKey: simConfig.apiKey, apiSecret: simConfig.apiSecret });

  const webhooksName = `webhooks-e2e-${suffix}`;
  const fulfilmentName = `fulfilment-e2e-${suffix}`;
  webhookQueue = createWebhookQueue({ redis: base.redis, jobOptions, logger, name: webhooksName });
  fulfilmentQueue = createFulfilmentQueue({ redis: base.redis, jobOptions, logger, name: fulfilmentName });
  inspect.push(new Queue(webhooksName, { connection: base.redis }), new Queue(fulfilmentName, { connection: base.redis }));

  const verifier = createInboundVerifier({
    secret: base.payment.webhookSecret, toleranceSeconds: base.payment.webhookToleranceSeconds,
  });
  const app = express();
  app.use(createWebhookRouter({ payments: createPayments({ verifier, db, webhookQueue, logger }), logger }));
  ingress = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  provider = await startProvider({
    config: {
      ...providerBase,
      port: 0,
      webhookUrl: `http://127.0.0.1:${ingress.address().port}/webhooks/payment`,
      delivery: { ...providerBase.delivery, pollMs: 50 },
    },
    logger: captureLogger().logger,
  });
  const payment = createPaymentConnector({ baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: base.payment.apiKey });

  const stockGate = createStockGate({ db, redis, config: base.stock, logger });
  orders = createOrders({ db, redis, stockGate, payment, config: base, logger });
  reconciler = createReconciler({ db, redis, config: base.reconciler });
  await wakeups.ready();
  stream = createStream({ db, redis, wakeups, reconciler, config: base.stream, logger });

  const paymentEvents = createPaymentEvents({ db, redis, payment, fulfilmentQueue, config: base.payment, logger });
  const webhookJob = createWebhookJob({ db, paymentEvents, classifyError: payment.classifyError });
  workers.push(createWorker({
    name: webhooksName,
    redis: base.redis,
    processor: (job, token) => webhookJob.process(job, token),
    onFinalFailure: (job, err) => webhookJob.onFinalFailure(job, err),
    logger,
  }));

  const fulfilment = createFulfilment({
    db, erp, emailQueue: { add: async (orderId) => emailJobs.push(orderId) }, config: base.erp, logger,
  });
  const fulfilmentJob = createFulfilmentJob({ fulfilment, classifyError: erp.classifyError });
  workers.push(createWorker({
    name: fulfilmentName,
    redis: base.redis,
    processor: (job, token) => fulfilmentJob.process(job, token),
    onFinalFailure: (job, err) => fulfilmentJob.onFinalFailure(job, err),
    logger,
  }));
});

after(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await webhookQueue.close();
  await fulfilmentQueue.close();
  for (const queue of inspect) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await provider.shutdown();
  await new Promise((resolve) => ingress.close(resolve));
  await raw.del('faults:shared');
  const payments = 'SELECT id FROM paysim.payments WHERE order_id = ANY($1)';
  const events = `SELECT id FROM paysim.events WHERE payment_id IN (${payments})`;
  await shop.admin.query(`DELETE FROM paysim.deliveries WHERE event_id IN (${events})`, [orderIds]);
  await shop.admin.query(`DELETE FROM paysim.events WHERE payment_id IN (${payments})`, [orderIds]);
  await shop.admin.query(`DELETE FROM paysim.refunds WHERE payment_id IN (${payments})`, [orderIds]);
  await shop.admin.query('DELETE FROM paysim.payments WHERE order_id = ANY($1)', [orderIds]);
  await shop.admin.query('DELETE FROM erpsim.documents WHERE order_ref = ANY($1)', [orderIds]);
  await shop.admin.query('DELETE FROM payment_events WHERE order_id = ANY($1)', [orderIds]);
  await removeErpItem(shop.admin, shop.gameId);
  await raw.del(...['stock', 'holds', 'waitlist', 'tickets', 'grants', 'buyers', 'receipts'].map((kind) => `${kind}:${shopPool(shop.gameId)}`));
  await shop.remove();
  await sim.shutdown();
  await wakeups.close();
  await redis.close();
  await raw.quit();
  await db.close();
});

async function waitFor(check, what, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function buyAndPay(email = 'buyer@example.com') {
  const sessionId = await shop.newSession();
  const { orderId } = await orders.buy(sessionId, { gameId: shop.gameId });
  orderIds.push(orderId);
  await orders.pay(sessionId, orderId, { email });
  return { sessionId, orderId };
}

const stateOf = async (orderId) => (await db.getOrder(orderId)).state;

test('a paid order is fulfilled in the ERP: completed, with an invoice on the order card, an email job and a clean scoreboard', async () => {
  const { sessionId, orderId } = await buyAndPay();
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order');

  const card = await orders.getOrder(sessionId, orderId);
  assert.equal(card.state, 'completed');
  assert.ok(card.invoiceNo, 'the order card shows the invoice number');
  const { rows } = await shop.admin.query(
    `SELECT doctype, name, docstatus FROM erpsim.documents WHERE order_ref = $1 ORDER BY doctype`, [orderId],
  );
  assert.deepEqual(rows.map((r) => [r.doctype, r.docstatus]), [
    ['Payment Entry', 1], ['Sales Invoice', 1], ['Sales Order', 1], ['Stock Reservation Entry', 1],
  ]);
  assert.equal(rows.find((r) => r.doctype === 'Sales Invoice').name, card.invoiceNo);
  assert.deepEqual(emailJobs, [orderId]);
  assert.equal(await erpShopQty(shop.admin, shop.gameId), 2, 'the ERP reserved one copy');

  const scoreboard = await reconciler.scoreboard();
  assert.equal(scoreboard.completedWithoutInvoice, 0);
  assert.ok(!scoreboard.stockMismatches.includes(shop.gameId));
});

test('the ERP is down when the order is paid: the job keeps retrying and the order completes once the ERP is back', async () => {
  await raw.set('faults:shared', JSON.stringify({ down: true }));
  const { orderId } = await buyAndPay();
  await waitFor(async () => {
    const { rows } = await shop.admin.query(
      `SELECT attempts FROM deliveries WHERE order_id = $1 AND action = 'sales_order.submit'`, [orderId],
    );
    return rows[0]?.attempts >= 2;
  }, 'two failed ERP attempts');
  assert.equal(await stateOf(orderId), 'paid');

  await raw.del('faults:shared');
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order after the ERP is back');
  const { rows } = await shop.admin.query('SELECT count(*)::int AS n FROM erpsim.documents WHERE order_ref = $1', [orderId]);
  assert.equal(rows[0].n, 4, 'no document was created twice');
});

test('the webhook is delivered twice: the order is still fulfilled once', async () => {
  const { sessionId, orderId } = await buyAndPay();
  await waitFor(() => db.findSucceededPayment(orderId), 'the first webhook');
  await orders.resendWebhook(sessionId, orderId);
  await waitFor(async () => (await stateOf(orderId)) === 'completed', 'completed order');
  const { rows } = await shop.admin.query('SELECT count(*)::int AS n FROM erpsim.documents WHERE order_ref = $1', [orderId]);
  assert.equal(rows[0].n, 4);
});

// The events a session's stream sends, collected until it is closed. The shop game's three copies are used up by
// the tests above, so each stream test adds two.
function watch(sessionId) {
  const events = [];
  const close = stream.open(sessionId, (event, data) => events.push({ event, data: JSON.parse(JSON.stringify(data)) }));
  return { events, close, of: (name) => events.filter((e) => e.event === name).map((e) => e.data) };
}

async function topUp(copies) {
  await shop.admin.query("UPDATE erpsim.item_stock SET available = available + $2 WHERE scope = 'shop' AND item_code = $1", [shop.gameId, copies]);
  await raw.incrby(`stock:${shopPool(shop.gameId)}`, copies);
}

test('the stream shows the order moving through the whole pipeline, in order, with the invoice number', async () => {
  await topUp(2);
  const sessionId = await shop.newSession();
  const view = watch(sessionId);
  try {
    const { orderId } = await orders.buy(sessionId, { gameId: shop.gameId });
    orderIds.push(orderId);
    await orders.pay(sessionId, orderId, { email: 'buyer@example.com' });
    await waitFor(() => view.of('order.state').some((e) => e.to === 'completed'), 'completed on the stream');

    const own = view.of('order.state').filter((e) => e.orderId === orderId);
    assert.deepEqual(own.map((e) => e.to), ['reserved', 'payment_pending', 'paid', 'so_submitted', 'invoiced', 'completed']);
    assert.deepEqual(own.map((e) => e.from), [null, 'reserved', 'payment_pending', 'paid', 'so_submitted', 'invoiced']);
    assert.equal(own.at(-1).invoiceNo, (await orders.getOrder(sessionId, orderId)).invoiceNo);
    assert.equal(view.of('email.status').at(-1).emailStatus, 'pending'); // an address was given; the email job is a stand-in here
    assert.ok(view.of('stock').some((s) => s.gameId === shop.gameId));
  } finally {
    view.close();
  }
});

test('the stream says a step failed and will be tried again while the ERP is down, then the order completes', async () => {
  await raw.set('faults:shared', JSON.stringify({ down: true }));
  const sessionId = await shop.newSession();
  const view = watch(sessionId);
  try {
    const { orderId } = await orders.buy(sessionId, { gameId: shop.gameId });
    orderIds.push(orderId);
    await orders.pay(sessionId, orderId);
    await waitFor(() => view.of('delivery.retrying').length >= 2, 'two retry events');
    const [first, second] = view.of('delivery.retrying');
    assert.deepEqual(
      [first.orderId, first.connector, first.action, first.attempt, first.errorClass],
      [orderId, 'erp-sim', 'sales_order.submit', 1, 'retryable'],
    );
    assert.equal(second.attempt, 2);

    await raw.del('faults:shared');
    await waitFor(() => view.of('order.state').some((e) => e.to === 'completed'), 'completed after the ERP is back');
  } finally {
    await raw.del('faults:shared');
    view.close();
  }
});
