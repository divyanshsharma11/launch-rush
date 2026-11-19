// loadErpSimConfig (ERP simulator): env validation without a real .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';

const KEY = 'a'.repeat(32);
const SECRET = 'b'.repeat(32);
const ENV = { ERP_SIM_PORT: '3002', ERP_API_KEY: KEY, ERP_API_SECRET: SECRET, REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379' };

test('valid env returns the settings; host defaults to 127.0.0.1, ERP_SIM_HOST overrides it', () => {
  const config = loadErpSimConfig(ENV);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3002);
  assert.equal(config.apiKey, KEY);
  assert.equal(config.apiSecret, SECRET);
  assert.deepEqual({ ...config.redis }, { host: '127.0.0.1', port: 6379 });
  assert.equal(config.log.level, 'info');
  assert.equal(loadErpSimConfig({ ...ENV, ERP_SIM_HOST: '0.0.0.0' }).host, '0.0.0.0');
});

test('each required variable missing fails and names the variable', () => {
  for (const name of Object.keys(ENV)) {
    assert.throws(() => loadErpSimConfig({ ...ENV, [name]: undefined }), new RegExp(`${name} is not set`));
  }
});

test('key and secret length: 31 bytes rejected, 32 accepted; errors never contain the value', () => {
  for (const name of ['ERP_API_KEY', 'ERP_API_SECRET']) {
    assert.throws(() => loadErpSimConfig({ ...ENV, [name]: 'x'.repeat(31) }), (err) => {
      assert.match(err.message, new RegExp(`${name} must be at least 32 bytes`));
      assert.ok(!err.message.includes('xxx'));
      return true;
    });
  }
});

test('ports must be whole numbers from 1 to 65535; an unknown log level is refused', () => {
  for (const bad of ['0', '65536', '30.5', 'abc']) {
    assert.throws(() => loadErpSimConfig({ ...ENV, ERP_SIM_PORT: bad }), /ERP_SIM_PORT must be an integer/);
  }
  assert.throws(() => loadErpSimConfig({ ...ENV, LOG_LEVEL: 'loud' }), /LOG_LEVEL must be one of/);
});
