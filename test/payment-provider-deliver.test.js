// Mock provider deliver.js against the real PostgreSQL container (paysim) and a real local webhook receiver,
// whose signatures are checked with our real verifyInbound.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createProviderDb } from '../sims/payment-provider/db.js';
import { createWebhookSigner } from '../sims/payment-provider/sign.js';
import { createDeliverer } from '../sims/payment-provider/deliver.js';
import { createInboundVerifier } from '../src/services/connectors/payment-mock.js';
import { captureLogger, SECRET } from './helpers.js';

const db = createProviderDb({ logger: captureLogger().logger });
const admin = new pg.Client();
await admin.connect();
const paymentIds = [];
const verifier = createInboundVerifier({ secret: SECRET });
const signer = createWebhookSigner({ secret: SECRET });

// The receiver: each test sets `respond`; every request is recorded with its event id.
const received = [];
let respond = (req, res) => res.writeHead(200).end();
const receiver = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    received.push({ url: req.url, headers: req.headers, body, eventId: JSON.parse(body).id });
    respond(req, res);
  });
}).listen(0, '127.0.0.1');
await new Promise((resolve) => receiver.once('listening', resolve));
const webhookUrl = `http://127.0.0.1:${receiver.address().port}/webhooks/payment`;

after(async () => {
  receiver.closeAllConnections();
  receiver.close();
  await admin.query(
    'DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id = ANY($1))',
    [paymentIds],
  );
  await admin.query('DELETE FROM paysim.events WHERE payment_id = ANY($1)', [paymentIds]);
  await admin.query('DELETE FROM paysim.payments WHERE id = ANY($1)', [paymentIds]);
  await admin.end();
  await db.close();
});

const hex = () => randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DELIVERY = {
  retries: 12, baseDelayMs: 10_000, maxDelayMs: 600_000, jitter: 0.5, timeoutMs: 500, leaseMs: 30_000, pollMs: 50, batchSize: 10,
};

function deliverer({ url = webhookUrl, store = db } = {}) {
  const { logger, lines } = captureLogger();
  return { deliverer: createDeliverer({ db: store, signer, config: { webhookUrl: url, delivery: DELIVERY }, logger }), lines };
}

// A stored charge with one pending delivery, as app.js will create it.
async function newCharge() {
  const orderId = randomUUID();
  const payment = { id: `pay_${hex()}`, idempotencyKey: `charge-${orderId}`, orderId, amountMinor: 580000, currency: 'INR', runId: null };
  paymentIds.push(payment.id);
  const body = JSON.stringify({
    id: `evt_${hex()}`, type: 'payment.succeeded', created: Math.floor(Date.now() / 1000),
    data: { paymentId: payment.id, orderId, amountMinor: 580000, currency: 'INR' },
  });
  const event = { id: JSON.parse(body).id, body };
  await db.createCharge({ payment, event });
  return event;
}

async function deliveryOf(eventId) {
  const { rows } = await admin.query(
    `SELECT id, status, attempts, last_error, extract(epoch FROM next_attempt_at - now()) * 1000 AS due_in_ms
     FROM paysim.deliveries WHERE event_id = $1`,
    [eventId],
  );
  return rows[0];
}

const requestsFor = (eventId) => received.filter((r) => r.eventId === eventId);
const logsFor = (lines, eventId) => lines.filter((l) => l.eventId === eventId);

test('2xx: delivered; receiver got the exact body, JSON content type and a signature our verifier accepts', async () => {
  respond = (req, res) => res.writeHead(200).end('{"received":true}');
  const event = await newCharge();
  const { deliverer: d, lines } = deliverer();
  await d.runOnce();
  assert.equal((await deliveryOf(event.id)).status, 'delivered');
  const [request] = requestsFor(event.id);
  assert.equal(request.body.toString('utf8'), event.body);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(verifier.verifyInbound(request.body, request.headers).id, event.id);
  const [log] = logsFor(lines, event.id);
  assert.equal(log.level, 30); // pino info
  assert.equal(log.msg, 'webhook delivered');
  const logText = JSON.stringify(lines);
  assert.ok(!logText.includes(request.headers['mock-signature']) && !logText.includes(event.body), 'no signature or body in logs');
});

