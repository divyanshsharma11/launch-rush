// Mock provider start.js (in-process: start, deliver, graceful shutdown) and server.js (child process). Real DB.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadProviderConfig } from '../sims/payment-provider/config.js';
import { startProvider } from '../sims/payment-provider/start.js';
import { captureLogger, SECRET } from './helpers.js';

const API_KEY = 'k'.repeat(32);
const admin = new pg.Client();
await admin.connect();
const keys = [];

// Webhook receiver: answers 200 after delayMs; onArrive runs when a request comes in.
let delayMs = 0;
let onArrive = () => {};
const receiver = createServer((req, res) => {
  onArrive();
  req.resume();
  req.on('end', () => setTimeout(() => res.writeHead(200).end(), delayMs));
}).listen(0, '127.0.0.1');
await once(receiver, 'listening');

after(async () => {
  receiver.closeAllConnections();
  receiver.close();
  const payments = 'SELECT id FROM paysim.payments WHERE idempotency_key = ANY($1)';
  await admin.query(
    `DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id IN (${payments}))`,
    [keys],
  );
  await admin.query(`DELETE FROM paysim.events WHERE payment_id IN (${payments})`, [keys]);
  await admin.query('DELETE FROM paysim.payments WHERE idempotency_key = ANY($1)', [keys]);
  await admin.end();
});

function providerConfig(overrides = {}) {
  const base = loadProviderConfig({
    PAYMENT_PROVIDER_PORT: '1', // replaced by port 0 below
    PAYMENT_WEBHOOK_SECRET: SECRET,
    PAYMENT_API_KEY: API_KEY,
    PAYMENT_WEBHOOK_URL: `http://127.0.0.1:${receiver.address().port}/webhooks/payment`,
  });
  return { ...base, port: 0, delivery: { ...base.delivery, pollMs: 50 }, ...overrides };
}

async function charge(port) {
  const key = `charge-${randomUUID()}`;
  keys.push(key);
  const res = await fetch(`http://127.0.0.1:${port}/charges`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ orderId: randomUUID(), amountMinor: 580000, currency: 'INR' }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function deliveryStatuses(paymentId) {
  const { rows } = await admin.query(
    'SELECT d.status FROM paysim.deliveries d JOIN paysim.events e ON e.id = d.event_id WHERE e.payment_id = $1',
    [paymentId],
  );
  return rows.map((r) => r.status);
}

async function freePort() {
  const probe = createNetServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('startProvider: serves and delivers; shutdown waits for the send in flight, then refuses connections', async () => {
  delayMs = 300;
  const { logger, lines } = captureLogger();
  const provider = await startProvider({ config: providerConfig(), logger });
  const arrived = new Promise((resolve) => { onArrive = resolve; });
  const { paymentId } = await charge(provider.port);
  await arrived; // the webhook is now in flight
  await provider.shutdown();
  assert.deepEqual(await deliveryStatuses(paymentId), ['delivered']);
  assert.deepEqual(
    lines.map((l) => l.msg).filter((msg) => msg.startsWith('provider ')),
    ['provider listening', 'provider shutting down', 'provider stopped'],
  );
  await assert.rejects(
    fetch(`http://127.0.0.1:${provider.port}/health`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
    (err) => err.cause?.code === 'ECONNREFUSED',
  );
  assert.equal(provider.shutdown(), provider.shutdown(), 'a second call returns the same shutdown');
  delayMs = 0;
});

test('startProvider: port already in use → rejects with EADDRINUSE', async () => {
  const config = providerConfig({ port: receiver.address().port });
  await assert.rejects(startProvider({ config, logger: captureLogger().logger }), { code: 'EADDRINUSE' });
});

function spawnNode(args, env = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (text) => lines.push(text));
  const closed = new Promise((resolve) => child.once('close', (code) => resolve({ code, at: Date.now() })));
  return { child, lines, closed };
}

test('server.js (npm run provider): listens on PAYMENT_PROVIDER_PORT and answers /health', async () => {
  const port = await freePort();
  const p = spawnNode(['sims/payment-provider/server.js'], { PAYMENT_PROVIDER_PORT: String(port) });
  for (let i = 0; i < 100 && !p.lines.some((l) => JSON.parse(l).msg === 'provider listening'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${process.env.PAYMENT_API_KEY}` } });
  assert.equal(res.status, 200);
  p.child.kill(); // Windows: forced; graceful shutdown is tested in-process above
  await p.closed;
});

test('server.js: port in use → fatal "provider failed to start" log and exit code 1', async () => {
  const p = spawnNode(['sims/payment-provider/server.js'], { PAYMENT_PROVIDER_PORT: String(receiver.address().port) });
  assert.equal((await p.closed).code, 1);
  const fatal = p.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'provider failed to start');
  assert.equal(fatal.level, 60); // pino fatal
  assert.equal(fatal.err.code, 'EADDRINUSE');
});

test('after shutdown nothing keeps the process alive: it exits with code 0 by itself', async () => {
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import { startProvider } from ${url('../sims/payment-provider/start.js')};
    import { loadProviderConfig } from ${url('../sims/payment-provider/config.js')};
    import { createLogger } from ${url('../src/logger.js')};
    const provider = await startProvider({ config: { ...loadProviderConfig(process.env), port: 0 }, logger: createLogger({ level: 'silent' }) });
    await fetch('http://127.0.0.1:' + provider.port + '/health', { headers: { Authorization: 'Bearer ' + process.env.PAYMENT_API_KEY } });
    await provider.shutdown();
    console.log(Date.now());
  `;
  const p = spawnNode(['--input-type=module', '-e', script]);
  const { code, at } = await p.closed;
  assert.equal(code, 0);
  const lingered = at - Number(p.lines.at(-1));
  assert.ok(lingered < 1_000, `exited ${lingered} ms after shutdown`);
});
