// The Step's demo: the ERP goes down while orders are being fulfilled. Retries use attempts, the breaker opens, the
// jobs wait without using attempts, and once the ERP is back every order completes. Real worker, breaker-protected
// connector, ERP simulator, PostgreSQL and Redis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createDb } from '../src/services/db/index.js';
import { createFulfilmentQueue, createWorker } from '../src/services/queue/index.js';
import { createErpConnector } from '../src/services/connectors/erp-sim.js';
import { createBreakers } from '../src/services/connectors/breaker.js';
import { createFulfilment } from '../src/business/fulfilment.js';
import { createFulfilmentJob } from '../src/jobs/fulfilment-job.js';
import { addErpItem, captureLogger, createTestShop, removeErpItem } from './helpers.js';

const base = loadConfig(process.env);
const simConfig = { ...loadErpSimConfig(process.env), port: 0 };
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const redis = new Redis(base.redis);
const name = `fulfilment-test-${randomUUID()}`;
const jobOptions = { attempts: 5, backoff: { type: 'exponential', delay: 20 }, removeOnComplete: false, removeOnFail: false };
let shop;
let sim;
let breakers;
let queue;
let inspect;
let worker;
let runId;

before(async () => {
  shop = await createTestShop({ stockTotal: 10 });
  await addErpItem(shop.admin, shop.gameId, 10);
  sim = await startErpSimulator({ config: simConfig, logger: captureLogger().logger });
  breakers = createBreakers({ settings: { ...base.breaker, resetTimeoutMs: 300 }, logger });
  const erp = breakers.protect(
    createErpConnector({ baseUrl: `http://127.0.0.1:${sim.port}`, apiKey: simConfig.apiKey, apiSecret: simConfig.apiSecret }),
  );
  const fulfilment = createFulfilment({ db, erp, emailQueue: { add: async () => {} }, config: base.erp, logger });
  const job = createFulfilmentJob({ fulfilment, classifyError: erp.classifyError });
  queue = createFulfilmentQueue({ redis: base.redis, jobOptions, logger, name });
  inspect = new Queue(name, { connection: base.redis });
  worker = createWorker({
    name,
    redis: base.redis,
    concurrency: 3,
    processor: (j, token) => job.process(j, token),
    onFinalFailure: (j, err) => job.onFinalFailure(j, err),
    logger,
  });

  const sessionId = await shop.newSession();
  const { rows } = await shop.admin.query(
    `INSERT INTO demo_runs (session_id, game_id, stock_total, buyers_requested, faults, status, ends_at)
     VALUES ($1, $2, 5, 5, '{}', 'running', now() + interval '5 minutes') RETURNING id`,
    [sessionId, shop.gameId],
  );
  runId = rows[0].id;
  const res = await fetch(`http://127.0.0.1:${sim.port}/sim/stock-receipts`, {
    method: 'POST',
    body: JSON.stringify({ receiptId: `run-${runId}`, itemCode: shop.gameId, qty: 5, runId }),
    headers: { Authorization: `token ${simConfig.apiKey}:${simConfig.apiSecret}`, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 200);
});

after(async () => {
  await worker.close();
  await queue.close();
  await inspect.obliterate({ force: true });
  await inspect.close();
  await redis.del(`faults:${runId}`);
  await shop.admin.query('DELETE FROM demo_runs WHERE game_id = $1', [shop.gameId]);
  await removeErpItem(shop.admin, shop.gameId);
  await shop.remove();
  await sim.shutdown();
  breakers.close();
  await redis.quit();
  await db.close();
});

async function waitFor(check, what, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('ERP down: the breaker opens, jobs wait without using attempts, and every order completes when the ERP is back', async () => {
  const orderIds = [];
  for (let i = 0; i < 3; i += 1) {
    const order = await db.insertOrder({
      id: randomUUID(), sessionId: await shop.newSession(), gameId: shop.gameId, state: 'reserved',
      runId, buyerRef: randomUUID(), holdMs: 300_000,
    });
    await db.transition(order.id, 'reserved', 'payment_pending');
    await db.transition(order.id, 'payment_pending', 'paid');
    orderIds.push(order.id);
  }
  await redis.set(`faults:${runId}`, JSON.stringify({ down: true }));
  for (const orderId of orderIds) await queue.add(orderId);

  await waitFor(() => breakers.states().some((s) => s.runId === runId && s.state === 'open'), 'an open breaker');
  const waiting = await waitFor(async () => {
    const jobs = await Promise.all(orderIds.map((id) => inspect.getJob(`fulfil-${id}`)));
    return jobs.some((j) => j.attemptsStarted > j.attemptsMade) && jobs;
  }, 'a job that was delayed by the breaker');
  for (const job of waiting) assert.ok(job.attemptsMade < jobOptions.attempts, 'no job has used all its attempts');

  await redis.del(`faults:${runId}`);
  for (const orderId of orderIds) {
    await waitFor(async () => (await db.getOrder(orderId)).state === 'completed', `order ${orderId} completed`);
  }
  assert.equal(breakers.states().find((s) => s.runId === runId).state, 'closed');
  assert.ok(lines.some((l) => l.msg === 'breaker open' && l.runId === runId));
  assert.ok(lines.some((l) => l.msg === 'breaker closed' && l.runId === runId));
  const { rows } = await shop.admin.query(
    "SELECT count(*)::int AS n FROM erp_documents WHERE order_id = ANY($1) AND doctype = 'Sales Invoice' AND docstatus = 1", [orderIds],
  );
  assert.equal(rows[0].n, 3, 'one submitted Sales Invoice per order, none duplicated');
});