test('503: still pending, last_error saved, retry due in 5-10 s (first retry: 10 s cut to 50-100%), whole ms', async () => {
  respond = (req, res) => res.writeHead(503).end();
  const event = await newCharge();
  const { deliverer: d, lines } = deliverer();
  await d.runOnce();
  const row = await deliveryOf(event.id);
  assert.deepEqual({ status: row.status, attempts: row.attempts, last_error: row.last_error }, { status: 'pending', attempts: 1, last_error: 'HTTP 503' });
  assert.ok(row.due_in_ms > 4_000 && row.due_in_ms <= 10_000, `due in ${row.due_in_ms} ms`);
  const [log] = logsFor(lines, event.id);
  assert.equal(log.msg, 'webhook delivery failed, retrying');
  assert.ok(Number.isInteger(log.retryInMs) && log.retryInMs >= 5_000 && log.retryInMs <= 10_000);
});

test('302: a failure, the redirect is not followed', async () => {
  respond = (req, res) => res.writeHead(302, { Location: '/elsewhere' }).end();
  const event = await newCharge();
  await deliverer().deliverer.runOnce();
  assert.equal((await deliveryOf(event.id)).last_error, 'HTTP 302');
  assert.deepEqual(requestsFor(event.id).map((r) => r.url), ['/webhooks/payment']);
});

test('no reply within timeoutMs: last_error timeout', async () => {
  respond = () => {}; // never answers; the connection is closed in after()
  const event = await newCharge();
  await deliverer().deliverer.runOnce();
  assert.equal((await deliveryOf(event.id)).last_error, 'timeout');
});

test('receiver not listening: last_error ECONNREFUSED', async () => {
  const probe = createNetServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const event = await newCharge();
  await deliverer({ url: `http://127.0.0.1:${closedPort}/webhooks/payment` }).deliverer.runOnce();
  assert.equal((await deliveryOf(event.id)).last_error, 'ECONNREFUSED');
});

test('last attempt (1 + 12 retries) fails: marked failed, error logged', async () => {
  respond = (req, res) => res.writeHead(500).end();
  const event = await newCharge();
  await admin.query('UPDATE paysim.deliveries SET attempts = 12 WHERE event_id = $1', [event.id]); // the claim makes it 13
  const { deliverer: d, lines } = deliverer();
  await d.runOnce();
  const row = await deliveryOf(event.id);
  assert.deepEqual({ status: row.status, attempts: row.attempts, last_error: row.last_error }, { status: 'failed', attempts: 13, last_error: 'HTTP 500' });
  const [log] = logsFor(lines, event.id);
  assert.equal(log.level, 50); // pino error
  assert.equal(log.msg, 'webhook delivery gave up');
});

test('claimed again after the last attempt died mid-send: failed without sending', async () => {
  const event = await newCharge();
  await admin.query('UPDATE paysim.deliveries SET attempts = 13 WHERE event_id = $1', [event.id]); // the claim makes it 14
  await deliverer().deliverer.runOnce();
  const row = await deliveryOf(event.id);
  assert.deepEqual({ status: row.status, last_error: row.last_error }, { status: 'failed', last_error: 'attempts used up' });
  assert.equal(requestsFor(event.id).length, 0);
});

test('a batch is sent in parallel: 3 replies of 300 ms each take well under 900 ms', async () => {
  respond = (req, res) => setTimeout(() => res.writeHead(200).end(), 300);
  const events = [await newCharge(), await newCharge(), await newCharge()];
  const started = Date.now();
  await deliverer().deliverer.runOnce();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 800, `took ${elapsed} ms`);
  for (const event of events) assert.equal((await deliveryOf(event.id)).status, 'delivered');
});

test('a DB error on one delivery does not stop the batch: logged, that row stays pending, the others are done', async () => {
  respond = (req, res) => res.writeHead(200).end();
  const [bad, good] = [await newCharge(), await newCharge()];
  const badId = (await deliveryOf(bad.id)).id;
  const failing = { ...db, markDelivered: async (id) => (id === badId ? Promise.reject(new Error('db down')) : db.markDelivered(id)) };
  const { deliverer: d, lines } = deliverer({ store: failing });
  await d.runOnce();
  assert.equal((await deliveryOf(bad.id)).status, 'pending');
  assert.equal((await deliveryOf(good.id)).status, 'delivered');
  assert.equal(logsFor(lines, bad.id)[0].msg, 'webhook delivery update failed; retried after the lease');
});

test('start() delivers new rows by itself; after stop() nothing more is sent', async () => {
  respond = (req, res) => res.writeHead(200).end();
  const { deliverer: d } = deliverer();
  d.start();
  const first = await newCharge();
  for (let i = 0; i < 40 && (await deliveryOf(first.id)).status !== 'delivered'; i++) await sleep(50);
  assert.equal((await deliveryOf(first.id)).status, 'delivered');
  await d.stop();
  const second = await newCharge();
  await sleep(300); // 6 x pollMs
  assert.equal((await deliveryOf(second.id)).status, 'pending');
  assert.equal(requestsFor(second.id).length, 0);
});
