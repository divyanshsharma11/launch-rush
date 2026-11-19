// erp-sim Connector against the real ERP simulator (real HTTP, PostgreSQL and Redis) and, for statuses the
// simulator never sends, a small local server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createErpConnector, MissingDocumentError } from '../src/services/connectors/erp-sim.js';
import { UnsupportedActionError, UpstreamHttpError } from '../src/services/connectors/http-errors.js';
import { captureLogger } from './helpers.js';

const config = { ...loadErpSimConfig(process.env), port: 0 };
const admin = new pg.Client();
const redis = new Redis(config.redis);
const orderIds = [];
const runIds = [];
let sim;
let connector;

// Fake upstream: each test sets `respond`.
let respond = (req, res) => res.writeHead(200).end('{}');
const fake = createServer((req, res) => respond(req, res)).listen(0, '127.0.0.1');
await once(fake, 'listening');
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

before(async () => {
  sim = await startErpSimulator({ config, logger: captureLogger().logger });
  connector = connectorFor(`http://127.0.0.1:${sim.port}`);
  await admin.connect();
});

after(async () => {
  fake.closeAllConnections();
  fake.close();
  await redis.del(...runIds.map((id) => `faults:${id}`));
  for (const runId of runIds) await connector.execute('run.delete', { runId }, ctxFor(null));
  await admin.query('DELETE FROM erpsim.documents WHERE order_ref = ANY($1)', [orderIds]);
  await admin.end();
  await redis.quit();
  await sim.shutdown();
});

const connectorFor = (baseUrl, overrides = {}) =>
  createErpConnector({ baseUrl, apiKey: config.apiKey, apiSecret: config.apiSecret, ...overrides });

const ctxFor = (runId, timeoutMs = 5_000) => ({ orderId: null, runId, idempotencyKey: null, attempt: 1, timeoutMs });

function newOrder(runId = null) {
  const orderId = randomUUID();
  orderIds.push(orderId);
  const payload = { orderId, itemCode: 'elden-ring', amountMinor: 580000, currency: 'INR' };
  const ctx = { ...ctxFor(runId), orderId };
  return { orderId, payload, ctx, run: (action) => connector.execute(action, payload, ctx) };
}

function newRun() {
  const runId = randomUUID();
  runIds.push(runId);
  return runId;
}

