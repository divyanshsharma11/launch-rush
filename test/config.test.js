// loadConfig: env validation without a real .env.
import { test } from 'node:test';
import { sep } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const SECRET = 'a'.repeat(32);
const API_KEY = 'b'.repeat(32);
const ENV = {
  PAYMENT_WEBHOOK_SECRET: SECRET,
  PAYMENT_PROVIDER_URL: 'http://127.0.0.1:3001',
  PAYMENT_API_KEY: API_KEY,
  ERP_SIM_URL: 'http://127.0.0.1:3002',
  ERP_API_KEY: API_KEY,
  ERP_API_SECRET: SECRET,
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  PORT: '3000',
};

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
  assert.deepEqual({ ...loadConfig(ENV).api }, { host: '127.0.0.1', port: 3000, trustProxy: 0 });
  assert.equal(loadConfig({ ...ENV, API_HOST: '0.0.0.0' }).api.host, '0.0.0.0');
  assert.throws(() => loadConfig({ ...ENV, PORT: undefined }), /PORT is not set/);
});

test('trust proxy: 0 by default, TRUST_PROXY sets the hop count, anything else is rejected', () => {
  assert.equal(loadConfig({ ...ENV, TRUST_PROXY: '' }).api.trustProxy, 0);
  assert.equal(loadConfig({ ...ENV, TRUST_PROXY: '1' }).api.trustProxy, 1);
  for (const bad of ['true', '-1', '1.5', '11']) {
    assert.throws(() => loadConfig({ ...ENV, TRUST_PROXY: bad }), /TRUST_PROXY must be an integer from 0 to 10/);
  }
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

test('payment provider: URL and API key read; missing, short key or a non-http URL rejected without the value', () => {
  const { payment } = loadConfig(ENV);
  assert.equal(payment.providerUrl, 'http://127.0.0.1:3001');
  assert.equal(payment.apiKey, API_KEY);
  assert.throws(() => loadConfig({ ...ENV, PAYMENT_PROVIDER_URL: undefined }), /PAYMENT_PROVIDER_URL is not set/);
  assert.throws(() => loadConfig({ ...ENV, PAYMENT_API_KEY: undefined }), /PAYMENT_API_KEY is not set/);
  assert.throws(
    () => loadConfig({ ...ENV, PAYMENT_API_KEY: 'do-not-print-me' }),
    (err) => /PAYMENT_API_KEY must be at least 32 bytes/.test(err.message) && !err.message.includes('do-not-print-me'),
  );
  for (const bad of ['127.0.0.1:3001', 'not a url', 'ftp://127.0.0.1']) {
    assert.throws(() => loadConfig({ ...ENV, PAYMENT_PROVIDER_URL: bad }), /PAYMENT_PROVIDER_URL must be an http or https URL/);
  }
});

test('erp settings: URL, key and secret required; key and secret at least 32 bytes and never printed; timeout 10 s', () => {
  const { erp } = loadConfig(ENV);
  assert.deepEqual({ ...erp }, { baseUrl: ENV.ERP_SIM_URL, apiKey: API_KEY, apiSecret: SECRET, callTimeoutMs: 10_000 });
  for (const name of ['ERP_SIM_URL', 'ERP_API_KEY', 'ERP_API_SECRET']) {
    assert.throws(() => loadConfig({ ...ENV, [name]: undefined }), new RegExp(`${name} is not set`));
  }
  for (const name of ['ERP_API_KEY', 'ERP_API_SECRET']) {
    assert.throws(() => loadConfig({ ...ENV, [name]: 'do-not-print-me' }), (err) => {
      assert.match(err.message, new RegExp(`${name} must be at least 32 bytes`));
      return !err.message.includes('do-not-print-me');
    });
  }
  assert.throws(() => loadConfig({ ...ENV, ERP_SIM_URL: 'ftp://x' }), /ERP_SIM_URL must be an http or https URL/);
});

test('fulfilment and restock starting values', () => {
  const config = loadConfig(ENV);
  assert.deepEqual({ ...config.fulfilment }, { concurrency: 5 });
  assert.deepEqual({ ...config.restock }, { intervalMs: 30_000, windowMs: 600_000, batchSize: 50 });
  assert.ok(Object.isFrozen(config.erp) && Object.isFrozen(config.fulfilment) && Object.isFrozen(config.restock));
});

test('email settings: the owner\'s caps and the 24-hour address purge', () => {
  const { email } = loadConfig(ENV);
  assert.equal(email.caps.perSession, 2);
  assert.equal(email.caps.perDay, 200);
  assert.equal(email.purge.afterMs, 86_400_000);
  assert.ok(Object.isFrozen(email) && Object.isFrozen(email.caps) && Object.isFrozen(email.purge));
});

test('gmail settings are optional as a whole and validated together', () => {
  assert.deepEqual({ ...loadConfig(ENV).gmail }, { clientId: null, clientSecret: null, refreshToken: null, address: null });
  const client = { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret' };
  assert.equal(loadConfig({ ...ENV, ...client }).gmail.refreshToken, null);
  const connected = { ...client, GMAIL_ADDRESS: 'demo@gmail.com', GMAIL_REFRESH_TOKEN: 'token' };
  assert.equal(loadConfig({ ...ENV, ...connected }).gmail.refreshToken, 'token');
  assert.throws(() => loadConfig({ ...ENV, GMAIL_CLIENT_ID: 'id' }), /GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET go together/);
  assert.throws(
    () => loadConfig({ ...ENV, ...client, GMAIL_REFRESH_TOKEN: 'do-not-print-me' }),
    (err) => /GMAIL_REFRESH_TOKEN needs/.test(err.message) && !err.message.includes('do-not-print-me'),
  );
});

test('cors origin: default is the Vite dev server, PORTFOLIO_ORIGIN overrides it, a path or trailing slash is refused', () => {
  assert.equal(loadConfig(ENV).cors.allowedOrigin, 'http://localhost:5173');
  assert.equal(loadConfig({ ...ENV, PORTFOLIO_ORIGIN: 'https://divyanshsharma11.vercel.app' }).cors.allowedOrigin, 'https://divyanshsharma11.vercel.app');
  for (const bad of ['https://example.com/', 'https://example.com/app', 'example.com', 'ftp://example.com']) {
    assert.throws(() => loadConfig({ ...ENV, PORTFOLIO_ORIGIN: bad }), /PORTFOLIO_ORIGIN must be an origin/);
  }
});

test('stream settings are frozen starting values', () => {
  const { stream, cors } = loadConfig(ENV);
  assert.deepEqual({ ...stream }, {
    retryMs: 3000, pingMs: 15_000, tickMs: 2000, progressMs: 500, settleMs: 60_000, maxOrders: 50, maxPerSession: 3,
  });
  assert.ok(Object.isFrozen(stream) && Object.isFrozen(cors));
});

test('admin settings: off without a hash, validated together, origin defaults to the API address', () => {
  assert.equal(loadConfig(ENV).admin, null);
  const hash = 'ab'.repeat(64);
  const salt = 'cd'.repeat(16);
  const admin = loadConfig({ ...ENV, ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD_SALT: salt }).admin;
  assert.equal(admin.passwordHash.toString('hex'), hash);
  assert.equal(admin.passwordSalt.toString('hex'), salt);
  assert.equal(admin.origin, 'http://127.0.0.1:3000');
  assert.equal(admin.sessionTtlSeconds, 28_800);
  assert.deepEqual(admin.pageDir.split(sep).slice(-3), ['launch-rush', 'admin', 'dist']);
  assert.ok(Object.isFrozen(admin));
  assert.equal(loadConfig({ ...ENV, ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD_SALT: salt, ADMIN_ORIGIN: 'https://api.example.com' }).admin.origin, 'https://api.example.com');
  assert.equal(loadConfig({ ...ENV, PORT: '80', ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD_SALT: salt }).admin.origin, 'http://127.0.0.1'); // browsers omit port 80
  assert.throws(() => loadConfig({ ...ENV, ADMIN_PASSWORD_HASH: hash }), /go together/)
  assert.throws(() => loadConfig({ ...ENV, ADMIN_PASSWORD_HASH: 'ab', ADMIN_PASSWORD_SALT: salt }), /ADMIN_PASSWORD_HASH must be/);
  assert.throws(() => loadConfig({ ...ENV, ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD_SALT: 'cd' }), /ADMIN_PASSWORD_SALT must be/);
  assert.throws(() => loadConfig({ ...ENV, ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD_SALT: salt, ADMIN_ORIGIN: 'https://x.com/' }), /ADMIN_ORIGIN must be an origin/);
});

test('admin login attempts are limited per IP: 5 a minute', () => {
  assert.deepEqual({ ...loadConfig(ENV).rateLimits.adminLogin }, { limit: 5, windowMs: 60_000 });
});

test('visitor request limits: defaults, optional per-minute overrides for the load run, bad values refused', () => {
  const limits = loadConfig(ENV).rateLimits;
  assert.deepEqual([limits.sessionCreate.limit, limits.session.limit], [10, 120]);
  const raised = loadConfig({ ...ENV, RATE_LIMIT_SESSION_CREATE_PER_MIN: '5000', RATE_LIMIT_SESSION_PER_MIN: '900' }).rateLimits;
  assert.deepEqual([raised.sessionCreate.limit, raised.session.limit, raised.adminLogin.limit], [5000, 900, 5]);
  for (const bad of ['0', '-1', '1.5', 'many']) {
    assert.throws(() => loadConfig({ ...ENV, RATE_LIMIT_SESSION_PER_MIN: bad }), /RATE_LIMIT_SESSION_PER_MIN must be/);
  }
});
