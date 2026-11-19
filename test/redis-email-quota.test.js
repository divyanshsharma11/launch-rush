// The real-email cap (design §5.1): atomic, counted once per order, per session and per UTC day.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createRedis } from '../src/services/redis/index.js';
import { captureLogger } from './helpers.js';

const base = loadConfig(process.env);
const redis = createRedis({ redis: base.redis, logger: captureLogger().logger });
const raw = new Redis(base.redis);
const days = [];
const sessions = [];
const caps = { perSession: 2, perDay: 3, dayKeyTtlSeconds: 60 };
// Each test has its own day, so the day cap of one test never leaks into another.
const newDay = () => {
  const id = `test-${randomUUID()}`;
  days.push(id);
  return id;
};
const channelOn = (day, sessionId, orderId = randomUUID(), limits = caps) =>
  redis.emailChannel({ sessionId, orderId, day, caps: limits });
const newSession = () => {
  const id = randomUUID();
  sessions.push(id);
  return id;
};

before(() => redis.ready());
after(async () => {
  await raw.del(...days.map((day) => `email:day:${day}`), ...sessions.map((id) => `email:session:${id}`));
  await raw.quit();
  await redis.close();
});

test('a session gets 2 real emails, the third order is mock', async () => {
  const channel = channelOn.bind(null, newDay());
  const session = newSession();
  assert.equal(await channel(session), 'gmail');
  assert.equal(await channel(session), 'gmail');
  assert.equal(await channel(session), 'mock');
});

test('the same order is counted once, however often it asks, and keeps gmail', async () => {
  const day = newDay();
  const channel = channelOn.bind(null, day);
  const session = newSession();
  const order = randomUUID();
  for (let i = 0; i < 5; i += 1) assert.equal(await channel(session, order), 'gmail');
  assert.equal(await raw.scard(`email:session:${session}`), 1);
  assert.equal(await channel(session), 'gmail');
  assert.equal(await channel(session), 'mock');
  assert.equal(await channel(session, order), 'gmail', 'an order that was counted stays gmail after the cap is full');
});

test('the day cap is shared by all sessions; a mock answer counts nothing', async () => {
  const day = newDay();
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(await channelOn(day, newSession()));
  assert.deepEqual(results, ['gmail', 'gmail', 'gmail', 'mock']);
  assert.equal(await raw.scard(`email:day:${day}`), 3);
  assert.equal(await channelOn(day, newSession()), 'mock');
});

test('the day set expires (2 days in production), the session set does not', async () => {
  const day = newDay();
  const session = newSession();
  await channelOn(day, session);
  const dayTtl = await raw.ttl(`email:day:${day}`);
  assert.ok(dayTtl > 0 && dayTtl <= 60);
  assert.equal(await raw.ttl(`email:session:${session}`), -1);
});

test('concurrent orders of one session never get more than the cap', async () => {
  const day = newDay();
  const session = newSession();
  const results = await Promise.all(Array.from({ length: 10 }, () => channelOn(day, session, randomUUID(), { ...caps, perDay: 100 })));
  assert.equal(results.filter((result) => result === 'gmail').length, 2);
});
