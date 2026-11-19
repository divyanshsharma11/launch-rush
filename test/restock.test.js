// Shop restock (design §1.2) and the admin refill, with the real PostgreSQL, Redis and ERP simulator.
// The restock sees only the test game: the catalog games' stock is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, shopPool } from '../src/services/redis/index.js';
import { createErpConnector } from '../src/services/connectors/erp-sim.js';
import { createStockGate } from '../src/business/waitlist-stock.js';
import { createOrders } from '../src/business/orders.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createRestock } from '../src/business/restock.js';
import { BusinessError } from '../src/business/errors.js';
import { addErpItem, captureLogger, createTestShop, erpShopQty, removeErpItem } from './helpers.js';

const base = loadConfig(process.env);
const simConfig = { ...loadErpSimConfig(process.env), port: 0 };
const { logger, lines } = captureLogger();
const db = createDb({ logger });
const redis = createRedis({ redis: base.redis, logger });
const raw = new Redis(base.redis);
let shop;
let sim;
let erp;
let pool;
let orders;
let stockGate;
let restock;
let game;
let clock = Date.UTC(2026, 10, 14, 10, 0, 0);

const onlyTestGame = {
  ...db,
  listShopGames: async () => (await db.listShopGames()).filter((g) => g.id === shop.gameId),
  pendingReceipts: async (limit) => (await db.pendingReceipts(limit)).filter((r) => r.gameId === shop.gameId),
};
const WINDOW = base.restock.windowMs;

before(async () => {
  await redis.ready();
  shop = await createTestShop({ stockTotal: 3 });
  await addErpItem(shop.admin, shop.gameId, 3);
  pool = shopPool(shop.gameId);
  sim = await startErpSimulator({ config: simConfig, logger: captureLogger().logger });
  erp = createErpConnector({ baseUrl: `http://127.0.0.1:${sim.port}`, apiKey: simConfig.apiKey, apiSecret: simConfig.apiSecret });
  stockGate = createStockGate({ db, redis, config: base.stock, logger });
  orders = createOrders({ db, redis, stockGate, payment: { execute: async () => ({}) }, config: base, logger });
  restock = createRestock({ db: onlyTestGame, redis, erp, stockGate, config: base, logger, now: () => clock });
  game = await db.getGame(shop.gameId);
});

after(async () => {
  await raw.del(...['stock', 'holds', 'waitlist', 'tickets', 'grants', 'buyers', 'receipts'].map((kind) => `${kind}:${pool}`));
  await removeErpItem(shop.admin, shop.gameId);
  await shop.remove();
  await sim.shutdown();
  await redis.close();
  await raw.quit();
  await db.close();
});

// Each test starts from an empty pool: no stock, holds or waiters; the ERP quantity set to `erpQty`.
async function resetPool({ stock = 0, erpQty = 3 } = {}) {
  await shop.admin.query('DELETE FROM orders WHERE game_id = $1', [shop.gameId]);
  await shop.admin.query('DELETE FROM stock_receipts WHERE game_id = $1', [shop.gameId]);
  await shop.admin.query('DELETE FROM erpsim.stock_additions WHERE item_code = $1', [shop.gameId]);
  await shop.admin.query(`UPDATE erpsim.item_stock SET available = $2 WHERE scope = 'shop' AND item_code = $1`, [shop.gameId, erpQty]);
  await raw.del(...['stock', 'holds', 'waitlist', 'tickets', 'grants', 'buyers', 'receipts'].map((kind) => `${kind}:${pool}`));
  await raw.set(`stock:${pool}`, stock);
}

const gate = async () => ({
  stock: Number(await raw.get(`stock:${pool}`)),
  holds: await raw.hlen(`holds:${pool}`),
  waiting: await raw.zcard(`waitlist:${pool}`),
  erp: await erpShopQty(shop.admin, shop.gameId),
});
const receipts = async () => (await shop.admin.query(
  `SELECT dedupe_key, qty, erp_applied_at IS NOT NULL AS erp_done, redis_applied_at IS NOT NULL AS redis_done
   FROM stock_receipts WHERE game_id = $1 ORDER BY created_at`, [shop.gameId],
)).rows;
const buy = async () => (await orders.reserve({ game, sessionId: await shop.newSession() })).order;
const stateOf = async (id) => (await db.getOrder(id)).state;

