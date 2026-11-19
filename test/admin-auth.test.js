// Admin login: scrypt check and Redis sessions, against the real Redis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createRedis } from '../src/services/redis/index.js';
import { createAdminAuth, hashPassword } from '../src/business/admin-auth.js';
import { captureLogger } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger } = captureLogger();
const redis = createRedis({ redis: config.redis, logger });
const raw = new Redis(config.redis);
const salt = randomBytes(16);
const PASSWORD = 'correct horse battery';
const created = [];
let auth;

before(async () => {
  await redis.ready();
  const admin = { passwordHash: await hashPassword(PASSWORD, salt), passwordSalt: salt, sessionTtlSeconds: 100 };
  auth = createAdminAuth({ admin, redis });
});

after(async () => {
  for (const id of created) await raw.del(`admin:session:${id}`);
  raw.disconnect();
  await redis.close();
});

test('the right password gives a session that expires after the configured time', async () => {
  const id = await auth.login(PASSWORD);
  created.push(id);
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await auth.isLoggedIn(id), true);
  const ttl = await raw.ttl(`admin:session:${id}`);
  assert.ok(ttl > 90 && ttl <= 100, `ttl ${ttl}`);
});

test('every login gets its own session id', async () => {
  const [a, b] = [await auth.login(PASSWORD), await auth.login(PASSWORD)];
  created.push(a, b);
  assert.notEqual(a, b);
});

test('a wrong, empty or non-string password gives no session', async () => {
  for (const password of ['wrong password', '', undefined, null, 123, ['x']]) {
    assert.equal(await auth.login(password), null);
  }
});

test('logout ends the session; unknown, missing and malformed ids are not logged in', async () => {
  const id = await auth.login(PASSWORD);
  created.push(id);
  await auth.logout(id);
  assert.equal(await auth.isLoggedIn(id), false);
  for (const bad of [undefined, '', 'x', randomBytes(32).toString('base64url'), `${id}*`]) {
    assert.equal(await auth.isLoggedIn(bad), false);
  }
});
