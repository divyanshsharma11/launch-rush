// A webhook the provider gave up on is sent again by the redelivery job, with the real provider (in-process), our
// connector and a local receiver standing in for our API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadProviderConfig } from '../sims/payment-provider/config.js';
import { startProvider } from '../sims/payment-provider/start.js';
import { createPaymentConnector } from '../src/services/connectors/payment-mock.js';
import { createRedelivery } from '../src/business/redelivery.js';
import { captureLogger } from './helpers.js';

const env = process.env;
const admin = new pg.Client();
await admin.connect();

const received = [];
let status = 503;
const receiver = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    received.push(JSON.parse(Buffer.concat(chunks)).id);
    res.writeHead(status).end();
  });
});
await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

const base = loadProviderConfig(env);
const provider = await startProvider({
  config: {
    ...base,
    port: 0,
    webhookUrl: `http://127.0.0.1:${receiver.address().port}/webhooks/payment`,
    delivery: { ...base.delivery, retries: 1, baseDelayMs: 20, maxDelayMs: 20, pollMs: 30 },
  },
  logger: captureLogger().logger,
});
const payment = createPaymentConnector({ baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: env.PAYMENT_API_KEY });
const redelivery = createRedelivery({ payment, config: { maxAgeMs: 86_400_000 }, timeoutMs: 5_000 });
const orderId = randomUUID();

after(async () => {
  const payments = 'SELECT id FROM paysim.payments WHERE order_id = $1';
  await admin.query(
    `DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id IN (${payments}))`,
    [orderId],
  );
  await admin.query(`DELETE FROM paysim.events WHERE payment_id IN (${payments})`, [orderId]);
  await admin.query('DELETE FROM paysim.payments WHERE order_id = $1', [orderId]);
  await admin.end();
  await provider.shutdown();
  await new Promise((resolve) => receiver.close(resolve));
});

async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const statuses = async () => (await admin.query(
  'SELECT d.status FROM paysim.deliveries d JOIN paysim.events e ON e.id = d.event_id JOIN paysim.payments p ON p.id = e.payment_id WHERE p.order_id = $1',
  [orderId],
)).rows.map((row) => row.status);

test('the provider gives up while our side is down; the redelivery job sends the same event again once it is up', async () => {
  const ctx = { orderId, runId: null, idempotencyKey: `charge-${orderId}`, attempt: 1, timeoutMs: 5_000 };
  await payment.execute('charge', { orderId, amountMinor: 580000, currency: 'INR' }, ctx);
  await waitFor(async () => (await statuses()).join() === 'failed', 'the delivery to give up');
  const eventId = received[0];
  assert.equal(received.length, 2, 'first send and one retry, both refused');

  status = 200;
  assert.ok((await redelivery.run()).redelivered >= 1);
  await waitFor(async () => (await statuses()).join() === 'delivered', 'the redelivery');
  assert.equal(received.at(-1), eventId, 'the same event id as before, so ingress dedupes by it');
  assert.deepEqual(await redelivery.run(), { redelivered: 0 });
});