test('a sold-out game is restocked once per window: receipt recorded, ERP and Redis both get the copies, receipt marked done', async () => {
  await resetPool({ stock: 0, erpQty: 3 });
  const result = await restock.tick();
  assert.deepEqual(result, { restocked: 1, finished: 0 });

  const windowStart = Math.floor(clock / WINDOW) * WINDOW;
  assert.deepEqual(await receipts(), [{ dedupe_key: `timer:${shop.gameId}:${windowStart}`, qty: 3, erp_done: true, redis_done: true }]);
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 6 });

  await raw.set(`stock:${pool}`, 0); // sold out again in the same window: no second restock
  assert.deepEqual(await restock.tick(), { restocked: 0, finished: 0 });
  assert.equal((await receipts()).length, 1);

  clock += WINDOW; // the next window
  assert.deepEqual(await restock.tick(), { restocked: 1, finished: 0 });
  assert.equal((await receipts()).length, 2);
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 9 });
});

test('a game with stock left is not restocked', async () => {
  await resetPool({ stock: 1, erpQty: 3 });
  clock += WINDOW;
  assert.deepEqual(await restock.tick(), { restocked: 0, finished: 0 });
  assert.deepEqual(await receipts(), []);
  assert.deepEqual(await gate(), { stock: 1, holds: 0, waiting: 0, erp: 3 });
});

test('waiters are served first, in order: they are promoted to reserved and the rest goes to stock', async () => {
  await resetPool({ stock: 3, erpQty: 3 });
  const holders = [await buy(), await buy(), await buy()];
  const first = await buy();
  const second = await buy();
  assert.deepEqual([...holders, first, second].map((o) => o.state), ['reserved', 'reserved', 'reserved', 'waitlisted', 'waitlisted']);

  clock += WINDOW;
  assert.deepEqual(await restock.tick(), { restocked: 1, finished: 0 });
  assert.deepEqual(await gate(), { stock: 1, holds: 5, waiting: 0, erp: 6 });
  assert.equal(await stateOf(first.id), 'reserved');
  assert.equal(await stateOf(second.id), 'reserved');
  const promoted = await db.getOrder(first.id);
  assert.ok(promoted.reservedUntil > new Date(), 'a new hold time');
  assert.ok(lines.some((line) => line.msg === 'waiter promoted' && line.orderId === first.id));

  const scoreboard = await createReconciler({ db, redis, config: base.reconciler }).scoreboard();
  assert.ok(!scoreboard.stockMismatches.includes(shop.gameId), 'stock + holds = starting stock + receipts');
});

test('fewer copies than waiters (Lua): the earliest waiters get them, the others keep waiting, nothing goes to stock', async () => {
  await resetPool({ stock: 0 });
  const [a, b, c] = [await buy(), await buy(), await buy()];
  assert.deepEqual([a.state, b.state, c.state], ['waitlisted', 'waitlisted', 'waitlisted']);
  assert.deepEqual(await redis.applyReceipt(pool, 'r-1', 2), [a.id, b.id]);
  assert.deepEqual(await gate(), { stock: 0, holds: 2, waiting: 1, erp: 3 });
  assert.deepEqual(await redis.applyReceipt(pool, 'r-1', 2), [], 'the same receipt id adds nothing');
  assert.deepEqual(await gate(), { stock: 0, holds: 2, waiting: 1, erp: 3 });
});

test('a waiter whose wait ended at the same moment is skipped: Release hands the copy to the next waiter', async () => {
  await resetPool({ stock: 3, erpQty: 3 });
  for (let i = 0; i < 3; i += 1) await buy();
  const gone = await buy();
  const w2 = await buy();
  const w3 = await buy();
  const w4 = await buy();
  assert.ok(await db.transition(gone.id, 'waitlisted', 'waitlist_ended')); // still in the Redis waitlist

  clock += WINDOW;
  await restock.tick();
  assert.equal(await stateOf(gone.id), 'waitlist_ended');
  for (const waiter of [w2, w3, w4]) assert.equal(await stateOf(waiter.id), 'reserved');
  assert.deepEqual(await gate(), { stock: 0, holds: 6, waiting: 0, erp: 6 });
  assert.equal(await raw.hexists(`holds:${pool}`, gone.id), 0, 'the ended waiter holds no copy');
});

test('crash safety: ERP unreachable leaves the receipt unfinished; the next pass finishes it, nothing is added twice', async () => {
  await resetPool({ stock: 0, erpQty: 3 });
  const unreachable = { ...erp, execute: async () => { throw new Error('ERP unreachable'); } };
  const broken = createRestock({ db: onlyTestGame, redis, erp: unreachable, stockGate, config: base, logger, now: () => clock });
  clock += WINDOW;
  assert.deepEqual(await broken.tick(), { restocked: 0, finished: 0 });
  assert.deepEqual(await receipts(), [{ dedupe_key: `timer:${shop.gameId}:${Math.floor(clock / WINDOW) * WINDOW}`, qty: 3, erp_done: false, redis_done: false }]);
  assert.deepEqual(await gate(), { stock: 0, holds: 0, waiting: 0, erp: 3 }, 'Redis got nothing before the ERP');

  assert.deepEqual(await restock.tick(), { restocked: 0, finished: 1 });
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 6 });
  assert.deepEqual((await receipts()).map((r) => [r.erp_done, r.redis_done]), [[true, true]]);
  assert.deepEqual(await restock.tick(), { restocked: 0, finished: 0 });
});

