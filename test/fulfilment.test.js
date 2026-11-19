// Fulfilment: the ERP steps of one order through the real connector, the real ERP simulator, PostgreSQL and Redis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createDb } from '../src/services/db/index.js';
import { createErpConnector } from '../src/services/connectors/erp-sim.js';
import { createFulfilment } from '../src/business/fulfilment.js';
import { createFulfilmentJob } from '../src/jobs/fulfilment-job.js';
import { addErpItem, captureLogger, createTestShop, erpShopQty, removeErpItem } from './helpers.js';

const env = process.env;
const base = loadConfig(env);
const simConfig = { ...loadErpSimConfig(env), port: 0 };
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const redis = new Redis(base.redis);
const emailJobs = [];
const faultKeys = [];
let shop;
let sim;
let erp;
let fulfilment;

before(async () => {
  shop = await createTestShop({ stockTotal: 10 });
  await addErpItem(shop.admin, shop.gameId, 10);
  sim = await startErpSimulator({ config: simConfig, logger: captureLogger().logger });
  erp = createErpConnector({ baseUrl: `http://127.0.0.1:${sim.port}`, apiKey: simConfig.apiKey, apiSecret: simConfig.apiSecret });
  fulfilment = createFulfilment({ db, erp, emailQueue: { add: async (id) => emailJobs.push(id) }, config: base.erp, logger });
});

after(async () => {
  await redis.del(...faultKeys);
  await shop.admin.query('DELETE FROM demo_runs WHERE game_id = $1', [shop.gameId]);
  await removeErpItem(shop.admin, shop.gameId);
  await shop.remove();
  await sim.shutdown();
  await redis.quit();
  await db.close();
});

// A paid order for the test game. runId: a demo run (its own ERP quantity and fault settings); email: a given address.
async function paidOrder({ runId = null, email = null, simulated = false } = {}) {
  const sessionId = simulated ? null : await shop.newSession();
  const order = await db.insertOrder({
    id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', runId,
    buyerRef: runId ? randomUUID() : null, isSimulated: simulated, holdMs: 300_000,
  });
  assert.ok(await db.transition(order.id, 'reserved', 'payment_pending', { email }));
  assert.ok(await db.transition(order.id, 'payment_pending', 'paid'));
  return order;
}

async function newRun(erpQty) {
  const sessionId = await shop.newSession();
  const { rows } = await shop.admin.query(
    `INSERT INTO demo_runs (session_id, game_id, stock_total, buyers_requested, faults, status, ends_at)
     VALUES ($1, $2, 5, 5, '{}', 'running', now() + interval '5 minutes') RETURNING id`,
    [sessionId, shop.gameId],
  );
  const runId = rows[0].id;
  faultKeys.push(`faults:${runId}`);
  if (erpQty > 0) {
    await erp.execute('stock.add', { receiptId: `run-${runId}`, itemCode: shop.gameId, qty: erpQty, runId }, { timeoutMs: 5000 });
  }
  return runId;
}

const documents = async (orderId) => (await shop.admin.query(
  'SELECT doctype, name, docstatus FROM erp_documents WHERE order_id = $1 ORDER BY doctype', [orderId],
)).rows;
const deliveries = async (orderId) => (await shop.admin.query(
  'SELECT action, status, attempts, last_error FROM deliveries WHERE order_id = $1 ORDER BY action', [orderId],
)).rows;
const history = async (orderId) => (await shop.admin.query(
  'SELECT from_state, to_state FROM order_transitions WHERE order_id = $1 ORDER BY id', [orderId],
)).rows.map((row) => `${row.from_state}>${row.to_state}`);
const erpCount = async (orderId) => (await shop.admin.query(
  'SELECT count(*)::int AS n FROM erpsim.documents WHERE order_ref = $1', [orderId],
)).rows[0].n;

