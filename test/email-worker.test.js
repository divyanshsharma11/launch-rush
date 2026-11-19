// The email queue end to end: queue -> worker -> job -> email logic -> connectors (fake Google), with retry,
// rate-limit delay, final failure and replay. Real PostgreSQL, Redis and BullMQ.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis } from '../src/services/redis/index.js';
import { createEmailQueue, createWorker } from '../src/services/queue/index.js';
import { createGmailConnector } from '../src/services/connectors/email-gmail.js';
import { createMockEmailConnector } from '../src/services/connectors/email-mock.js';
import { createEmail } from '../src/business/email.js';
import { createReplay } from '../src/business/replay.js';
import { createEmailJob } from '../src/jobs/email-job.js';
import { captureLogger, completedOrder, completedRunOrder, createTestShop, startFakeGoogle } from './helpers.js';

const base = loadConfig(process.env);
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: base.redis, logger });
const raw = new Redis(base.redis);
const name = `email-test-${randomUUID()}`;
const jobOptions = { attempts: 5, backoff: { type: 'fixed', delay: 50 }, removeOnComplete: true, removeOnFail: { count: 100 } };
const sessions = [];
let shop;
let google;
let queue;
let inspect;
let worker;
let replay;

const deliveryOf = async (orderId) => (await shop.admin.query('SELECT * FROM deliveries WHERE order_id = $1', [orderId])).rows[0];
const stateOf = async (orderId) => (await shop.admin.query('SELECT state FROM orders WHERE id = $1', [orderId])).rows[0].state;

async function waitFor(check, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// A visitor's completed order with an address, and the session that owns it.
async function visitorOrder() {
  const sessionId = await shop.newSession();
  sessions.push(sessionId);
  return { sessionId, orderId: await completedOrder(shop, db, { sessionId, email: 'visitor@example.com' }) };
}

before(async () => {
  await redis.ready();
  shop = await createTestShop();
  google = await startFakeGoogle();
  queue = createEmailQueue({ redis: base.redis, jobOptions, logger, name });
  inspect = new Queue(name, { connection: base.redis });
  const gmail = createGmailConnector({
    clientId: google.clientId, clientSecret: google.clientSecret, refreshToken: google.refreshToken,
    address: 'demo@gmail.com', senderName: 'launch-rush', tokenUrl: google.tokenUrl, apiUrl: google.apiUrl,
  });
  const email = createEmail({
    db, redis, connectors: { gmail, mock: createMockEmailConnector() },
    config: { ...base.email, caps: { ...base.email.caps, perSession: 2, perDay: 1000 } }, logger,
    now: () => new Date('3999-12-31T10:00:00Z'),
  });
  const job = createEmailJob({ email });
  worker = createWorker({
    name,
    redis: base.redis,
    maxStartedAttempts: base.worker.maxStartedAttempts,
    processor: (j, token) => job.process(j, token),
    onFinalFailure: (j, err) => job.onFinalFailure(j, err),
    logger,
  });
  replay = createReplay({ db, emailQueue: queue });
});
after(async () => {
  await worker.close();
  await queue.close();
  await inspect.obliterate({ force: true });
  await inspect.close();
  await raw.del('email:day:3999-12-31', ...sessions.map((id) => `email:session:${id}`));
  await raw.quit();
  await redis.close();
  await google.close();
  await shop.remove();
  await db.close();
});
beforeEach(() => {
  google.sent.length = 0;
  google.sendFailures.length = 0;
});

test('a queued email job sends the email and the order card shows it', async () => {
  const { sessionId, orderId } = await visitorOrder();
  await queue.add(orderId);
  await waitFor(async () => (await deliveryOf(orderId))?.status === 'succeeded', 'delivery succeeded');
  assert.equal(google.sent.length, 1);
  assert.equal((await db.getSessionOrder(sessionId, orderId)).emailStatus, 'sent_gmail');
});

test('adding the same order again while the job exists, or after it finished, sends one email', async () => {
  const { orderId } = await visitorOrder();
  await queue.add(orderId);
  await queue.add(orderId);
  await waitFor(async () => (await deliveryOf(orderId))?.status === 'succeeded', 'delivery succeeded');
  await queue.add(orderId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(google.sent.length, 1);
  assert.equal((await deliveryOf(orderId)).attempts, 1);
});

test('Gmail errors that are worth retrying are retried by the queue until the email goes out', async () => {
  const { orderId } = await visitorOrder();
  const unavailable = { status: 503, body: { error: { errors: [{ reason: 'backendError' }] } } };
  google.sendFailures.push(unavailable, unavailable);
  await queue.add(orderId);
  await waitFor(async () => (await deliveryOf(orderId))?.status === 'succeeded', 'delivery succeeded');
  assert.equal((await deliveryOf(orderId)).attempts, 3);
  assert.equal(google.sent.length, 1);
});

test('a rate limit with Retry-After delays the job until then', async () => {
  const { orderId } = await visitorOrder();
  google.sendFailures.push({ status: 429, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, headers: { 'Retry-After': '1' } });
  const started = Date.now();
  await queue.add(orderId);
  await waitFor(async () => (await deliveryOf(orderId))?.status === 'succeeded', 'delivery succeeded', 10_000);
  assert.ok(Date.now() - started >= 900, 'waited for Retry-After');
  assert.equal(google.sent.length, 1);
});

test('a permanent failure ends as a failed delivery; the order stays completed; replay sends the email', async () => {
  const { sessionId, orderId } = await visitorOrder();
  google.sendFailures.push({ status: 400, body: { error: { errors: [{ reason: 'badRequest' }] } } });
  await queue.add(orderId);
  await waitFor(async () => (await deliveryOf(orderId))?.status === 'failed', 'delivery failed');
  assert.equal(await stateOf(orderId), 'completed');
  assert.equal((await db.getSessionOrder(sessionId, orderId)).emailStatus, 'failed');
  const listed = (await db.listFailedDeliveries(100)).find((delivery) => delivery.orderId === orderId);
  assert.deepEqual({ connector: listed.connector, action: listed.action, lastError: listed.lastError },
    { connector: 'email-gmail', action: 'email.send', lastError: 'Gmail replied HTTP 400 badRequest' });
  assert.equal(google.sent.length, 0);

  await replay.replay(listed.id);
  await waitFor(async () => (await deliveryOf(orderId))?.status === 'succeeded', 'replayed delivery succeeded');
  assert.equal(google.sent.length, 1);
  assert.equal(await stateOf(orderId), 'completed');
  assert.equal((await db.getSessionOrder(sessionId, orderId)).emailStatus, 'sent_gmail');
});

test('replay of a failed mock email whose job is gone adds a new job', async () => {
  const orderId = await completedRunOrder(shop, db, await shop.newSession());
  await db.failDelivery({ orderId, connector: 'email-mock', action: 'email.send', error: 'postgres down' });
  const { id } = (await db.listFailedDeliveries(100)).find((delivery) => delivery.orderId === orderId);
  await replay.replay(id);
  await waitFor(async () => (await deliveryOf(orderId))?.status === 'succeeded', 'replayed mock delivery');
  assert.equal(google.sent.length, 0);
  assert.equal(await stateOf(orderId), 'completed');
});
