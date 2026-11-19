// Graceful shutdown of the API and the worker. In-process (a signal kills a child on Windows without cleanup, so
// signals cannot be tested there), plus a child process that must exit by itself once shutdown() has finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { loadConfig } from '../src/config.js';
import { startApi } from '../src/start-api.js';
import { startWorker } from '../src/start-worker.js';
import { captureLogger } from './helpers.js';

const config = loadConfig(process.env);
const withPort = (port) => ({ ...config, api: { ...config.api, port } });

async function runChild(code, env = {}) {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const killer = setTimeout(() => child.kill(), 20_000);
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  clearTimeout(killer);
  return { exitCode, output };
}

test('API: shutdown stops listening and is safe to call twice', async () => {
  const { logger, lines } = captureLogger();
  const api = await startApi({ config: withPort(0), logger });
  const base = `http://127.0.0.1:${api.port}`;
  assert.equal((await fetch(`${base}/nope`)).status, 404);

  const first = api.shutdown();
  assert.equal(api.shutdown(), first);
  await first;

  await assert.rejects(fetch(`${base}/nope`));
  assert.deepEqual(lines.map((line) => line.msg).slice(-2), ['api shutting down', 'api stopped']);
});

test('API: an open stream does not block the shutdown; the page is told by the stream ending', async () => {
  const { logger } = captureLogger();
  const api = await startApi({ config: withPort(0), logger });
  const base = `http://127.0.0.1:${api.port}`;
  const { sessionId } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
  const stream = await fetch(`${base}/api/stream?session=${sessionId}`);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read(); // retry: 3000

  const stopped = api.shutdown();
  const ended = (async () => { while (!(await reader.read()).done); })();
  await Promise.race([
    Promise.all([stopped, ended]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown is stuck on the open stream')), 5000)),
  ]);

  const admin = new (await import('pg')).default.Client();
  await admin.connect();
  await admin.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  await admin.end();
});

test('API: a port in use rejects the start and leaves nothing open', async () => {
  const taken = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => taken.once('listening', resolve));
  try {
    const { logger } = captureLogger();
    await assert.rejects(startApi({ config: withPort(taken.address().port), logger }), { code: 'EADDRINUSE' });
  } finally {
    await new Promise((resolve) => taken.close(resolve));
  }
});

test('worker: shutdown waits for the timers and workers, closes everything and is safe to call twice', async () => {
  const { logger, lines } = captureLogger();
  const worker = await startWorker({ config, logger });
  assert.ok(lines.some((line) => line.msg === 'worker running'));

  const first = worker.shutdown();
  assert.equal(worker.shutdown(), first);
  await first;
  assert.deepEqual(lines.map((line) => line.msg).slice(-2), ['worker shutting down', 'worker stopped']);
});

test('API process: after shutdown() nothing keeps it alive, it exits by itself with code 0', async () => {
  const { exitCode, output } = await runChild(`
    import { loadConfig } from './src/config.js';
    import { createLogger } from './src/logger.js';
    import { startApi } from './src/start-api.js';
    const config = loadConfig(process.env);
    const api = await startApi({ config: { ...config, api: { ...config.api, port: 0 } }, logger: createLogger({ level: 'silent' }) });
    await api.shutdown();
    console.log('shutdown done');
  `);
  assert.match(output, /shutdown done/);
  assert.equal(exitCode, 0);
});

test('API process with the admin API on: after shutdown() the extra queues are closed too, it exits by itself with code 0', async () => {
  const { exitCode, output } = await runChild(`
    import { loadConfig } from './src/config.js';
    import { createLogger } from './src/logger.js';
    import { startApi } from './src/start-api.js';
    const config = loadConfig({ ...process.env, ADMIN_PASSWORD_HASH: 'ab'.repeat(64), ADMIN_PASSWORD_SALT: 'cd'.repeat(16) });
    const api = await startApi({ config: { ...config, api: { ...config.api, port: 0 } }, logger: createLogger({ level: 'silent' }) });
    await api.shutdown();
    console.log('shutdown done');
  `);
  assert.match(output, /shutdown done/);
  assert.equal(exitCode, 0);
});

test('worker process: after shutdown() nothing keeps it alive, it exits by itself with code 0', async () => {
  const { exitCode, output } = await runChild(`
    import { loadConfig } from './src/config.js';
    import { createLogger } from './src/logger.js';
    import { startWorker } from './src/start-worker.js';
    const worker = await startWorker({ config: loadConfig(process.env), logger: createLogger({ level: 'silent' }) });
    await worker.shutdown();
    console.log('shutdown done');
  `);
  assert.match(output, /shutdown done/);
  assert.equal(exitCode, 0);
});

test('API process: a failed start (PostgreSQL unreachable) leaves nothing open, the process exits by itself', async () => {
  const { exitCode, output } = await runChild(`
    import { loadConfig } from './src/config.js';
    import { createLogger } from './src/logger.js';
    import { startApi } from './src/start-api.js';
    const config = loadConfig(process.env);
    await startApi({ config: { ...config, api: { ...config.api, port: 0 } }, logger: createLogger({ level: 'silent' }) })
      .catch((err) => console.log('start rejected', err.code));
  `, { PGPORT: '1' });
  assert.match(output, /start rejected ECONNREFUSED/);
  assert.equal(exitCode, 0);
});

test('worker process: a failed start (PostgreSQL unreachable) leaves nothing open, the process exits by itself', async () => {
  const { exitCode, output } = await runChild(`
    import { loadConfig } from './src/config.js';
    import { createLogger } from './src/logger.js';
    import { startWorker } from './src/start-worker.js';
    await startWorker({ config: loadConfig(process.env), logger: createLogger({ level: 'silent' }) })
      .catch((err) => console.log('start rejected', err.code));
  `, { PGPORT: '1' });
  assert.match(output, /start rejected ECONNREFUSED/);
  assert.equal(exitCode, 0);
});
