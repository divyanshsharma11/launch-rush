// The email business logic against real PostgreSQL and Redis, a fake Google and the real connectors.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis } from '../src/services/redis/index.js';
import { createGmailConnector } from '../src/services/connectors/email-gmail.js';
import { createMockEmailConnector } from '../src/services/connectors/email-mock.js';
import { createEmail } from '../src/business/email.js';
import { captureLogger, completedOrder, completedRunOrder, createTestShop, startFakeGoogle } from './helpers.js';

const base = loadConfig(process.env);
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: base.redis, logger });
const raw = new Redis(base.redis);
const days = [];
const sessions = [];
let shop;
let google;
let sessionId;
let dayCounter = 0;

// An email service with its own UTC day (so the day cap is its own) and the caps of the test.
function emailService({ caps = { ...base.email.caps, perSession: 2, perDay: 100 }, redisClient = redis } = {}) {
  const day = `3${String(++dayCounter).padStart(3, '0')}-01-01`;
  days.push(day);
  const gmail = createGmailConnector({
    clientId: google.clientId, clientSecret: google.clientSecret, refreshToken: google.refreshToken,
    address: 'demo@gmail.com', senderName: 'launch-rush', tokenUrl: google.tokenUrl, apiUrl: google.apiUrl,
  });
  return createEmail({
    db, redis: redisClient, connectors: { gmail, mock: createMockEmailConnector() },
    config: { ...base.email, caps }, logger, now: () => new Date(`${day}T10:00:00Z`),
  });
}
const deliveryOf = async (orderId) => (await shop.admin.query('SELECT * FROM deliveries WHERE order_id = $1', [orderId])).rows[0];
const rowOf = async (orderId) => (await shop.admin.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
const cardOf = (orderId, session = sessionId) => db.getSessionOrder(session, orderId);

// A session whose Redis quota key is removed at the end.
async function newSession() {
  const id = await shop.newSession();
  sessions.push(id);
  return id;
}

before(async () => {
  await redis.ready();
  shop = await createTestShop();
  google = await startFakeGoogle();
  sessionId = await newSession();
});
after(async () => {
  await raw.del(...days.map((day) => `email:day:${day}`), ...sessions.map((id) => `email:session:${id}`));
  await raw.quit();
  await redis.close();
  await google.close();
  await shop.remove();
  await db.close();
});
beforeEach(() => {
  google.sent.length = 0;
  google.sendFailures.length = 0;
  google.valid.clear();
});

test('a visitor\'s order within the cap goes through Gmail with the demo content', async () => {
  const id = await completedOrder(shop, db, { sessionId, email: 'visitor@example.com', invoiceNo: 'SINV-0042' });
  await emailService().send(id);

  assert.equal(google.sent.length, 1);
  assert.match(google.sent[0].message, /^From: "launch-rush" <demo@gmail\.com>\r\nTo: visitor@example\.com\r\nSubject: \[DEMO\] Order confirmation\r\n/);
  const body = Buffer.from(google.sent[0].message.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(body, /^Demo store: nothing is sold/);
  assert.match(body, /Game: Test Game/);
  assert.match(body, /Invoice: SINV-0042/);
  const delivery = await deliveryOf(id);
  assert.deepEqual(
    { connector: delivery.connector, status: delivery.status, attempts: delivery.attempts },
    { connector: 'email-gmail', status: 'succeeded', attempts: 1 },
  );
  assert.equal((await rowOf(id)).email_channel, 'gmail');
  assert.equal((await rowOf(id)).state, 'completed');
  assert.equal((await cardOf(id)).emailStatus, 'sent_gmail');
  assert.ok(lines.some((line) => line.msg === 'confirmation email sent' && line.orderId === id && line.channel === 'gmail'));
  assert.ok(lines.every((line) => !JSON.stringify(line).includes('visitor@example.com')), 'the address is never logged');
});

test('over the per-session cap the order gets the mock email and its address is dropped', async () => {
  const session = await newSession();
  const email = emailService();
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(await completedOrder(shop, db, { sessionId: session, email: `v${i}@example.com` }));
  for (const id of ids) await email.send(id);

  assert.equal(google.sent.length, 2);
  assert.deepEqual(await Promise.all(ids.map(async (id) => (await rowOf(id)).email_channel)), ['gmail', 'gmail', 'mock']);
  assert.equal((await rowOf(ids[2])).buyer_email, null);
  assert.equal((await deliveryOf(ids[2])).connector, 'email-mock');
  assert.equal((await db.getSessionOrder(session, ids[2])).emailStatus, 'simulated_limit');
  assert.equal((await db.getSessionOrder(session, ids[0])).emailStatus, 'sent_gmail');
});

test('a simulated rush order always gets the mock email and never asks Redis for the quota', async () => {
  const id = await completedRunOrder(shop, db, sessionId);
  const email = emailService({ redisClient: { emailChannel: () => assert.fail('quota used') } });
  await email.send(id);
  assert.equal(google.sent.length, 0);
  assert.equal((await rowOf(id)).email_channel, 'mock');
  const delivery = await deliveryOf(id);
  assert.deepEqual({ connector: delivery.connector, status: delivery.status }, { connector: 'email-mock', status: 'succeeded' });
});

test('a repeated job after success sends nothing again', async () => {
  const id = await completedOrder(shop, db, { sessionId: await newSession(), email: 'once@example.com' });
  const email = emailService();
  await email.send(id);
  await email.send(id);
  assert.equal(google.sent.length, 1);
  assert.equal((await deliveryOf(id)).attempts, 1);
});

test('a retryable error keeps the delivery pending with the error; the next attempt succeeds', async () => {
  const session = await newSession();
  const id = await completedOrder(shop, db, { sessionId: session, email: 'retry@example.com' });
  const email = emailService();
  google.sendFailures.push({ status: 503, body: { error: { errors: [{ reason: 'backendError' }] } } });
  await assert.rejects(email.send(id), (err) => email.classifyError(err).kind === 'retryable');
  const pending = await deliveryOf(id);
  assert.deepEqual(
    { status: pending.status, attempts: pending.attempts, error: pending.last_error },
    { status: 'pending', attempts: 1, error: 'Gmail replied HTTP 503 backendError' },
  );
  assert.equal((await cardOf(id, session)).emailStatus, 'pending');

  await email.send(id, { attempt: 2 });
  assert.equal((await deliveryOf(id)).status, 'succeeded');
  assert.equal((await deliveryOf(id)).attempts, 2);
  assert.equal(google.sent.length, 1);
});

test('a permanent error, then markFailed: the delivery fails for good and the order stays completed', async () => {
  const session = await newSession();
  const id = await completedOrder(shop, db, { sessionId: session, email: 'bad@example.com' });
  const email = emailService();
  google.sendFailures.push({ status: 400, body: { error: { errors: [{ reason: 'badRequest' }] } } });
  const err = await email.send(id).catch((e) => e);
  assert.equal(email.classifyError(err).kind, 'permanent');
  await email.markFailed(id, err);

  assert.equal((await deliveryOf(id)).status, 'failed');
  assert.equal((await deliveryOf(id)).last_error, 'Gmail replied HTTP 400 badRequest');
  assert.equal((await rowOf(id)).state, 'completed');
  assert.equal((await cardOf(id, session)).emailStatus, 'failed');
});

test('a purged address cannot be sent: permanent, then failed for replay', async () => {
  const id = await completedOrder(shop, db, { sessionId: await newSession(), email: 'gone@example.com' });
  await db.setEmailChannel(id, 'gmail');
  await shop.admin.query('UPDATE orders SET buyer_email = NULL WHERE id = $1', [id]);
  const email = emailService();
  const err = await email.send(id).catch((e) => e);
  assert.equal(email.classifyError(err).kind, 'permanent');
  assert.equal(google.sent.length, 0);
  await email.markFailed(id, err);
  assert.equal((await deliveryOf(id)).status, 'failed');
});

test('markFailed also records a failure that happened before any delivery row existed', async () => {
  const session = await newSession();
  const visitor = await completedOrder(shop, db, { sessionId: session, email: 'x@example.com' });
  const simulated = await completedRunOrder(shop, db, sessionId);
  const email = emailService();
  await email.markFailed(visitor, new Error('redis down'));
  await email.markFailed(simulated, new Error('postgres down'));
  assert.deepEqual(
    [await deliveryOf(visitor), await deliveryOf(simulated)].map((row) => [row.connector, row.status, row.last_error]),
    [['email-gmail', 'failed', 'redis down'], ['email-mock', 'failed', 'postgres down']],
  );
  assert.equal((await cardOf(visitor, session)).emailStatus, 'failed');
});

test('an order that is not completed, or does not exist, is left alone', async () => {
  const email = emailService();
  const open = await db.insertOrder({ id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', holdMs: 300_000 });
  await email.send(open.id);
  await email.send(randomUUID());
  await email.markFailed(randomUUID(), new Error('x'));
  assert.equal(google.sent.length, 0);
  assert.equal(await deliveryOf(open.id), undefined);
});

test('purge clears addresses older than the limit and reports the count', async () => {
  const id = await completedOrder(shop, db, { sessionId: await newSession(), email: 'old@example.com' });
  await shop.admin.query(`UPDATE orders SET email_saved_at = now() - interval '25 hours' WHERE id = $1`, [id]);
  const result = await emailService().purge();
  assert.ok(result.purged >= 1);
  assert.equal((await rowOf(id)).buyer_email, null);
});
