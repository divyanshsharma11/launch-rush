// email-mock and email-gmail against a fake Google (real HTTP, shaped as in Google's docs).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGmailConnector, InvalidEmailError, ReauthRequiredError } from '../src/services/connectors/email-gmail.js';
import { createMockEmailConnector } from '../src/services/connectors/email-mock.js';
import { UpstreamHttpError } from '../src/services/connectors/http-errors.js';
import { startFakeGoogle } from './helpers.js';

const CTX = { orderId: 'o-1', runId: null, idempotencyKey: 'email.send-o-1', attempt: 1, timeoutMs: 2000 };
const MAIL = { to: 'visitor@example.com', subject: '[DEMO] Order confirmation', text: 'Game: Ragnarök\r\nDemo price: ₹5,800.00\r\n' };
let google;

const gmail = (overrides = {}) =>
  createGmailConnector({
    clientId: google.clientId, clientSecret: google.clientSecret, refreshToken: google.refreshToken,
    address: 'demo@gmail.com', senderName: 'launch-rush', tokenUrl: google.tokenUrl, apiUrl: google.apiUrl, ...overrides,
  });

// The decoded message split into its header block and the decoded base64 body.
function parse(message) {
  const [head, body] = message.split('\r\n\r\n');
  return { head, headers: head.replace(/\r\n /g, ' ').split('\r\n'), text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

before(async () => {
  google = await startFakeGoogle();
});
after(() => google.close());
beforeEach(() => {
  google.sent.length = 0;
  google.sendFailures.length = 0;
  google.tokenFailure = null;
  google.refreshes = 0;
  google.valid.clear();
});

test('email-mock: accepts email.send, nothing else', async () => {
  const mock = createMockEmailConnector();
  assert.deepEqual(await mock.execute('email.send', MAIL, CTX), { simulated: true });
  await assert.rejects(mock.execute('email.delete', {}, CTX), (err) => mock.classifyError(err).kind === 'permanent');
  assert.equal(await mock.healthCheck(), true);
  assert.deepEqual(mock.capabilities, ['email.send']);
});

test('email-gmail: posts a base64url RFC 2822 message with the bearer token and returns the message id', async () => {
  const result = await gmail().execute('email.send', MAIL, CTX);
  assert.deepEqual(result, { id: 'msg-1' });
  const [sent] = google.sent;
  assert.equal(sent.bearer, 'access-1');
  assert.doesNotMatch(sent.raw, /[+/=]/, 'base64url alphabet, no padding');
  const { headers, text } = parse(sent.message);
  assert.ok(headers.includes('From: "launch-rush" <demo@gmail.com>'));
  assert.ok(headers.includes('To: visitor@example.com'));
  assert.ok(headers.includes('Subject: [DEMO] Order confirmation'));
  assert.ok(headers.includes('MIME-Version: 1.0'));
  assert.ok(headers.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(headers.some((line) => /^Date: \w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000$/.test(line)));
  assert.equal(text, MAIL.text, 'non-ASCII body survives the round trip');
  for (const line of sent.message.split('\r\n')) assert.ok(line.length <= 78, 'lines stay short');
});

test('email-gmail: a non-ASCII subject is split into RFC 2047 encoded words of at most 75 characters', async () => {
  const subject = '[DEMO] Bestellung für Ragnarök: Ünïcödé Ünïcödé Ünïcödé Ünïcödé';
  await gmail().execute('email.send', { ...MAIL, subject }, CTX);
  const rawHead = google.sent[0].message.split('\r\n\r\n')[0];
  const subjectLines = rawHead.slice(rawHead.indexOf('Subject: ')).split('\r\n').slice(0, 3).filter((line, i) => i === 0 || line.startsWith(' '));
  assert.ok(subjectLines.length > 1, 'folded onto several lines');
  const words = subjectLines.map((line) => line.replace(/^Subject: |^ /, ''));
  for (const [i, word] of words.entries()) {
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(word.length <= 75);
    assert.ok(subjectLines[i].length <= 76);
  }
  const decoded = words.map((word) => Buffer.from(word.split('?')[3], 'base64').toString('utf8')).join('');
  assert.equal(decoded, subject);
});

test('email-gmail: the access token is reused, then renewed once after a 401', async () => {
  const connector = gmail();
  await connector.execute('email.send', MAIL, CTX);
  await connector.execute('email.send', MAIL, CTX);
  assert.equal(google.refreshes, 1, 'one refresh for two sends');

  google.rejectAccessTokens();
  await connector.execute('email.send', MAIL, CTX);
  assert.equal(google.refreshes, 2);
  assert.equal(google.sent.length, 3);
  assert.equal(google.sent[2].bearer, 'access-2');
});

test('email-gmail: concurrent sends share one refresh', async () => {
  const connector = gmail();
  await Promise.all([1, 2, 3].map(() => connector.execute('email.send', MAIL, CTX)));
  assert.equal(google.refreshes, 1);
});

test('email-gmail: a revoked refresh token is permanent gmail_reauth_required', async () => {
  const connector = gmail({ refreshToken: 'revoked' });
  const err = await connector.execute('email.send', MAIL, CTX).catch((e) => e);
  assert.ok(err instanceof ReauthRequiredError);
  assert.equal(err.code, 'gmail_reauth_required');
  assert.deepEqual(connector.classifyError(err), { kind: 'permanent' });
  assert.ok(!err.message.includes('revoked') && !err.message.includes(google.clientSecret), 'no secret in the message');
});

test('email-gmail: not connected (no refresh token) and a wrong client are permanent too', async () => {
  for (const connector of [gmail({ refreshToken: null }), gmail({ clientSecret: 'wrong' })]) {
    const err = await connector.execute('email.send', MAIL, CTX).catch((e) => e);
    assert.ok(err instanceof ReauthRequiredError);
    assert.equal(connector.classifyError(err).kind, 'permanent');
  }
  assert.equal(google.sent.length, 0);
});

test('email-gmail: a 401 that stays a 401 after the renewal is permanent', async () => {
  google.sendFailures.push(
    { status: 401, body: { error: { code: 401, errors: [{ reason: 'authError' }] } } },
    { status: 401, body: { error: { code: 401, errors: [{ reason: 'authError' }] } } },
  );
  const connector = gmail();
  const err = await connector.execute('email.send', MAIL, CTX).catch((e) => e);
  assert.ok(err instanceof ReauthRequiredError);
});

test('email-gmail: error classes follow design §7', async () => {
  const connector = gmail();
  const reply = (status, reason, headers) => ({
    status, body: { error: { code: status, errors: [{ reason }] } }, headers,
  });
  const cases = [
    [reply(500, 'backendError'), { kind: 'retryable' }],
    [reply(503, 'backendError'), { kind: 'retryable' }],
    [reply(403, 'userRateLimitExceeded'), { kind: 'retryable' }],
    [reply(403, 'rateLimitExceeded', { 'Retry-After': '7' }), { kind: 'rateLimited', retryAfterMs: 7000 }],
    [reply(429, 'rateLimitExceeded', { 'Retry-After': '3' }), { kind: 'rateLimited', retryAfterMs: 3000 }],
    [reply(429, 'rateLimitExceeded'), { kind: 'retryable' }],
    [reply(403, 'dailyLimitExceeded'), { kind: 'permanent' }],
    [reply(403, 'domainPolicy'), { kind: 'permanent' }],
    [reply(400, 'badRequest'), { kind: 'permanent' }],
  ];
  for (const [failure, expected] of cases) {
    google.sendFailures.push(failure);
    const err = await connector.execute('email.send', MAIL, CTX).catch((e) => e);
    assert.ok(err instanceof UpstreamHttpError, `${failure.status} ${failure.body.error.errors[0].reason}`);
    assert.deepEqual(connector.classifyError(err), expected, `${failure.status} ${failure.body.error.errors[0].reason}`);
  }
  assert.deepEqual(connector.classifyError(new TypeError('fetch failed')), { kind: 'retryable' });
});

test('email-gmail: a recipient that is missing or could add recipients or headers is refused before any call', async () => {
  const connector = gmail();
  for (const to of [null, '', 'no-at-sign', 'a@b.com, c@d.com', 'a@b.com\r\nBcc: x@y.com', 'A <a@b.com>']) {
    const err = await connector.execute('email.send', { ...MAIL, to }, CTX).catch((e) => e);
    assert.ok(err instanceof InvalidEmailError, String(to));
    assert.equal(connector.classifyError(err).kind, 'permanent');
  }
  const err = await connector.execute('email.send', { ...MAIL, subject: 'a\r\nBcc: x@y.com' }, CTX).catch((e) => e);
  assert.ok(err instanceof InvalidEmailError);
  assert.equal(google.refreshes + google.sent.length, 0, 'nothing reached Google');
});

test('email-gmail: unknown action is permanent; healthCheck = a fresh token can be had', async () => {
  const connector = gmail();
  const err = await connector.execute('email.delete', MAIL, CTX).catch((e) => e);
  assert.equal(connector.classifyError(err).kind, 'permanent');
  assert.equal(await connector.healthCheck(), true);
  assert.equal(await gmail({ refreshToken: 'revoked' }).healthCheck(), false);
  assert.deepEqual(connector.capabilities, ['email.send']);
});

test('email-gmail: Google token endpoint down is retryable, not a reauth', async () => {
  google.tokenFailure = { status: 503, body: { error: 'temporarily_unavailable' } };
  const connector = gmail();
  const err = await connector.execute('email.send', MAIL, CTX).catch((e) => e);
  assert.ok(err instanceof UpstreamHttpError);
  assert.equal(connector.classifyError(err).kind, 'retryable');
});
