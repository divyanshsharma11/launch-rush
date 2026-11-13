// createLogger: JSON lines, redaction safety net, error serialization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLogger } from './helpers.js';

test('the secret and the signature header are redacted, other fields kept', () => {
  const { logger, lines } = captureLogger();
  logger.info({ webhookSecret: 's1', payment: { webhookSecret: 's2' } }, 'secrets');
  logger.info({ headers: { 'mock-signature': 't=1,v1=ab', 'content-type': 'application/json' } }, 'headers');
  logger.info({ req: { headers: { 'mock-signature': 't=1,v1=ab' } } }, 'nested headers');

  assert.equal(lines[0].webhookSecret, '[Redacted]');
  assert.equal(lines[0].payment.webhookSecret, '[Redacted]');
  assert.equal(lines[1].headers['mock-signature'], '[Redacted]');
  assert.equal(lines[1].headers['content-type'], 'application/json');
  assert.equal(lines[2].req.headers['mock-signature'], '[Redacted]');
});

test('errors are logged with type, message, stack and extra fields such as code', () => {
  const { logger, lines } = captureLogger();
  const err = Object.assign(new Error('boom'), { code: '23503' });
  logger.error({ err }, 'failed');

  assert.equal(lines[0].level, 50);
  assert.equal(lines[0].msg, 'failed');
  assert.deepEqual(
    { type: lines[0].err.type, message: lines[0].err.message, code: lines[0].err.code },
    { type: 'Error', message: 'boom', code: '23503' },
  );
  assert.match(lines[0].err.stack, /^Error: boom/);
});
