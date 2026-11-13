// receiveWebhook (design §5.2 steps 2-4) against the real PostgreSQL and Redis containers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createInboundVerifier } from '../src/services/connectors/payment-mock.js';
import { createDb } from '../src/services/db/index.js';
import { createWebhookQueue } from '../src/services/queue/index.js';
import { createPayments } from '../src/business/payments.js';
import {
  SECRET, captureLogger, createTestOrder, countPaymentEvents, paymentEvent, signatureHeader, testQueue,
} from './helpers.js';

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

const event = (id) => paymentEvent(id, order.orderId);

function receive(body, secret) {
  const raw = Buffer.from(JSON.stringify(body));
  return payments.receiveWebhook(raw, { 'mock-signature': signatureHeader(raw, secret) });
}

before(async () => {
  await webhookQueue.ready();
  order = await createTestOrder();
});

after(async () => {
  await order.remove();
  await db.close();
  await queue.cleanup();
  await webhookQueue.close();
});

test('a valid signed event is stored once and gets one job with jobId = event id', async () => {
  const id = `evt_${randomUUID()}`;
  await receive(event(id));
  assert.equal(await countPaymentEvents(order.admin, id), 1);
  assert.deepEqual((await queue.inspect.getJob(id)).data, { eventId: id });

  const line = lines.at(-1);
  assert.equal(line.msg, 'payment event received');
  assert.deepEqual(
    { eventId: line.eventId, type: line.type, orderId: line.orderId, duplicate: line.duplicate },
    { eventId: id, type: 'payment.succeeded', orderId: order.orderId, duplicate: false },
  );
});

test('crash case: event already stored but no job, the retried delivery creates the job', async () => {
  const id = `evt_${randomUUID()}`;
  assert.equal(await db.insertPaymentEvent(event(id)), true); // stored, then the process "died"
  assert.equal(await queue.inspect.getJob(id), undefined);

  await receive(event(id));
  assert.equal(await countPaymentEvents(order.admin, id), 1);
  assert.ok(await queue.inspect.getJob(id));
  assert.equal(lines.at(-1).duplicate, true); // the event was already stored
});

test('signed bodies that are not valid events are rejected with invalid_payload, nothing stored or queued', async () => {
  const id = `evt_${randomUUID()}`;
  const bad = [
    null,
    [1],
    5,
    { ...event(id), data: undefined },
    { ...event(id), id: '1abc' },
    { ...event(id), id: 'evt:1' },
    { ...event(id), type: 'payment.unknown' },
    { ...event(id), data: { ...event(id).data, orderId: 'not-a-uuid' } },
  ];
  for (const body of bad) {
    await assert.rejects(receive(body), { code: 'invalid_payload' }, JSON.stringify(body));
  }
  assert.equal(await countPaymentEvents(order.admin, id), 0);
  assert.equal((await queue.inspect.getJobCounts('waiting')).waiting, 2); // only the jobs from the tests above
});

test('a wrong signature is rejected with invalid_signature, nothing stored', async () => {
  const id = `evt_${randomUUID()}`;
  await assert.rejects(receive(event(id), 'b'.repeat(32)), { code: 'invalid_signature' });
  assert.equal(await countPaymentEvents(order.admin, id), 0);
  assert.equal(await queue.inspect.getJob(id), undefined);
});