test('a paid shop order goes paid -> so_submitted -> invoiced -> completed with its four ERP documents', async () => {
  const order = await paidOrder();
  const qtyBefore = await erpShopQty(shop.admin, shop.gameId);
  await fulfilment.process(order.id);

  assert.equal((await db.getOrder(order.id)).state, 'completed');
  assert.deepEqual(await history(order.id), [
    'null>reserved', 'reserved>payment_pending', 'payment_pending>paid', 'paid>so_submitted', 'so_submitted>invoiced', 'invoiced>completed',
  ]);
  const docs = await documents(order.id);
  assert.deepEqual(docs.map((doc) => [doc.doctype, doc.docstatus]), [
    ['Payment Entry', 1], ['Sales Invoice', 1], ['Sales Order', 1], ['Stock Reservation Entry', 1],
  ]);
  assert.match(docs.find((doc) => doc.doctype === 'Sales Invoice').name, /^SINV-\d{4,}$/);
  assert.deepEqual(
    (await deliveries(order.id)).map((row) => [row.action, row.status, row.attempts]),
    [['payment_entry.submit', 'succeeded', 1], ['sales_invoice.submit', 'succeeded', 1], ['sales_order.submit', 'succeeded', 1], ['stock.reserve', 'succeeded', 1]],
  );
  assert.equal(await erpShopQty(shop.admin, shop.gameId), qtyBefore - 1, 'one copy reserved in the ERP');

  const { sessionId } = await db.getOrder(order.id);
  const card = await db.getSessionOrder(sessionId, order.id);
  assert.equal(card.invoiceNo, docs.find((doc) => doc.doctype === 'Sales Invoice').name);
  assert.ok(lines.some((line) => line.msg === 'order fulfilled' && line.orderId === order.id));
});

test('the email job is added only for an order with an address or a simulated run order', async () => {
  const none = await paidOrder();
  const withEmail = await paidOrder({ email: 'buyer@example.com' });
  const runId = await newRun(5);
  const simulated = await paidOrder({ runId, simulated: true });
  emailJobs.length = 0;
  for (const order of [none, withEmail, simulated]) await fulfilment.process(order.id);
  assert.deepEqual(emailJobs, [withEmail.id, simulated.id]);
});

test('a repeat of a finished order creates nothing new (and adds the email job again: BullMQ ignores a repeat)', async () => {
  const order = await paidOrder({ email: 'buyer@example.com' });
  await fulfilment.process(order.id);
  const before = { documents: await erpCount(order.id), deliveries: await deliveries(order.id), history: await history(order.id) };
  emailJobs.length = 0;
  await fulfilment.process(order.id);
  assert.equal(await erpCount(order.id), before.documents);
  assert.deepEqual(await deliveries(order.id), before.deliveries);
  assert.deepEqual(await history(order.id), before.history);
  assert.deepEqual(emailJobs, [order.id]);
});

test('a crash after the ERP steps but before the state change: the retry finds the documents and only moves the order on', async () => {
  const runId = await newRun(3);
  const order = await paidOrder({ runId });
  const ctx = { orderId: order.id, runId, timeoutMs: 5000 };
  const payload = { orderId: order.id, itemCode: shop.gameId, amountMinor: order.amountMinor, currency: order.currency };
  const so = await erp.execute('sales_order.submit', payload, ctx); // done in the ERP, order still `paid`
  await erp.execute('stock.reserve', payload, ctx);

  await fulfilment.process(order.id);
  assert.equal((await db.getOrder(order.id)).state, 'completed');
  assert.equal((await documents(order.id)).find((doc) => doc.doctype === 'Sales Order').name, so.name);
  assert.equal(await erpCount(order.id), 4);
});

test('an order that is not paid, so_submitted or invoiced is left alone, with no ERP call', async () => {
  const runId = await newRun(2);
  await redis.set(`faults:${runId}`, JSON.stringify({ down: true })); // any ERP call would throw
  const failed = await paidOrder({ runId });
  assert.ok(await db.transition(failed.id, 'paid', 'failed'));
  const unpaid = await db.insertOrder({
    id: randomUUID(), sessionId: await shop.newSession(), gameId: shop.gameId, state: 'reserved', holdMs: 300_000,
  });
  for (const order of [failed, unpaid]) await fulfilment.process(order.id);
  await fulfilment.process(randomUUID());
  assert.equal((await db.getOrder(failed.id)).state, 'failed');
  assert.equal((await db.getOrder(unpaid.id)).state, 'reserved');
  assert.equal(await erpCount(failed.id), 0);
});

