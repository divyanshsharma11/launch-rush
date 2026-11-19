// Release, promotion and the expiry sweeper against the real PostgreSQL and Redis containers.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { captureLogger, createTestShop } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: config.redis, logger });
const gate = createStockGate({ db, redis, config: config.stock, logger });
let shop;
let pool;

// Buys through the real Lua script and saves the order with the state it returned, as Buy does.
async function buy({ holdMs = 300_000, waitMs = 600_000 } = {}) {
  const id = randomUUID();
  const { result } = await redis.buy(pool, id);
  return db.insertOrder({ id, sessionId: await shop.newSession(), gameId: shop.gameId, state: result, holdMs, waitMs });
}

const stateOf = async (order) => (await db.getOrder(order.id)).state;
const sweepAll = () => gate.sweep(10_000);

before(async () => {
  await redis.ready();
});

beforeEach(async () => {
  if (shop) {
    await redis.deletePool(pool);
    await shop.remove();
  }
  shop = await createTestShop({ stockTotal: 1 });
  pool = shopPool(shop.gameId);
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 1 }]);
});

after(async () => {
  await redis.deletePool(pool);
  await shop.remove();
  await redis.close();
  await db.close();
});

test('an expired hold passes the copy to the earliest waiter, who gets a new hold', async () => {
  const a = await buy({ holdMs: -1000 });
  const b = await buy();
  const c = await buy();
  assert.deepEqual([a.state, b.state, c.state], ['reserved', 'waitlisted', 'waitlisted']);

  const counts = await sweepAll();
  assert.ok(counts.expired >= 1);
  assert.equal(await stateOf(a), 'reservation_expired');
  const promoted = await db.getOrder(b.id);
  assert.equal(promoted.state, 'reserved');
  assert.ok(Math.abs(promoted.reservedUntil - Date.now() - config.stock.shopHoldMs) < 2000);
  assert.equal(await redis.waitlistPosition(pool, c.id), 1);
});

test('an expired hold with nobody waiting goes back to stock', async () => {
  const a = await buy({ holdMs: -1000 });
  await sweepAll();
  assert.equal(await stateOf(a), 'reservation_expired');
  assert.deepEqual(await redis.stockLeft([pool]), [1]);
});

test('a wait that ends removes the order from the waitlist', async () => {
  await buy();
  const b = await buy({ waitMs: -1000 });
  const c = await buy();
  await sweepAll();
  assert.equal(await stateOf(b), 'waitlist_ended');
  assert.equal(await redis.waitlistPosition(pool, b.id), null);
  assert.equal(await redis.waitlistPosition(pool, c.id), 1);
});

test('a waiter that cannot be promoted (wait already ended) passes the copy on', async () => {
  const a = await buy({ holdMs: -1000 });
  const b = await buy();
  const c = await buy();
  await db.transition(b.id, 'waitlisted', 'waitlist_ended'); // ended in PostgreSQL, still in the Redis waitlist
  await sweepAll();
  assert.equal(await stateOf(a), 'reservation_expired');
  assert.equal(await stateOf(b), 'waitlist_ended');
  assert.equal(await stateOf(c), 'reserved');
});

test('a waiter that was never saved is skipped and the copy goes back to stock', async () => {
  const a = await buy({ holdMs: -1000 });
  await redis.buy(pool, randomUUID()); // waitlisted in Redis only (the insert "failed")
  await sweepAll();
  assert.equal(await stateOf(a), 'reservation_expired');
  assert.deepEqual(await redis.stockLeft([pool]), [1]);
});

test('two sweeps at once: the copy is returned once', async () => {
  await buy({ holdMs: -1000 });
  const results = await Promise.all([sweepAll(), sweepAll()]);
  assert.equal(results[0].expired + results[1].expired, 1);
  assert.deepEqual(await redis.stockLeft([pool]), [1]);
});

test('a payment_pending hold expires too', async () => {
  const a = await buy({ holdMs: -1000 });
  await db.transition(a.id, 'reserved', 'payment_pending');
  await sweepAll();
  assert.equal(await stateOf(a), 'reservation_expired');
});
