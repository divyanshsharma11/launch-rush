// payment-mock Connector against the real mock provider app (real HTTP, real DB) and, for statuses the
// provider never sends, a small local server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createProviderDb } from '../sims/payment-provider/db.js';
import { createProviderApp } from '../sims/payment-provider/app.js';
import { createPaymentConnector, ProviderHttpError, UnsupportedActionError } from '../src/services/connectors/payment-mock.js';
import { captureLogger } from './helpers.js';

const API_KEY = 'k'.repeat(32);
const providerDb = createProviderDb({ logger: captureLogger().logger });
const admin = new pg.Client();
await admin.connect();
const orderIds = [];

const provider = createProviderApp({ db: providerDb, config: { apiKey: API_KEY, runDuplicateShare: 0 }, logger: captureLogger().logger })
  .listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerUrl = `http://127.0.0.1:${provider.address().port}`;

// Fake upstream: each test sets `respond`.
let respond = (req, res) => res.writeHead(200).end('{}');
const fake = createServer((req, res) => respond(req, res)).listen(0, '127.0.0.1');
await once(fake, 'listening');
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

after(async () => {
  provider.closeAllConnections();
  provider.close();
  fake.closeAllConnections();
  fake.close();
  const payments = 'SELECT id FROM paysim.payments WHERE order_id = ANY($1::uuid[])';
  await admin.query(
    `DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id IN (${payments}))`,
    [orderIds],
  );
  await admin.query(`DELETE FROM paysim.events WHERE payment_id IN (${payments})`, [orderIds]);
  await admin.query(`DELETE FROM paysim.refunds WHERE payment_id IN (${payments})`, [orderIds]);
  await admin.query('DELETE FROM paysim.payments WHERE order_id = ANY($1::uuid[])', [orderIds]);
  await admin.end();
  await providerDb.close();
});

const connector = createPaymentConnector({ baseUrl: providerUrl, apiKey: API_KEY });