test('a long ERP outage: no second receipt in the next window, and the stock is added once when the ERP is back', async () => {
  await resetPool({ stock: 0, erpQty: 3 });
  const unreachable = { ...erp, execute: async () => { throw new Error('ERP unreachable'); } };
  const broken = createRestock({ db: onlyTestGame, redis, erp: unreachable, stockGate, config: base, logger, now: () => clock });
  clock += WINDOW;
  await broken.tick();
  clock += WINDOW;
  assert.deepEqual(await broken.tick(), { restocked: 0, finished: 0 });
  assert.equal((await receipts()).length, 1);

  assert.deepEqual(await restock.tick(), { restocked: 0, finished: 1 });
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 6 });
});

test('crash safety: after the ERP and Redis steps but before the receipt is marked, the next pass adds nothing again', async () => {
  await resetPool({ stock: 0, erpQty: 3 });
  const windowStart = Math.floor((clock += WINDOW) / WINDOW) * WINDOW;
  const id = await db.insertReceipt({ gameId: shop.gameId, dedupeKey: `timer:${shop.gameId}:${windowStart}`, qty: 3 });
  await erp.execute('stock.add', { receiptId: id, itemCode: shop.gameId, qty: 3 }, { timeoutMs: 5000 });
  await redis.applyReceipt(pool, id, 3);
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 6 });

  assert.deepEqual(await restock.tick(), { restocked: 0, finished: 1 });
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 6 });
  assert.deepEqual((await receipts()).map((r) => [r.erp_done, r.redis_done]), [[true, true]]);
});

test('two passes at once restock a sold-out game once', async () => {
  await resetPool({ stock: 0, erpQty: 3 });
  clock += WINDOW;
  const other = createRestock({ db: onlyTestGame, redis, erp, stockGate, config: base, logger, now: () => clock });
  const results = await Promise.all([restock.tick(), other.tick()]);
  assert.equal(results.reduce((sum, r) => sum + r.restocked, 0), 1);
  assert.equal((await receipts()).length, 1);
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 6 });
});

test('admin refill: up to the starting level from the stock right now; nothing when already at or above it', async () => {
  await resetPool({ stock: 1, erpQty: 3 });
  assert.deepEqual(await restock.refill(shop.gameId), [{ gameId: shop.gameId, qty: 2 }]);
  assert.deepEqual(await gate(), { stock: 3, holds: 0, waiting: 0, erp: 5 });
  const [receipt] = await receipts();
  assert.match(receipt.dedupe_key, /^admin:[0-9a-f-]{36}$/);
  assert.equal(receipt.qty, 2);

  assert.deepEqual(await restock.refill(shop.gameId), []);
  await raw.set(`stock:${pool}`, 5); // above the starting level (a double refill can do that)
  assert.deepEqual(await restock.refill(shop.gameId), []);
  assert.equal((await receipts()).length, 1);

  await raw.set(`stock:${pool}`, 0);
  assert.deepEqual(await restock.refill(), [{ gameId: shop.gameId, qty: 3 }], 'no game id: every shop game (here the test game only)');
});

test('admin refill serves waiters first, cancels no order, and rejects an unknown or malformed game', async () => {
  await resetPool({ stock: 1, erpQty: 3 });
  const holder = await buy();
  const waiter = await buy();
  assert.equal(waiter.state, 'waitlisted');
  await restock.refill(shop.gameId);
  assert.equal(await stateOf(waiter.id), 'reserved');
  assert.equal(await stateOf(holder.id), 'reserved');

  for (const bad of ['no-such-game', 5, {}]) {
    await assert.rejects(restock.refill(bad), (err) => err instanceof BusinessError && err.code === 'invalid_input');
  }
});

test('a game with stock_total 0 is never restocked', async () => {
  await resetPool({ stock: 0 });
  const zero = createRestock({
    db: { ...onlyTestGame, listShopGames: async () => [{ ...game, stockTotal: 0 }] },
    redis, erp, stockGate, config: base, logger, now: () => clock,
  });
  clock += WINDOW;
  assert.deepEqual(await zero.tick(), { restocked: 0, finished: 0 });
  assert.deepEqual(await receipts(), []);
});

test('with the default clock, a game that still has stock is left alone', async () => {
  const real = createRestock({ db: onlyTestGame, redis, erp, stockGate, config: base, logger });
  await resetPool({ stock: 2, erpQty: 3 });
  assert.deepEqual(await real.tick(), { restocked: 0, finished: 0 });
});
