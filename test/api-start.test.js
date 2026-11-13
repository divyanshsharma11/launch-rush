// Smoke test: starts the real src/api.js as a child process on a free port, against the real containers.
// Only rejected requests are sent, so nothing is stored or queued.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

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
  child.kill(); // Windows: unconditional termination (Node docs); clean shutdown is roadmap Step 6
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
