// Buy and Release Lua scripts against the real Redis container, on unique test pools.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createRedis, runPool, shopPool } from '../src/services/redis/index.js';
import { captureLogger } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const redis = createRedis({ redis: config.redis, logger: captureLogger().logger });
const inspect = new Redis(config.redis);
const pools = [];

async function newPool(stock) {
  const pool = runPool(`test-${randomUUID()}`);
  pools.push(pool);
  await redis.ready();
  await inspect.set(`stock:${pool}`, stock);
  return pool;
}

const ids = (n) => Array.from({ length: n }, () => randomUUID());

after(async () => {
  for (const pool of pools) await redis.deletePool(pool);
  await redis.close();
  await inspect.quit();
});

test('buy: copies go first come first served, then the waitlist with positions', async () => {
  const pool = await newPool(2);
  const [a, b, c, d] = ids(4);
  assert.deepEqual(await redis.buy(pool, a), { result: 'reserved', buyerNumber: 1 });
  assert.deepEqual(await redis.buy(pool, b), { result: 'reserved', buyerNumber: 2 });
  assert.deepEqual(await redis.buy(pool, c), { result: 'waitlisted', position: 1 });
  assert.deepEqual(await redis.buy(pool, d), { result: 'waitlisted', position: 2 });
  assert.deepEqual(await redis.stockLeft([pool]), [0]);
  assert.equal(await redis.waitlistPosition(pool, d), 2);
  assert.equal(await redis.waitlistPosition(pool, a), null);
});

test('buy again for the same order: same reservation or place, nothing taken twice', async () => {
  const pool = await newPool(1);
  const [a, b] = ids(2);
  await redis.buy(pool, a);
  await redis.buy(pool, b);
  assert.deepEqual(await redis.buy(pool, a), { result: 'reserved', buyerNumber: 1 });
  assert.deepEqual(await redis.buy(pool, b), { result: 'waitlisted', position: 1 });
  assert.equal(await inspect.zcard(`waitlist:${pool}`), 1);
});

test('release: the copy goes to the earliest waiter, then back to stock', async () => {
  const pool = await newPool(1);
  const [a, b, c] = ids(3);
  await redis.buy(pool, a);
  await redis.buy(pool, b);
  await redis.buy(pool, c);
  assert.deepEqual(await redis.release(pool, a), { result: 'handed', orderId: b });
  assert.equal(await redis.waitlistPosition(pool, c), 1);
  assert.deepEqual(await redis.release(pool, b), { result: 'handed', orderId: c });
  assert.deepEqual(await redis.release(pool, c), { result: 'returned' });
  assert.deepEqual(await redis.stockLeft([pool]), [1]);
});

test('release of a waiter removes it; a second release of the same order passes nothing on', async () => {
  const pool = await newPool(1);
  const [a, b, c] = ids(3);
  await redis.buy(pool, a);
  await redis.buy(pool, b);
  await redis.buy(pool, c);
  assert.deepEqual(await redis.release(pool, b), { result: 'none' });
  assert.equal(await redis.waitlistPosition(pool, c), 1);
  assert.deepEqual(await redis.release(pool, a), { result: 'handed', orderId: c });
  assert.deepEqual(await redis.release(pool, a), { result: 'none' });
  assert.deepEqual(await redis.stockLeft([pool]), [0]);
});

test('a newcomer cannot take a returned copy while others wait', async () => {
  const pool = await newPool(1);
  const [a, b, c] = ids(3);
  await redis.buy(pool, a);
  await redis.buy(pool, b);
  await inspect.incr(`stock:${pool}`); // a copy in stock while b still waits
  assert.deepEqual(await redis.buy(pool, c), { result: 'waitlisted', position: 2 });
});

test('run buyers: a second order of the same buyer is refused until the first gives its place up', async () => {
  const pool = await newPool(1);
  const [a, a2, b] = ids(3);
  assert.equal((await redis.buy(pool, a, { buyerRef: 'sim-1' })).result, 'reserved');
  assert.deepEqual(await redis.buy(pool, a2, { buyerRef: 'sim-1' }), { result: 'already', orderId: a });
  assert.equal((await redis.buy(pool, b, { buyerRef: 'sim-2' })).result, 'waitlisted');
  assert.deepEqual(await redis.buy(pool, b, { buyerRef: 'sim-2' }), { result: 'waitlisted', position: 1 });

  await redis.release(pool, a, { buyerRef: 'sim-1' });
  assert.equal((await redis.buy(pool, a2, { buyerRef: 'sim-1' })).result, 'waitlisted');
  assert.equal(await inspect.hget(`buyers:${pool}`, 'sim-2'), b); // promoted waiter still owns its place
});

test('re-reserve (no waitlist join): a copy only when stock is free and nobody waits; retry takes no second copy', async () => {
  const pool = await newPool(1);
  const [a, b, late] = ids(3);
  await redis.buy(pool, a);
  assert.deepEqual(await redis.buy(pool, late, { buyerRef: 'sim-9', joinWaitlist: false }), { result: 'none' });
  assert.equal(await inspect.hget(`buyers:${pool}`, 'sim-9'), null);

  await redis.buy(pool, b);
  await inspect.incr(`stock:${pool}`);
  assert.deepEqual(await redis.buy(pool, late, { joinWaitlist: false }), { result: 'none' }); // b waits first

  await redis.release(pool, b);
  assert.deepEqual(await redis.buy(pool, late, { joinWaitlist: false }), { result: 'reserved', buyerNumber: 2 });
  assert.deepEqual(await redis.buy(pool, late, { joinWaitlist: false }), { result: 'reserved', buyerNumber: 2 });
  assert.deepEqual(await redis.stockLeft([pool]), [0]);
});

test('50 buyers at once on 5 copies: exactly 5 reserved, 45 waiting with distinct positions', async () => {
  const pool = await newPool(5);
  const results = await Promise.all(ids(50).map((id) => redis.buy(pool, id)));
  const reserved = results.filter((r) => r.result === 'reserved');
  const positions = results.filter((r) => r.result === 'waitlisted').map((r) => r.position);
  assert.deepEqual(reserved.map((r) => r.buyerNumber).sort((x, y) => x - y), [1, 2, 3, 4, 5]);
  assert.deepEqual(positions.sort((x, y) => x - y), Array.from({ length: 45 }, (_, i) => i + 1));
  assert.deepEqual(await redis.stockLeft([pool]), [0]);
  assert.equal(await inspect.hlen(`holds:${pool}`), 5);
});

test('initShopStock sets a missing counter and never overwrites an existing one', async () => {
  const gameId = `test-${randomUUID()}`;
  const pool = shopPool(gameId);
  pools.push(pool);
  await redis.ready();
  await redis.initShopStock([{ id: gameId, stockTotal: 3 }]);
  await redis.buy(pool, randomUUID());
  await redis.initShopStock([{ id: gameId, stockTotal: 3 }]);
  assert.deepEqual(await redis.stockLeft([pool, runPool(`missing-${randomUUID()}`)]), [2, 0]);
});