function newOrder(runId = null) {
  const orderId = randomUUID();
  orderIds.push(orderId);
  return {
    payload: { orderId, amountMinor: 580000, currency: 'INR' },
    ctx: (key) => ({ orderId, runId, idempotencyKey: `${key}-${orderId}`, attempt: 1, timeoutMs: 5_000 }),
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

test('id and capabilities (design §3)', () => {
  assert.equal(connector.id, 'payment-mock');
  assert.deepEqual(connector.capabilities, ['charge', 'refund', 'resend_webhook', 'redeliver_failed']);
});

test('charge: the provider reply; a retry with the same key returns the same payment; X-Sim-Run sent for run orders', async () => {
  const shop = newOrder();
  const reply = await connector.execute('charge', shop.payload, shop.ctx('charge'));
  assert.match(reply.paymentId, /^pay_[0-9a-f]{32}$/);
  assert.deepEqual(reply, { paymentId: reply.paymentId, ...shop.payload });
  assert.deepEqual(await connector.execute('charge', shop.payload, shop.ctx('charge')), reply);

  const runId = randomUUID();
  const run = newOrder(runId);
  await connector.execute('charge', run.payload, run.ctx('charge'));
  const { rows } = await admin.query('SELECT idempotency_key, run_id FROM paysim.payments WHERE order_id = ANY($1::uuid[])', [
    [shop.payload.orderId, run.payload.orderId],
  ]);
  assert.deepEqual(
    new Set(rows.map((r) => `${r.idempotency_key}|${r.run_id}`)),
    new Set([`charge-${shop.payload.orderId}|null`, `charge-${run.payload.orderId}|${runId}`]),
  );
});

test('refund and resend_webhook: provider replies passed through', async () => {
  const order = newOrder();
  const { paymentId } = await connector.execute('charge', order.payload, order.ctx('charge'));
  const refund = await connector.execute('refund', { paymentId }, order.ctx('refund'));
  assert.match(refund.refundId, /^re_[0-9a-f]{32}$/);
  assert.equal(refund.paymentId, paymentId);
  const { rows } = await admin.query(`SELECT id FROM paysim.events WHERE payment_id = $1 AND type = 'payment.succeeded'`, [paymentId]);
  assert.deepEqual(await connector.execute('resend_webhook', { paymentId }, order.ctx('unused')), { eventId: rows[0].id });
});

test('redeliver_failed: failed deliveries of recent events are pending again; the reply is passed through', async () => {
  const order = newOrder();
  const { paymentId } = await connector.execute('charge', order.payload, order.ctx('charge'));
  await admin.query(
    "UPDATE paysim.deliveries SET status = 'failed' WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id = $1)",
    [paymentId],
  );
  const reply = await connector.execute('redeliver_failed', { maxAgeMs: 86_400_000 }, order.ctx('unused'));
  assert.ok(reply.redelivered >= 1);
  const { rows } = await admin.query(
    'SELECT d.status FROM paysim.deliveries d JOIN paysim.events e ON e.id = d.event_id WHERE e.payment_id = $1',
    [paymentId],
  );
  assert.deepEqual(rows, [{ status: 'pending' }]);
});

test('provider 400, 401, 404, 409 → ProviderHttpError with status and code, classified permanent', async () => {
  const order = newOrder();
  const { paymentId } = await connector.execute('charge', order.payload, order.ctx('charge'));
  const wrongKey = createPaymentConnector({ baseUrl: providerUrl, apiKey: 'x'.repeat(32) });
  const cases = [
    [400, 'invalid_request', () => connector.execute('charge', order.payload, { ...order.ctx('charge'), idempotencyKey: undefined })],
    [401, 'unauthorized', () => wrongKey.execute('charge', order.payload, order.ctx('charge'))],
    [404, 'payment_not_found', () => connector.execute('refund', { paymentId: `pay_${'0'.repeat(32)}` }, order.ctx('refund'))],
    [409, 'idempotency_conflict', () => connector.execute('charge', { ...order.payload, amountMinor: 1 }, order.ctx('charge'))],
    [409, 'already_refunded', async () => {
      await connector.execute('refund', { paymentId }, order.ctx('refund'));
      return connector.execute('refund', { paymentId }, order.ctx('other-refund-key'));
    }],
  ];
  for (const [status, code, call] of cases) {
    const err = await rejection(call());
    assert.ok(err instanceof ProviderHttpError, `${status} ${code}`);
    assert.deepEqual({ status: err.status, code: err.code }, { status, code });
    assert.deepEqual(connector.classifyError(err), { kind: 'permanent' });
    assert.ok(!err.message.includes(API_KEY), 'API key not in the message');
  }
});

test('unknown action → UnsupportedActionError, permanent', async () => {
  const err = await rejection(connector.execute('capture', {}, newOrder().ctx('x')));
  assert.ok(err instanceof UnsupportedActionError);
  assert.deepEqual(connector.classifyError(err), { kind: 'permanent' });
});

test('status classes: 5xx and 408 retryable, other 4xx permanent', async () => {
  const fakeConnector = createPaymentConnector({ baseUrl: fakeUrl, apiKey: API_KEY });
  const expected = { 500: 'retryable', 502: 'retryable', 503: 'retryable', 504: 'retryable', 408: 'retryable', 403: 'permanent', 413: 'permanent' };
  for (const [status, kind] of Object.entries(expected)) {
    respond = (req, res) => res.writeHead(Number(status)).end();
    const err = await rejection(fakeConnector.execute('resend_webhook', { paymentId: 'pay_x' }, newOrder().ctx('x')));
    assert.equal(err.status, Number(status));
    assert.equal(err.code, null);
    assert.equal(connector.classifyError(err).kind, kind, `HTTP ${status}`);
  }
});

test('429: Retry-After seconds or HTTP-date → rateLimited(ms); missing or unreadable → retryable', async () => {
  const fakeConnector = createPaymentConnector({ baseUrl: fakeUrl, apiKey: API_KEY });
  const classify = async (headers) => {
    respond = (req, res) => res.writeHead(429, headers).end();
    return connector.classifyError(await rejection(fakeConnector.execute('resend_webhook', { paymentId: 'pay_x' }, newOrder().ctx('x'))));
  };
  assert.deepEqual(await classify({ 'Retry-After': '7' }), { kind: 'rateLimited', retryAfterMs: 7_000 });
  const inThirty = new Date(Date.now() + 30_000).toUTCString(); // IMF-fixdate, whole seconds
  const byDate = await classify({ 'Retry-After': inThirty });
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
  const refused = await rejection(createPaymentConnector({ baseUrl: closedUrl, apiKey: API_KEY }).execute('resend_webhook', { paymentId: 'pay_x' }, newOrder().ctx('x')));
  assert.equal(refused.cause?.code, 'ECONNREFUSED');

  const fakeConnector = createPaymentConnector({ baseUrl: fakeUrl, apiKey: API_KEY });
  respond = () => {}; // never answers; closed in after()
  const timedOut = await rejection(fakeConnector.execute('resend_webhook', { paymentId: 'pay_x' }, { ...newOrder().ctx('x'), timeoutMs: 200 }));
  assert.equal(timedOut.name, 'TimeoutError');

  respond = (req, res) => res.writeHead(200).end('not json');
  const notJson = await rejection(fakeConnector.execute('resend_webhook', { paymentId: 'pay_x' }, newOrder().ctx('x')));
  assert.equal(notJson.name, 'SyntaxError');

  for (const err of [refused, timedOut, notJson]) assert.deepEqual(connector.classifyError(err), { kind: 'retryable' });
});

test('healthCheck: true for the real provider; false for a wrong key, a closed port or a timeout (never throws)', async () => {
  assert.equal(await connector.healthCheck(), true);
  assert.equal(await createPaymentConnector({ baseUrl: providerUrl, apiKey: 'x'.repeat(32) }).healthCheck(), false);
  assert.equal(await createPaymentConnector({ baseUrl: 'http://127.0.0.1:1', apiKey: API_KEY }).healthCheck(), false);
  respond = () => {};
  assert.equal(await createPaymentConnector({ baseUrl: fakeUrl, apiKey: API_KEY, healthTimeoutMs: 200 }).healthCheck(), false);
});
