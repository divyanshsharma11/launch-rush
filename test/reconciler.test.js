// Reconciler invariants and the scoreboard against real PostgreSQL and Redis.
// The shop scoreboard is scoped to the test game through a thin wrapper, so other data in the database is not counted.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, runPool, shopPool } from '../src/services/redis/index.js';
import { createReconciler } from '../src/business/reconciler.js';
import { captureLogger, createTestShop, paymentEvent } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
let shop;
let reconciler;
let runId;

const scopedDb = () => ({
  ...db,
  shopStockTotals: () => db.shopStockTotals(shop.gameId),
  invariantCounts: (scope, graceMs) => db.invariantCounts({ ...scope, gameId: shop.gameId }, graceMs),
});

async function order(state, { inRun = false, via = [] } = {}) {
  const created = await db.insertOrder({
    id: randomUUID(), sessionId: await shop.newSession(), gameId: shop.gameId, state: 'reserved', holdMs: 300_000,
    ...(inRun && { runId, buyerRef: randomUUID() }),
  });
  let from = 'reserved';
  for (const next of [...via, state].filter((s) => s !== 'reserved')) {
    assert.equal(await db.transition(created.id, from, next), true, `${from} -> ${next}`);
    from = next;
  }
  return created.id;
}

const age = (orderId, column, table = 'orders') =>
  shop.admin.query(`UPDATE ${table} SET ${column} = now() - interval '5 minutes' WHERE ${table === 'orders' ? 'id' : 'order_id'} = $1`, [orderId]);

before(() => redis.ready());

beforeEach(async () => {
  if (shop) {
    await redis.deletePool(shopPool(shop.gameId));
    await redis.deleteRun(runId);
    await shop.remove();
  }
  shop = await createTestShop({ stockTotal: 2 });
  const sessionId = await shop.newSession();
  runId = (await db.insertRun({
    sessionId, gameId: shop.gameId, stockTotal: 2, buyersRequested: 5, faults: {}, durationMs: 60_000, maxRunning: 1000,
  })).run.id;
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 2 }]);
  await redis.initRunStock(runId, 2);
  reconciler = createReconciler({ db: scopedDb(), redis, config: config.reconciler });
});

after(async () => {
  const cleaner = new Redis(config.redis);
  await cleaner.del('scoreboard:latest'); // written by the run() test
  await cleaner.quit();
  await redis.deletePool(shopPool(shop.gameId));
  await redis.deleteRun(runId);
  await shop.remove();
  await redis.close();
  await db.close();
});

test('a clean shop: nothing sold, no violations, stock = starting stock', async () => {
  const board = await reconciler.scoreboard();
  assert.deepEqual(
    { ...board, checkedAt: undefined },
    {
      sold: 0, stock: 2, oversold: 0, lost: 0, paidNotInvoicedOrRefunded: 0, completedWithoutInvoice: 0,
      duplicatesBlocked: 0, stockMismatches: [], checkedAt: undefined,
    },
  );
  assert.ok(!Number.isNaN(Date.parse(board.checkedAt)));
});

test('sold counts each order once however it ended, and oversold appears when sold > starting stock + receipts', async () => {
  const moved = await order('paid');
  await order('paid');
  await order('paid', { via: ['payment_pending'] });
  await db.transition(moved, 'paid', 'so_submitted'); // still one order sold
  let board = await reconciler.scoreboard();
  assert.deepEqual([board.sold, board.oversold], [3, 1]);

  await shop.admin.query(
    `INSERT INTO stock_receipts (game_id, dedupe_key, qty, erp_applied_at, redis_applied_at) VALUES ($1, $2, 1, now(), now())`,
    [shop.gameId, `admin:${randomUUID()}`],
  );
  board = await reconciler.scoreboard();
  assert.deepEqual([board.stock, board.oversold], [3, 0]);
});

test('lost: a stored payment.succeeded event whose order is still waiting after the grace time', async () => {
  const pending = await order('payment_pending');
  await db.insertPaymentEvent(paymentEvent(`evt_${randomUUID()}`, pending));
  assert.equal((await reconciler.scoreboard()).lost, 0);
  await age(pending, 'received_at', 'payment_events');
  assert.equal((await reconciler.scoreboard()).lost, 1);
  await db.transition(pending, 'payment_pending', 'paid');
  assert.equal((await reconciler.scoreboard()).lost, 0);
});

test('paid but neither invoiced nor refunded: stuck in a pipeline state past the grace time, or failed', async () => {
  const stuck = await order('paid', { via: ['payment_pending'] });
  await order('failed', { via: ['payment_pending', 'paid'] });
  await order('refunded', { via: ['payment_pending', 'reservation_expired', 'refund_pending'] });
  assert.equal((await reconciler.scoreboard()).paidNotInvoicedOrRefunded, 1); // failed counts at once, paid only after the grace
  await age(stuck, 'updated_at');
  assert.equal((await reconciler.scoreboard()).paidNotInvoicedOrRefunded, 2);
});

test('completed without a submitted Sales Invoice is flagged; with one it is not', async () => {
  const id = await order('completed', { via: ['payment_pending', 'paid', 'so_submitted', 'invoiced'] });
  assert.equal((await reconciler.scoreboard()).completedWithoutInvoice, 1);
  await shop.admin.query(`INSERT INTO erp_documents (order_id, doctype, name, docstatus) VALUES ($1, 'Sales Invoice', 'SINV-1', 0)`, [id]);
  assert.equal((await reconciler.scoreboard()).completedWithoutInvoice, 1); // a draft has no ledger effect
  await shop.admin.query(`UPDATE erp_documents SET docstatus = 1 WHERE order_id = $1`, [id]);
  assert.equal((await reconciler.scoreboard()).completedWithoutInvoice, 0);
});

