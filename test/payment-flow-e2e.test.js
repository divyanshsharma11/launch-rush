// Step 3 end to end: the real src/api.js (child process), the real mock provider (in-process) and our connector.
// charge → signed webhook → ingress → payment_events row + webhook job; Duplicate → deduped; refund → stored too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { Queue } from 'bullmq';
import { loadProviderConfig } from '../sims/payment-provider/config.js';
import { startProvider } from '../sims/payment-provider/start.js';
import { createPaymentConnector } from '../src/services/connectors/payment-mock.js';
import { captureLogger, createTestOrder } from './helpers.js';

const env = process.env;
const apiLines = [];
let api;
let provider;
let connector;
let order;
const queue = new Queue('webhooks', { connection: { host: env.REDIS_HOST, port: Number(env.REDIS_PORT) } });
const jobIds = [];

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

before(async () => {
  const apiPort = await freePort();
  api = spawn(process.execPath, ['src/api.js'], { env: { ...env, PORT: String(apiPort) } });
  await new Promise((resolve, reject) => {
    api.once('exit', (code) => reject(new Error(`api exited early with code ${code}`)));
    createInterface({ input: api.stdout }).on('line', (text) => {
      const line = JSON.parse(text);
      apiLines.push(line);
      if (line.msg === 'api listening') resolve();
    });
  });
  const base = loadProviderConfig(env);
  const config = {
    ...base,
    port: 0,
    webhookUrl: `http://127.0.0.1:${apiPort}/webhooks/payment`,
    delivery: { ...base.delivery, pollMs: 50 },
  };
  provider = await startProvider({ config, logger: captureLogger().logger });
  connector = createPaymentConnector({ baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: env.PAYMENT_API_KEY });
  order = await createTestOrder();
});

after(async () => {
  for (const id of jobIds) await queue.remove(id);
  await queue.close();
  await provider?.shutdown();
  api?.kill(); // Windows: forced
  if (order) {
    const payments = 'SELECT id FROM paysim.payments WHERE order_id = $1';
    await order.admin.query(
      `DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id IN (${payments}))`,
      [order.orderId],
    );
    await order.admin.query(`DELETE FROM paysim.events WHERE payment_id IN (${payments})`, [order.orderId]);
    await order.admin.query(`DELETE FROM paysim.refunds WHERE payment_id IN (${payments})`, [order.orderId]);
    await order.admin.query('DELETE FROM paysim.payments WHERE order_id = $1', [order.orderId]);
    await order.remove(); // cascades to payment_events
  }
});

const ctx = (key) => ({ orderId: order.orderId, runId: null, idempotencyKey: `${key}-${order.orderId}`, attempt: 1, timeoutMs: 5_000 });

async function storedEvents() {
  const { rows } = await order.admin.query(
    'SELECT event_id, type, payload FROM payment_events WHERE order_id = $1 ORDER BY received_at',
    [order.orderId],
  );
  return rows;
}

async function deliveryStatuses(eventId) {
  const { rows } = await order.admin.query('SELECT status FROM paysim.deliveries WHERE event_id = $1', [eventId]);
  return rows.map((r) => r.status);
}

let paymentId;
let succeededId;

test('charge: the provider signs and delivers payment.succeeded; our ingress stores it once and queues one job', async () => {
  ({ paymentId } = await connector.execute('charge', { orderId: order.orderId, amountMinor: 580000, currency: 'INR' }, ctx('charge')));
  const [event] = await waitFor(async () => {
    const rows = await storedEvents();
    return rows.length === 1 && rows;
  }, 'payment.succeeded at our ingress');
  succeededId = event.event_id;
  jobIds.push(succeededId);
  assert.equal(event.type, 'payment.succeeded');
  assert.deepEqual(event.payload.data, { paymentId, orderId: order.orderId, amountMinor: 580000, currency: 'INR' });
  assert.deepEqual(await waitFor(async () => (await deliveryStatuses(succeededId)).includes('delivered') && deliveryStatuses(succeededId), 'delivered'), ['delivered']);
  const job = await queue.getJob(succeededId);
  assert.deepEqual(job.data, { eventId: succeededId });
});

test('Duplicate (resend): same event id delivered again; our ingress stores no second row and adds no second job', async () => {
  assert.deepEqual(await connector.execute('resend_webhook', { paymentId }, ctx('unused')), { eventId: succeededId });
  await waitFor(async () => (await deliveryStatuses(succeededId)).every((s) => s === 'delivered') && (await deliveryStatuses(succeededId)).length === 2, 'second delivery');
  assert.equal((await storedEvents()).length, 1);
  const received = apiLines.filter((l) => l.msg === 'payment event received' && l.eventId === succeededId);
  assert.deepEqual(received.map((l) => l.duplicate), [false, true]);
  assert.equal((await queue.getJobs(['waiting'])).filter((j) => j.id === succeededId).length, 1);
});

test('refund: payment.refunded (with orderId) reaches our ingress and is stored and queued too', async () => {
  const { refundId } = await connector.execute('refund', { paymentId }, ctx('refund'));
  const rows = await waitFor(async () => {
    const all = await storedEvents();
    return all.length === 2 && all;
  }, 'payment.refunded at our ingress');
  const refunded = rows.find((r) => r.type === 'payment.refunded');
  jobIds.push(refunded.event_id);
  assert.deepEqual(refunded.payload.data, { refundId, paymentId, orderId: order.orderId, amountMinor: 580000, currency: 'INR' });
  await waitFor(() => queue.getJob(refunded.event_id), 'payment.refunded job');
});