async function seedRun(qty) {
  const runId = newRun();
  await connector.execute('stock.add', { receiptId: `run-${runId}`, itemCode: 'elden-ring', qty, runId }, ctxFor(null));
  return runId;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

const countDocuments = async (orderId) => (await admin.query(
  `SELECT doctype, count(*)::int AS n, min(docstatus) AS docstatus FROM erpsim.documents WHERE order_ref = $1 GROUP BY doctype`,
  [orderId],
)).rows.reduce((all, row) => ({ ...all, [row.doctype]: { n: row.n, docstatus: row.docstatus } }), {});

const available = async (scope) => (await admin.query(
  `SELECT available FROM erpsim.item_stock WHERE scope = $1 AND item_code = 'elden-ring'`, [scope],
)).rows[0]?.available;

test('id and capabilities (design §3, plus the simulator-only calls)', () => {
  assert.equal(connector.id, 'erp-sim');
  assert.deepEqual(connector.capabilities, [
    'sales_order.submit', 'stock.reserve', 'sales_invoice.submit', 'payment_entry.submit', 'stock.add', 'run.delete',
  ]);
});

test('order to cash: SO, reserve, SI and PE, each once and submitted; amounts go to the ERP in major units', async () => {
  const runId = await seedRun(1);
  const order = newOrder(runId);
  const so = await order.run('sales_order.submit');
  const sre = await order.run('stock.reserve');
  const si = await order.run('sales_invoice.submit');
  const pe = await order.run('payment_entry.submit');

  assert.match(so.name, /^SO-\d{4,}$/);
  assert.match(sre.name, /^SRE-\d{4,}$/);
  assert.match(si.name, /^SINV-\d{4,}$/);
  assert.match(pe.name, /^PE-\d{4,}$/);
  for (const doc of [so, sre, si, pe]) assert.equal(doc.docstatus, 1);
  assert.deepEqual(await countDocuments(order.orderId), {
    'Sales Order': { n: 1, docstatus: 1 }, 'Stock Reservation Entry': { n: 1, docstatus: 1 },
    'Sales Invoice': { n: 1, docstatus: 1 }, 'Payment Entry': { n: 1, docstatus: 1 },
  });

  const { rows } = await admin.query(
    `SELECT doctype, body FROM erpsim.documents WHERE order_ref = $1 AND doctype IN ('Sales Order', 'Payment Entry')`, [order.orderId],
  );
  const body = Object.fromEntries(rows.map((row) => [row.doctype, row.body]));
  assert.equal(body['Sales Order'].items[0].rate, 5800);
  assert.equal(body['Sales Order'].customer, 'Demo Customer');
  assert.equal(body['Sales Order'].currency, 'INR');
  assert.equal(body['Payment Entry'].paid_amount, 5800);
  assert.equal(body['Payment Entry'].references[0].reference_name, si.name);
});

test('idempotent: every action run twice returns the same document and creates no second one', async () => {
  const runId = await seedRun(2);
  const order = newOrder(runId);
  const actions = ['sales_order.submit', 'stock.reserve', 'sales_invoice.submit', 'payment_entry.submit'];
  const first = [];
  for (const action of actions) first.push(await order.run(action));
  for (const [i, action] of actions.entries()) assert.deepEqual(await order.run(action), first[i], action);
  for (const { n } of Object.values(await countDocuments(order.orderId))) assert.equal(n, 1);
  assert.equal(await available(`run:${runId}`), 1, 'the repeated reserve took no second copy');
});

test('a retry after a crash between create and submit finds the draft and submits it (no second document)', async () => {
  const order = newOrder();
  const headers = { Authorization: `token ${config.apiKey}:${config.apiSecret}`, 'Content-Type': 'application/json' };
  const created = await fetch(`http://127.0.0.1:${sim.port}/api/resource/Sales%20Order`, {
    method: 'POST', headers,
    body: JSON.stringify({ customer: 'Demo Customer', items: [{ item_code: 'elden-ring', qty: 1, rate: 5800 }], order_ref: order.orderId }),
  });
  const draft = (await created.json()).data;
  assert.equal(draft.docstatus, 0);

  const so = await order.run('sales_order.submit');
  assert.deepEqual(so, { name: draft.name, docstatus: 1 });
  assert.deepEqual((await countDocuments(order.orderId))['Sales Order'], { n: 1, docstatus: 1 });
});

test('a step whose parent document is missing fails as MissingDocumentError, classified permanent', async () => {
  const order = newOrder();
  for (const action of ['stock.reserve', 'sales_invoice.submit', 'payment_entry.submit']) {
    const err = await rejection(order.run(action));
    assert.ok(err instanceof MissingDocumentError, action);
    assert.deepEqual(connector.classifyError(err), { kind: 'permanent' });
  }
  assert.deepEqual(await countDocuments(order.orderId), {});
});

test('the demo run has its own quantity: reserve takes the run\'s copy, never the shop\'s; a second order finds none (409, permanent)', async () => {
  const shopBefore = await available('shop');
  const runId = await seedRun(1);
  const first = newOrder(runId);
  const second = newOrder(runId);
  for (const order of [first, second]) await order.run('sales_order.submit');

  await first.run('stock.reserve');
  const err = await rejection(second.run('stock.reserve'));
  assert.ok(err instanceof UpstreamHttpError);
  assert.deepEqual({ status: err.status, code: err.code }, { status: 409, code: 'InsufficientStock' });
  assert.deepEqual(connector.classifyError(err), { kind: 'permanent' });
  assert.equal(await available(`run:${runId}`), 0);
  assert.equal(await available('shop'), shopBefore);
});

test('stock.add: a repeated receipt id adds nothing; run.delete removes the run\'s documents and quantity', async () => {
  const runId = newRun();
  const add = (receiptId, qty) => connector.execute('stock.add', { receiptId, itemCode: 'elden-ring', qty, runId }, ctxFor(null));
  assert.deepEqual(await add(`a-${runId}`, 2), { applied: true });
  assert.deepEqual(await add(`a-${runId}`, 2), { applied: false });
  assert.equal(await available(`run:${runId}`), 2);

  const order = newOrder(runId);
  await order.run('sales_order.submit');
  assert.deepEqual(await connector.execute('run.delete', { runId }, ctxFor(null)), { documents: 1, quantities: 1 });
  assert.equal(await available(`run:${runId}`), undefined);

  const unknown = await rejection(connector.execute('stock.add', { receiptId: `u-${runId}`, itemCode: 'nope', qty: 1 }, ctxFor(null)));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.code, 'DoesNotExistError');
});