test('ERP down: the step throws, the order stays paid and the delivery shows the attempt; after the fault clears it completes', async () => {
  const runId = await newRun(2);
  const order = await paidOrder({ runId });
  await redis.set(`faults:${runId}`, JSON.stringify({ down: true }));

  const err = await fulfilment.process(order.id).then(() => null, (e) => e);
  assert.equal(err.status, 503);
  assert.deepEqual(erp.classifyError(err), { kind: 'retryable' });
  assert.equal((await db.getOrder(order.id)).state, 'paid');
  assert.deepEqual(await deliveries(order.id), [
    { action: 'sales_order.submit', status: 'pending', attempts: 1, last_error: 'ERP replied HTTP 503 ServiceUnavailable' },
  ]);

  await redis.del(`faults:${runId}`);
  await fulfilment.process(order.id, { attempt: 2 });
  assert.equal((await db.getOrder(order.id)).state, 'completed');
  const sales = (await deliveries(order.id)).find((row) => row.action === 'sales_order.submit');
  assert.deepEqual(
    { status: sales.status, attempts: sales.attempts, last_error: sales.last_error },
    { status: 'succeeded', attempts: 2, last_error: null },
  );
});

test('a permanent ERP error (no quantity left): markFailed moves the order to failed and fails the pending delivery only', async () => {
  const runId = await newRun(0); // the ERP holds no copy for this run
  const order = await paidOrder({ runId });
  const err = await fulfilment.process(order.id).then(() => null, (e) => e);
  assert.deepEqual({ status: err.status, code: err.code }, { status: 409, code: 'InsufficientStock' });
  assert.deepEqual(erp.classifyError(err), { kind: 'permanent' });
  assert.equal((await db.getOrder(order.id)).state, 'so_submitted');

  await fulfilment.markFailed(order.id, err);
  assert.equal((await db.getOrder(order.id)).state, 'failed');
  assert.deepEqual(
    (await deliveries(order.id)).map((row) => [row.action, row.status]),
    [['sales_order.submit', 'succeeded'], ['stock.reserve', 'failed']],
  );
  assert.equal((await history(order.id)).at(-1), 'so_submitted>failed');
  assert.ok(lines.some((line) => line.msg === 'fulfilment failed for good' && line.orderId === order.id));

  await fulfilment.markFailed(order.id, err); // a repeat changes nothing
  assert.equal((await history(order.id)).filter((step) => step.endsWith('>failed')).length, 1);
});

test('markFailed leaves a completed order alone', async () => {
  const done = await paidOrder();
  await fulfilment.process(done.id);
  await fulfilment.markFailed(done.id, new Error('late'));
  assert.equal((await db.getOrder(done.id)).state, 'completed');
});

test('the job turns errors into BullMQ outcomes: retryable throws, permanent is unrecoverable, rateLimited delays without an attempt', async () => {
  const calls = [];
  const failing = (err) => ({ process: async () => { throw err; }, markFailed: async (id, e) => calls.push([id, e]) });
  const job = { data: { orderId: 'o-1' }, attemptsMade: 2, moveToDelayed: async (at, token) => calls.push(['delayed', at, token]) };
  const classify = (kind) => () => ({ kind, retryAfterMs: 1000 });
  const jobFor = (err, kind) => createFulfilmentJob({ fulfilment: failing(err), classifyError: classify(kind) });

  const retryable = new Error('boom');
  await assert.rejects(jobFor(retryable, 'retryable').process(job, 't'), (err) => err === retryable);
  await assert.rejects(jobFor(new Error('bad'), 'permanent').process(job, 't'), UnrecoverableError);
  const before = Date.now();
  await assert.rejects(jobFor(new Error('slow'), 'rateLimited').process(job, 't'), DelayedError);
  const delayed = calls.find((call) => call[0] === 'delayed');
  assert.ok(delayed[1] >= before + 1000 && delayed[2] === 't');

  let attempt;
  const ok = { process: async (id, options) => { attempt = options.attempt; }, markFailed: async (id, e) => calls.push([id, e]) };
  const okJob = createFulfilmentJob({ fulfilment: ok, classifyError: classify('retryable') });
  await okJob.process(job, 't');
  assert.equal(attempt, 3, 'attempt = attemptsMade + 1');
  const final = new Error('gave up');
  await okJob.onFinalFailure(job, final);
  assert.deepEqual(calls.at(-1), ['o-1', final]);
});
