// loadProviderConfig (mock payment provider): env validation without a real .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProviderConfig } from '../sims/payment-provider/config.js';

const SECRET = 'a'.repeat(32);
const API_KEY = 'b'.repeat(32);
const ENV = {
  PAYMENT_PROVIDER_PORT: '3001',
  PAYMENT_WEBHOOK_SECRET: SECRET,
  PAYMENT_API_KEY: API_KEY,
  PAYMENT_WEBHOOK_URL: 'http://127.0.0.1:3000/webhooks/payment',
};

test('valid env returns the settings; host defaults to 127.0.0.1, PAYMENT_PROVIDER_HOST overrides it', () => {
  const config = loadProviderConfig(ENV);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
  assert.equal(config.webhookSecret, SECRET);
  assert.equal(config.apiKey, API_KEY);
  assert.equal(config.webhookUrl, ENV.PAYMENT_WEBHOOK_URL);
  assert.equal(loadProviderConfig({ ...ENV, PAYMENT_PROVIDER_HOST: '0.0.0.0' }).host, '0.0.0.0');
});

test('delivery and duplicate starting values match the decisions', () => {
  const config = loadProviderConfig(ENV);
  assert.deepEqual(
    { ...config.delivery },
    { retries: 12, baseDelayMs: 10_000, maxDelayMs: 600_000, jitter: 0.5, timeoutMs: 10_000, leaseMs: 30_000 },
  );
  assert.equal(config.runDuplicateShare, 0.05);
});

test('each required variable missing fails and names the variable', () => {
  for (const name of Object.keys(ENV)) {
    assert.throws(() => loadProviderConfig({ ...ENV, [name]: undefined }), new RegExp(`${name} is not set`));
  }
});

test('secret and API key length: 31 bytes rejected, 32 accepted', () => {
  for (const name of ['PAYMENT_WEBHOOK_SECRET', 'PAYMENT_API_KEY']) {
    assert.throws(() => loadProviderConfig({ ...ENV, [name]: 'a'.repeat(31) }), new RegExp(`${name} must be at least 32 bytes`));
  }
  assert.doesNotThrow(() => loadProviderConfig(ENV));
});

test('error messages never contain the secret or the API key', () => {
  for (const name of ['PAYMENT_WEBHOOK_SECRET', 'PAYMENT_API_KEY']) {
    const value = 'do-not-print-me';
    assert.throws(() => loadProviderConfig({ ...ENV, [name]: value }), (err) => !err.message.includes(value));
  }
});

test('bad port rejected', () => {
  for (const bad of ['abc', '0', '65536', '63.5']) {
    assert.throws(
      () => loadProviderConfig({ ...ENV, PAYMENT_PROVIDER_PORT: bad }),
      /PAYMENT_PROVIDER_PORT must be an integer from 1 to 65535/,
    );
  }
});

test('webhook URL: https accepted; not a URL or another protocol rejected', () => {
  assert.doesNotThrow(() => loadProviderConfig({ ...ENV, PAYMENT_WEBHOOK_URL: 'https://api.example.com/webhooks/payment' }));
  for (const bad of ['127.0.0.1:3000/webhooks/payment', 'not a url', 'ftp://127.0.0.1/webhooks']) {
    assert.throws(
      () => loadProviderConfig({ ...ENV, PAYMENT_WEBHOOK_URL: bad }),
      /PAYMENT_WEBHOOK_URL must be an http or https URL/,
    );
  }
});

test('log level: default info, anything not a pino level rejected', () => {
  assert.equal(loadProviderConfig(ENV).log.level, 'info');
  assert.throws(() => loadProviderConfig({ ...ENV, LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/);
});

test('returned config is frozen', () => {
  const config = loadProviderConfig(ENV);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.delivery));
  assert.ok(Object.isFrozen(config.log));
});