test('simulator faults reach the connector as the right error classes: down 503 retryable, 429 rateLimited, 500 retryable', async () => {
  const runId = await seedRun(5);
  const order = newOrder(runId);
  const set = (faults) => redis.set(`faults:${runId}`, JSON.stringify(faults));

  await set({ down: true });
  const down = await rejection(order.run('sales_order.submit'));
  assert.equal(down.status, 503);
  assert.deepEqual(connector.classifyError(down), { kind: 'retryable' });

  await set({ rateLimitPerSec: 1 });
  let limited;
  for (let i = 0; i < 5 && !limited; i++) limited = await order.run('sales_order.submit').then(() => null, (err) => err);
  assert.equal(limited.status, 429);
  assert.deepEqual(connector.classifyError(limited), { kind: 'rateLimited', retryAfterMs: 1000 });

  await set({ failureRate: 1 });
  const failing = await rejection(order.run('sales_order.submit'));
  assert.equal(failing.status, 500);
  assert.deepEqual(connector.classifyError(failing), { kind: 'retryable' });

  await redis.del(`faults:${runId}`);
  assert.equal((await order.run('sales_order.submit')).docstatus, 1);
});

test('slow ERP: a latency fault longer than the call timeout is a TimeoutError, classified retryable', async () => {
  const runId = newRun();
  await redis.set(`faults:${runId}`, JSON.stringify({ latencyMs: 600 }));
  const order = newOrder(runId);
  const err = await rejection(connector.execute('sales_order.submit', order.payload, { ...order.ctx, timeoutMs: 200 }));
  assert.equal(err.name, 'TimeoutError');
  assert.deepEqual(connector.classifyError(err), { kind: 'retryable' });
});

test('a wrong key or secret: 401 AuthenticationError, permanent, and neither appears in the message', async () => {
  const order = newOrder();
  const url = `http://127.0.0.1:${sim.port}`;
  for (const wrong of [connectorFor(url, { apiKey: 'x'.repeat(32) }), connectorFor(url, { apiSecret: 'x'.repeat(32) })]) {
    const err = await rejection(wrong.execute('sales_order.submit', order.payload, order.ctx));
    assert.deepEqual({ status: err.status, code: err.code }, { status: 401, code: 'AuthenticationError' });
    assert.deepEqual(wrong.classifyError(err), { kind: 'permanent' });
    assert.ok(!err.message.includes(config.apiKey) && !err.message.includes(config.apiSecret));
  }
});

test('unknown action: UnsupportedActionError, permanent', async () => {
  const err = await rejection(connector.execute('sales_order.cancel', {}, ctxFor(null)));
  assert.ok(err instanceof UnsupportedActionError);
  assert.deepEqual(connector.classifyError(err), { kind: 'permanent' });
});