test('duplicates blocked are counted from the table', async () => {
  const id = await order('payment_pending');
  await db.recordDuplicate(id, 'webhook');
  await db.recordDuplicate(id, 'buy');
  assert.equal((await reconciler.scoreboard()).duplicatesBlocked, 2);
});

test('Redis copy check: stock + holds = starting stock; a mismatch is reported; a receipt in progress is skipped', async () => {
  await redis.buy(shopPool(shop.gameId), randomUUID());
  assert.deepEqual((await reconciler.scoreboard()).stockMismatches, []);
  await redis.initShopStock([]);
  await shop.admin.query(`UPDATE games SET stock_total = 3 WHERE id = $1`, [shop.gameId]);
  assert.deepEqual((await reconciler.scoreboard()).stockMismatches, [shop.gameId]);
  await shop.admin.query(
    `INSERT INTO stock_receipts (game_id, dedupe_key, qty, erp_applied_at) VALUES ($1, $2, 1, now())`, [shop.gameId, `admin:${randomUUID()}`],
  );
  assert.deepEqual((await reconciler.scoreboard()).stockMismatches, []);
});

test('run summary: only the run orders, counts by state, oversold against the run stock', async () => {
  await order('paid', { inRun: true, via: ['payment_pending'] });
  await order('paid', { inRun: true, via: ['payment_pending'] });
  await order('paid', { inRun: true, via: ['payment_pending'] });
  await order('refunded', { inRun: true, via: ['payment_pending', 'reservation_expired', 'refund_pending'] });
  await order('paid', { via: ['payment_pending'] }); // a shop order: not part of the run

  const run = await db.getRun(runId);
  const summary = await reconciler.runSummary(run);
  assert.deepEqual(
    { sold: summary.sold, oversold: summary.oversold, refunded: summary.refunded, stockTotal: summary.stockTotal, mismatch: summary.stockMismatch },
    { sold: 3, oversold: 1, refunded: 1, stockTotal: 2, mismatch: false },
  );
  await redis.buy(runPool(runId), randomUUID());
  assert.equal((await reconciler.runSummary(run)).stockMismatch, false); // the copy moved from stock to holds
});

test('run summary: invoiced counts orders with a submitted invoice, invoiced and completed alike', async () => {
  const toInvoiced = ['payment_pending', 'paid', 'so_submitted'];
  await order('invoiced', { inRun: true, via: toInvoiced });
  await order('completed', { inRun: true, via: [...toInvoiced, 'invoiced'] });
  await order('paid', { inRun: true, via: ['payment_pending'] });
  assert.equal((await reconciler.runSummary(await db.getRun(runId))).invoiced, 2);
});

test('run(): stores the latest scoreboard in Redis and returns only the violation counts', async () => {
  const result = await reconciler.run();
  assert.deepEqual(result, {
    oversold: 0, lost: 0, paidNotInvoicedOrRefunded: 0, completedWithoutInvoice: 0, stockMismatches: 0, leakedHolds: 0,
  });
  const saved = await redis.loadScoreboard();
  assert.equal(saved.stock, 2);
  assert.deepEqual(saved.stockMismatches, []);
  assert.deepEqual(saved.leakedHolds, []);
});

test('leaked hold: an order that cannot hold a copy is reported on the second pass it is found, not the first', async () => {
  const expired = await order('reservation_expired', { via: ['payment_pending'] });
  const refunded = await order('refunded', { via: ['payment_pending', 'reservation_expired', 'refund_pending'] });
  const unsaved = randomUUID(); // the process died after the Redis step, before the order was saved
  await redis.deletePool(shopPool(shop.gameId));
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 10 }]); // enough copies for every hold below
  for (const id of [expired, refunded, unsaved]) await redis.buy(shopPool(shop.gameId), id);

  assert.equal((await reconciler.run()).leakedHolds, 0);
  assert.equal((await reconciler.run()).leakedHolds, 3);
  assert.deepEqual((await redis.loadScoreboard()).leakedHolds.sort(), [expired, refunded, unsaved].sort());
});

test('leaked hold: holds of orders that may keep a copy are never reported, and a released one drops out', async () => {
  const live = [];
  for (const [state, via] of [['reserved', []], ['payment_pending', []], ['paid', ['payment_pending']], ['completed', ['payment_pending', 'paid', 'so_submitted', 'invoiced']]]) {
    live.push(await order(state, { via }));
  }
  const failed = await order('failed', { via: ['payment_pending', 'paid'] });
  const leaked = await order('reservation_expired', { via: ['payment_pending'] });
  await redis.deletePool(shopPool(shop.gameId));
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 10 }]);
  for (const id of [...live, failed, leaked]) await redis.buy(shopPool(shop.gameId), id);

  await reconciler.run();
  assert.deepEqual((await redis.loadScoreboard()).leakedHolds, []);
  await reconciler.run();
  assert.deepEqual((await redis.loadScoreboard()).leakedHolds, [leaked]);

  await redis.release(shopPool(shop.gameId), leaked);
  await reconciler.run();
  assert.deepEqual((await redis.loadScoreboard()).leakedHolds, []);
});
