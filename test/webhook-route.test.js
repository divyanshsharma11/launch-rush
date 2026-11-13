// POST /webhooks/payment over real HTTP (listen(0) + fetch), real PostgreSQL and Redis containers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { createInboundVerifier } from '../src/services/connectors/payment-mock.js';
import { createDb } from '../src/services/db/index.js';
import { createWebhookQueue } from '../src/services/queue/index.js';
import { createPayments } from '../src/business/payments.js';
import { createWebhookRouter } from '../src/controllers/webhook.js';
import { createErrorHandler } from '../src/controllers/errors.js';
import { SECRET, captureLogger, createTestOrder, paymentEvent, signatureHeader, testQueue } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: SECRET });
const queue = testQueue(config.redis);
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const webhookQueue = createWebhookQueue({
  redis: config.redis, jobOptions: config.webhookJob, logger, name: queue.name,
});
const verifier = createInboundVerifier({ secret: SECRET });
const payments = createPayments({ verifier, db, webhookQueue, logger });
let order;
let server;
let url;

async function post(raw, contentType, secret) {
  const headers = { 'content-type': contentType, 'mock-signature': signatureHeader(raw, secret) };
  const res = await fetch(url, { method: 'POST', body: raw, headers });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
}

const postEvent = (body, secret) => post(JSON.stringify(body), 'application/json', secret);
const newEvent = (orderId = order.orderId) => paymentEvent(`evt_${randomUUID()}`, orderId);

before(async () => {
  await webhookQueue.ready();
  order = await createTestOrder();

  const app = express();
  app.use(createWebhookRouter({ payments, logger }));
  app.use(createErrorHandler({ logger }));
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  url = `http://127.0.0.1:${server.address().port}/webhooks/payment`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await order.remove();
  await db.close();
  await queue.cleanup();
  await webhookQueue.close();
});

test('valid signed event: 200 { received: true }, stored and queued', async () => {
  const event = newEvent();
  const res = await postEvent(event);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { received: true });
  assert.ok(await queue.inspect.getJob(event.id));
});

test('wrong signature: 400 invalid_signature in the design §5 error shape', async () => {
  const res = await postEvent(newEvent(), 'b'.repeat(32));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_signature');
  assert.equal(typeof res.body.error.message, 'string');

  const line = lines.at(-1);
  assert.deepEqual({ level: line.level, msg: line.msg, code: line.code }, {
    level: 40, msg: 'payment webhook rejected', code: 'invalid_signature',
  });
  assert.ok(!JSON.stringify(lines).includes('v1='), 'no signature value in any log line');
});

test('Content-Type not application/json: 400 invalid_payload', async () => {
  const res = await post(JSON.stringify(newEvent()), 'text/plain');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_payload');
});

test('body over the 100kb default limit: 413 invalid_payload as JSON', async () => {
  const res = await postEvent({ ...newEvent(), pad: 'x'.repeat(200 * 1024) });
  assert.equal(res.status, 413);
  assert.match(res.type, /application\/json/);
  assert.equal(res.body.error.code, 'invalid_payload');
});

test('DB error (order does not exist, real FK error): 500 internal_error, stack logged but not in the reply', async () => {
  const event = newEvent(randomUUID());
  const res = await postEvent(event);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: { code: 'internal_error', message: 'internal error' } });
  assert.equal(await queue.inspect.getJob(event.id), undefined); // the insert failed, so nothing was queued

  const line = lines.at(-1);
  assert.equal(line.level, 50);
  assert.equal(line.msg, 'unhandled request error');
  assert.equal(line.url, '/webhooks/payment');
  assert.equal(line.err.code, '23503');
  assert.ok(line.err.stack);
});