test('status classes: 5xx and 408 retryable; 400, 401, 403, 404, 409 and other 4xx permanent; reply code is exc_type', async () => {
  const fakeConnector = connectorFor(fakeUrl);
  const expected = {
    500: 'retryable', 502: 'retryable', 503: 'retryable', 504: 'retryable', 408: 'retryable',
    400: 'permanent', 401: 'permanent', 403: 'permanent', 404: 'permanent', 409: 'permanent', 413: 'permanent',
  };
  for (const [status, kind] of Object.entries(expected)) {
    respond = (req, res) => res.writeHead(Number(status)).end(JSON.stringify({ exc_type: 'SomeError', exc: 'x' }));
    const err = await rejection(fakeConnector.execute('stock.add', { receiptId: 'r', itemCode: 'x', qty: 1 }, ctxFor(null)));
    assert.equal(err.status, Number(status));
    assert.equal(err.code, 'SomeError');
    assert.equal(fakeConnector.classifyError(err).kind, kind, `HTTP ${status}`);
  }
  respond = (req, res) => res.writeHead(500).end('<html>');
  assert.equal((await rejection(fakeConnector.execute('stock.add', { receiptId: 'r', itemCode: 'x', qty: 1 }, ctxFor(null)))).code, null);
});

test('429: Retry-After seconds or HTTP-date -> rateLimited(ms); missing or unreadable -> retryable', async () => {
  const fakeConnector = connectorFor(fakeUrl);
  const classify = async (headers) => {
    respond = (req, res) => res.writeHead(429, headers).end();
    return fakeConnector.classifyError(await rejection(fakeConnector.execute('run.delete', { runId: randomUUID() }, ctxFor(null))));
  };
  assert.deepEqual(await classify({ 'Retry-After': '7' }), { kind: 'rateLimited', retryAfterMs: 7_000 });
  const byDate = await classify({ 'Retry-After': new Date(Date.now() + 30_000).toUTCString() });
  assert.equal(byDate.kind, 'rateLimited');
  assert.ok(byDate.retryAfterMs > 28_000 && byDate.retryAfterMs <= 30_000, `${byDate.retryAfterMs} ms`);
  assert.deepEqual(await classify({}), { kind: 'retryable' });
  assert.deepEqual(await classify({ 'Retry-After': 'soon' }), { kind: 'retryable' });
});

test('network errors are retryable: connection refused, timeout, a 2xx reply that is not JSON', async () => {
  const probe = createNetServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const closedUrl = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  const call = (url, ctx = ctxFor(null)) => connectorFor(url).execute('run.delete', { runId: randomUUID() }, ctx);

  const refused = await rejection(call(closedUrl));
  assert.equal(refused.cause?.code, 'ECONNREFUSED');
  respond = () => {}; // never answers; closed in after()
  const timedOut = await rejection(call(fakeUrl, ctxFor(null, 200)));
  assert.equal(timedOut.name, 'TimeoutError');
  respond = (req, res) => res.writeHead(200).end('not json');
  const notJson = await rejection(call(fakeUrl));
  assert.equal(notJson.name, 'SyntaxError');

  for (const err of [refused, timedOut, notJson]) assert.deepEqual(connector.classifyError(err), { kind: 'retryable' });
});

test('healthCheck: true for the real simulator; false for a wrong key, a closed port, a timeout or an ERP that is down', async () => {
  assert.equal(await connector.healthCheck(), true);
  assert.equal(await connectorFor(`http://127.0.0.1:${sim.port}`, { apiKey: 'x'.repeat(32) }).healthCheck(), false);
  assert.equal(await connectorFor('http://127.0.0.1:1').healthCheck(), false);
  respond = () => {};
  assert.equal(await connectorFor(fakeUrl, { healthTimeoutMs: 200 }).healthCheck(), false);

  await redis.set('faults:shared', JSON.stringify({ down: true }));
  try {
    assert.equal(await connector.healthCheck(), false);
  } finally {
    await redis.del('faults:shared');
  }
  assert.equal(await connector.healthCheck(), true);
});
