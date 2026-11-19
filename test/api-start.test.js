// Smoke test: starts the real src/api.js as a child process on a free port, against the real containers.
// Only rejected requests are sent, except the rate-limit test, which cleans up its sessions and counters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { Redis } from 'ioredis';

let child;
let baseUrl;
const lines = [];

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  const port = await freePort();
  child = spawn(process.execPath, ['src/api.js'], { env: { ...process.env, PORT: String(port) } });

  // Resolves on the 'api listening' log line; rejects if the process exits first.
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`api exited early with code ${code}`)));
    createInterface({ input: child.stdout }).on('line', (text) => {
      const line = JSON.parse(text);
      lines.push(line);
      if (line.msg === 'api listening') resolve();
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  child.kill(); // Windows: unconditional termination (Node docs); a clean shutdown is tested in-process
});

test('startup logs waiting for redis, then listening on 127.0.0.1 by default', () => {
  assert.deepEqual(lines.map((line) => line.msg).slice(0, 2), ['waiting for redis', 'api listening']);
  assert.equal(lines[1].host, '127.0.0.1');
});

test('webhook route is wired: a badly signed request gets 400 invalid_signature', async () => {
  const res = await fetch(`${baseUrl}/webhooks/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mock-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
    body: JSON.stringify({ id: 'evt_smoke' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_signature');
});

test('unknown route: 404 not_found as JSON', async () => {
  const res = await fetch(`${baseUrl}/nope`, { method: 'POST' });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'route not found' } });
});

test('CORS and the stream are wired: preflight answered, an unknown session on the stream gets 401 with the origin', async () => {
  const origin = process.env.PORTFOLIO_ORIGIN || 'http://localhost:5173';
  const preflight = await fetch(`${baseUrl}/api/orders`, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);

  const stream = await fetch(`${baseUrl}/api/stream?session=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`);
  assert.equal(stream.status, 401);
  assert.equal((await stream.json()).error.code, 'session_required');
  assert.equal(stream.headers.get('access-control-allow-origin'), origin);
});

test('the rate limiter is wired: the 11th session from one IP in a minute gets 429', async () => {
  const admin = new pg.Client();
  const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  const sessionIds = [];
  try {
    await admin.connect();
    const old = await redis.keys('ratelimit:sessionCreate:*'); // left by other tests that create sessions
    if (old.length) await redis.del(...old);
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await fetch(`${baseUrl}/api/session`, { method: 'POST' });
      if (last.status === 201) sessionIds.push((await last.json()).sessionId);
    }
    assert.equal(sessionIds.length, 10);
    assert.equal(last.status, 429);
    assert.equal((await last.json()).error.code, 'rate_limited');
  } finally {
    await admin.query('DELETE FROM sessions WHERE id = ANY($1)', [sessionIds]);
    const counters = await redis.keys('ratelimit:sessionCreate:*');
    if (counters.length) await redis.del(...counters);
    await admin.end();
    redis.disconnect();
  }
});
