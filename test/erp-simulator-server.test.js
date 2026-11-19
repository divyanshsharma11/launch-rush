// ERP simulator start.js (in-process: start, graceful shutdown) and server.js (child process). Real DB and Redis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { captureLogger } from './helpers.js';

const config = { ...loadErpSimConfig(process.env), port: 0 };
const TOKEN = `token ${config.apiKey}:${config.apiSecret}`;

async function freePort() {
  const probe = createNetServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function spawnNode(args, env = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (text) => lines.push(text));
  const closed = new Promise((resolve) => child.once('close', (code) => resolve({ code, at: Date.now() })));
  return { child, lines, closed };
}

test('startErpSimulator: serves, then shutdown logs, refuses new connections and is idempotent', async () => {
  const { logger, lines } = captureLogger();
  const sim = await startErpSimulator({ config, logger });
  const res = await fetch(`http://127.0.0.1:${sim.port}/health`, { headers: { Authorization: TOKEN } });
  assert.equal(res.status, 200);

  await sim.shutdown();
  assert.deepEqual(
    lines.map((line) => line.msg).filter((msg) => msg.startsWith('erp simulator ')),
    ['erp simulator listening', 'erp simulator shutting down', 'erp simulator stopped'],
  );
  await assert.rejects(
    fetch(`http://127.0.0.1:${sim.port}/health`, { headers: { Authorization: TOKEN } }),
    (err) => err.cause?.code === 'ECONNREFUSED',
  );
  assert.equal(sim.shutdown(), sim.shutdown(), 'a second call returns the same shutdown');
});

test('startErpSimulator: port already in use -> rejects with EADDRINUSE', async () => {
  const first = await startErpSimulator({ config, logger: captureLogger().logger });
  try {
    await assert.rejects(startErpSimulator({ config: { ...config, port: first.port }, logger: captureLogger().logger }), {
      code: 'EADDRINUSE',
    });
  } finally {
    await first.shutdown();
  }
});

test('server.js (npm run erp-sim): listens on ERP_SIM_PORT and answers /health', async () => {
  const port = await freePort();
  const sim = spawnNode(['sims/erp-simulator/server.js'], { ERP_SIM_PORT: String(port) });
  for (let i = 0; i < 100 && !sim.lines.some((line) => JSON.parse(line).msg === 'erp simulator listening'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: TOKEN } });
  assert.equal(res.status, 200);
  sim.child.kill(); // Windows: forced; graceful shutdown is tested in-process above
  await sim.closed;
});

test('server.js: port in use -> fatal "erp simulator failed to start" log and exit code 1', async () => {
  const first = await startErpSimulator({ config, logger: captureLogger().logger });
  try {
    const sim = spawnNode(['sims/erp-simulator/server.js'], { ERP_SIM_PORT: String(first.port) });
    assert.equal((await sim.closed).code, 1);
    const fatal = sim.lines.map((line) => JSON.parse(line)).find((line) => line.msg === 'erp simulator failed to start');
    assert.equal(fatal.level, 60); // pino fatal
    assert.equal(fatal.err.code, 'EADDRINUSE');
  } finally {
    await first.shutdown();
  }
});

test('after shutdown nothing keeps the process alive: it exits with code 0 by itself', async () => {
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import { startErpSimulator } from ${url('../sims/erp-simulator/start.js')};
    import { loadErpSimConfig } from ${url('../sims/erp-simulator/config.js')};
    import { createLogger } from ${url('../src/logger.js')};
    const sim = await startErpSimulator({ config: { ...loadErpSimConfig(process.env), port: 0 }, logger: createLogger({ level: 'silent' }) });
    await sim.shutdown();
    console.log(Date.now());
  `;
  const sim = spawnNode(['--input-type=module', '-e', script]);
  const { code, at } = await sim.closed;
  assert.equal(code, 0);
  const lingered = at - Number(sim.lines.at(-1));
  assert.ok(lingered < 1_000, `exited ${lingered} ms after shutdown`);
});
