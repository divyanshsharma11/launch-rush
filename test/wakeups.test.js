// Order wake-ups over real Redis Pub/Sub (design §8.4), and the breaker state hash the stream reads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createRedis } from '../src/services/redis/index.js';
import { createWakeups } from '../src/services/redis/wakeups.js';
import { captureLogger } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger } = captureLogger();
const redis = createRedis({ redis: config.redis, logger });
const name = `wakeups-test-${randomUUID()}`;
const wakeups = createWakeups({ redis: { ...config.redis, connectionName: name }, logger });
const admin = new Redis(config.redis);
const heard = [];
const stop = wakeups.onOrder((orderId, sessionId) => heard.push(sessionId ? `${orderId}:${sessionId}` : orderId));

before(async () => {
  await redis.ready();
  await wakeups.ready();
});

after(async () => {
  stop();
  await wakeups.close();
  await admin.quit();
  await redis.close();
});

async function waitFor(check, timeoutMs = 5000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 20))) {
    if (check()) return;
  }
  assert.fail('condition not reached in time');
}

test('a published wake-up reaches the listener with the order id', async () => {
  const id = randomUUID();
  await redis.notifyOrder(id);
  await waitFor(() => heard.includes(id));
});

test('the wake-up of a new order carries its session id', async () => {
  const [id, session] = [randomUUID(), randomUUID()];
  await redis.notifyOrder(id, session);
  await waitFor(() => heard.includes(`${id}:${session}`));
});

test('after the subscriber connection is cut, ioredis subscribes again and wake-ups still arrive', async () => {
  const list = await admin.client('LIST');
  const id = list.split('\n').find((line) => line.includes(`name=${name}`)).match(/\bid=(\d+)/)[1];
  await admin.client('KILL', 'ID', id);

  const orderId = randomUUID();
  await waitFor(() => {
    redis.notifyOrder(orderId);
    return heard.includes(orderId);
  });
});

test('a listener that was stopped hears nothing more', async () => {
  const extra = [];
  const stopExtra = wakeups.onOrder((orderId) => extra.push(orderId));
  stopExtra();
  const id = randomUUID();
  await redis.notifyOrder(id);
  await waitFor(() => heard.includes(id));
  assert.deepEqual(extra, []);
});

test('notifyOrder never throws when Redis is not reachable', async () => {
  const down = createRedis({ redis: { host: '127.0.0.1', port: 1 }, logger });
  await assert.doesNotReject(down.notifyOrder(randomUUID()));
  await down.close();
});

test('breaker states: stored by connector and run, read back, removed with null, cleared as a whole', async () => {
  const runId = randomUUID();
  await redis.clearBreakerStates();
  await redis.setBreakerState({ connector: 'erp-sim', runId: null, state: 'open' });
  await redis.setBreakerState({ connector: 'erp-sim', runId, state: 'halfOpen' });
  const states = await redis.breakerStates();
  assert.deepEqual(states.sort((a, b) => String(a.runId).localeCompare(String(b.runId))), [
    { connector: 'erp-sim', runId, state: 'halfOpen' },
    { connector: 'erp-sim', runId: null, state: 'open' },
  ].sort((a, b) => String(a.runId).localeCompare(String(b.runId))));

  await redis.setBreakerState({ connector: 'erp-sim', runId, state: null });
  assert.deepEqual(await redis.breakerStates(), [{ connector: 'erp-sim', runId: null, state: 'open' }]);
  await redis.clearBreakerStates();
  assert.deepEqual(await redis.breakerStates(), []);
});
