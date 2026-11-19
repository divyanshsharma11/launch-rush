// The admin API is wired into the real src/api.js: off without ADMIN_PASSWORD_HASH, on with it.
// Sends only a login and read-only calls; the login session is removed at the end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { Redis } from 'ioredis';
import { hashPassword } from '../src/business/admin-auth.js';

const PASSWORD = 'correct horse battery';
const BUILT_PAGE = join(import.meta.dirname, '..', 'admin', 'dist', 'index.html');
const children = [];
const sessions = [];
let redis;
let limitKeysBefore;

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The API as a child process; resolves with its base URL once it logs 'api listening'.
async function startApi(env) {
  const port = await freePort();
  // No Gmail settings, so the health check makes no request to Google; the default host, so the default admin origin
  // is the address used below.
  const blank = { ADMIN_ORIGIN: '', API_HOST: '', GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '', GMAIL_ADDRESS: '' };
  const child = spawn(process.execPath, ['src/api.js'], { env: { ...process.env, PORT: String(port), ...blank, ...env } });
  children.push(child);
  const lines = [];
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`api exited early with code ${code}`)));
    createInterface({ input: child.stdout }).on('line', (text) => {
      const line = JSON.parse(text);
      lines.push(line);
      if (line.msg === 'api listening') resolve();
    });
  });
  return { url: `http://127.0.0.1:${port}`, lines };
}

before(async () => {
  redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  limitKeysBefore = await redis.keys('ratelimit:adminLogin:*');
});

after(async () => {
  for (const child of children) child.kill(); // Windows: unconditional termination (Node docs)
  // The login counted against this PC's address for a minute, which would count in the next test run too.
  const added = (await redis.keys('ratelimit:adminLogin:*')).filter((key) => !limitKeysBefore.includes(key));
  const stale = [...sessions, ...added];
  if (stale.length) await redis.del(...stale);
  redis.disconnect();
});

test('without ADMIN_PASSWORD_HASH the /admin routes are not served and the listening line says admin false', async () => {
  const { url, lines } = await startApi({ ADMIN_PASSWORD_HASH: '', ADMIN_PASSWORD_SALT: '' });
  assert.equal(lines.find((line) => line.msg === 'api listening').admin, false);
  const res = await fetch(`${url}/admin/health`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
  assert.equal((await fetch(`${url}/admin/`)).status, 404); // the page is not mounted either
});

test('with a hash: login works from the admin origin, health lists the four connectors and the queues', async () => {
  const salt = randomBytes(16);
  const { url, lines } = await startApi({
    ADMIN_PASSWORD_HASH: (await hashPassword(PASSWORD, salt)).toString('hex'),
    ADMIN_PASSWORD_SALT: salt.toString('hex'),
  });
  assert.equal(lines.find((line) => line.msg === 'api listening').admin, true);
  const wrongOrigin = await fetch(`${url}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(wrongOrigin.status, 403);

  const login = await fetch(`${url}/admin/login`, {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  sessions.push(`admin:session:${cookie.split('=')[1]}`);

  const health = await fetch(`${url}/admin/health`, { headers: { Cookie: cookie } });
  assert.equal(health.status, 200);
  const { connectors, queues } = await health.json();
  assert.deepEqual(connectors.map((c) => c.id), ['payment-mock', 'erp-sim', 'email-gmail', 'email-mock']);
  assert.ok(connectors.every((c) => typeof c.healthy === 'boolean' && ['closed', 'open', 'halfOpen'].includes(c.breaker)));
  assert.deepEqual(Object.keys(queues), ['webhooks', 'fulfilment', 'email', 'runs']);

  // The page needs no login. admin/dist exists only after `npm run build` in admin/; without it the request reaches the
  // API, which wants a login.
  const page = await fetch(`${url}/admin/`);
  if (existsSync(BUILT_PAGE)) {
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } else {
    assert.equal(page.status, 401);
  }

  const failed = await fetch(`${url}/admin/deliveries?status=failed`, { headers: { Cookie: cookie } });
  assert.equal(failed.status, 200);
  assert.ok(Array.isArray((await failed.json()).deliveries));
});
