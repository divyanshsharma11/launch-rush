// CORS on the /api router (design §5): fixed portfolio origin, preflight answer, headers on every reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApiRouter } from '../src/controllers/api.js';
import { createErrorHandler, notFound } from '../src/controllers/errors.js';
import { captureLogger } from './helpers.js';

const ORIGIN = 'https://portfolio.example';
const { logger } = captureLogger();
let server;
let base;

before(async () => {
  const orders = { createSession: async () => 'a-session', sessionExists: async () => false }; // other routes get 401
  const app = express();
  app.use('/api', createApiRouter({ orders, cors: { allowedOrigin: ORIGIN, maxAgeSeconds: 600 }, logger }));
  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('preflight: 204 with the allowed origin, methods, headers and max age', async () => {
  const res = await fetch(`${base}/api/orders`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://other.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-session-id' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN); // fixed, not the caller's origin
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PUT');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, X-Session-Id');
  assert.equal(res.headers.get('access-control-max-age'), '600');
  assert.match(res.headers.get('vary'), /Origin/);
});

test('every reply carries the origin, Vary and the exposed Retry-After: success, 401 and unknown route', async () => {
  const replies = [
    await fetch(`${base}/api/session`, { method: 'POST' }),
    await fetch(`${base}/api/games`),
    await fetch(`${base}/api/nothing-here`),
  ];
  assert.deepEqual(replies.map((res) => res.status), [201, 401, 401]);
  for (const res of replies) {
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(res.headers.get('vary'), /Origin/);
    assert.equal(res.headers.get('access-control-expose-headers'), 'Retry-After');
  }
});

test('an OPTIONS request that is not a preflight is not answered as one', async () => {
  const res = await fetch(`${base}/api/games`, { method: 'OPTIONS' });
  assert.notEqual(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), null);
});
