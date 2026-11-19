// The static admin page: served without a login with its security headers, and the API routes behind it still work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createAdminPage } from '../src/controllers/admin-page.js';
import { notFound } from '../src/controllers/errors.js';

let dir;
let server;
let origin;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'admin-page-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
  const app = express();
  app.use('/admin', createAdminPage({ dir }));
  app.get('/admin/health', (req, res) => res.json({ api: true })); // stands for the API routes after the page
  app.use(notFound);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('/admin/ serves the page with a CSP that allows only its own origin, no framing and no sniffing', async () => {
  const res = await fetch(`${origin}/admin/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>admin<\/title>/);
  const csp = res.headers.get('content-security-policy');
  const parts = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"];
  for (const part of parts) {
    assert.ok(csp.includes(part), part);
  }
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('/admin without the slash redirects to /admin/; assets are served', async () => {
  const res = await fetch(`${origin}/admin`, { redirect: 'manual' });
  assert.ok([301, 302, 307, 308].includes(res.status), `status ${res.status}`);
  assert.equal(new URL(res.headers.get('location'), origin).pathname, '/admin/');
  assert.equal(await (await fetch(`${origin}/admin/assets/app.js`)).text(), 'console.log(1)');
});

test('a path with no file falls through: the route behind it is reached, and without one the 404 JSON handler answers', async () => {
  assert.deepEqual(await (await fetch(`${origin}/admin/health`)).json(), { api: true });
  const res = await fetch(`${origin}/admin/nope.js`);
  assert.deepEqual([res.status, (await res.json()).error.code], [404, 'not_found']);
});

test('a missing page folder (not built yet) is not an error: everything falls through', async () => {
  const app = express();
  app.use('/admin', createAdminPage({ dir: join(dir, 'does-not-exist') }));
  app.use(notFound);
  const missing = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => missing.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${missing.address().port}/admin/`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => missing.close(resolve));
  }
});
