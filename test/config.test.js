// loadConfig: env validation without a real .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const SECRET = 'a'.repeat(32);
const ENV = { PAYMENT_WEBHOOK_SECRET: SECRET, REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379', PORT: '3000' };

test('valid env returns the payment settings', () => {
  const config = loadConfig(ENV);
  assert.equal(config.payment.webhookSecret, SECRET);
  assert.equal(config.payment.webhookToleranceSeconds, 300);
});

test('missing secret fails and names the variable', () => {
  assert.throws(() => loadConfig({ ...ENV, PAYMENT_WEBHOOK_SECRET: undefined }), /PAYMENT_WEBHOOK_SECRET is not set/);
});

test('secret length: 31 bytes rejected, 32 bytes accepted', () => {
  assert.throws(() => loadConfig({ ...ENV, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(31) }), /at least 32 bytes/);
  assert.doesNotThrow(() => loadConfig(ENV));
});

test('error message never contains the secret', () => {
  const shortSecret = 'do-not-print-me';
  assert.throws(
    () => loadConfig({ ...ENV, PAYMENT_WEBHOOK_SECRET: shortSecret }),
    (err) => !err.message.includes(shortSecret),
  );
});

test('returned config is frozen', () => {
  const config = loadConfig(ENV);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.payment));
  assert.ok(Object.isFrozen(config.redis));
  assert.ok(Object.isFrozen(config.webhookJob.backoff));
});

test('redis settings: host and port read, port parsed as a number', () => {
  assert.deepEqual({ ...loadConfig(ENV).redis }, { host: '127.0.0.1', port: 6379 });
});

test('api settings: host defaults to 127.0.0.1, API_HOST overrides it, PORT required', () => {
  assert.deepEqual({ ...loadConfig(ENV).api }, { host: '127.0.0.1', port: 3000 });
  assert.equal(loadConfig({ ...ENV, API_HOST: '0.0.0.0' }).api.host, '0.0.0.0');
  assert.throws(() => loadConfig({ ...ENV, PORT: undefined }), /PORT is not set/);
});

test('log level: default info, a pino level accepted, anything else rejected', () => {
  assert.equal(loadConfig(ENV).log.level, 'info');
  assert.equal(loadConfig({ ...ENV, LOG_LEVEL: 'debug' }).log.level, 'debug');
  assert.throws(() => loadConfig({ ...ENV, LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/);
});

test('redis settings: missing host or bad port rejected', () => {
  assert.throws(() => loadConfig({ ...ENV, REDIS_HOST: undefined }), /REDIS_HOST is not set/);
  assert.throws(() => loadConfig({ ...ENV, REDIS_PORT: undefined }), /REDIS_PORT is not set/);
  for (const bad of ['abc', '0', '65536', '63.5']) {
    assert.throws(() => loadConfig({ ...ENV, REDIS_PORT: bad }), /REDIS_PORT must be an integer from 1 to 65535/);
  }
});
