// What a stream sends for a session (design §8), against real PostgreSQL and Redis. State changes are made through the
// repository, so the wake-ups are the real ones (db hook -> Redis Pub/Sub -> stream).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/services/db/index.js';
import { createRedis, runPool, shopPool } from '../src/services/redis/index.js';
import { createWakeups } from '../src/services/redis/wakeups.js';
import { createReconciler } from '../src/business/reconciler.js';
import { createStream } from '../src/business/stream.js';
import { captureLogger, completedOrder, createTestShop } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const { logger, lines } = captureLogger();
const redis = createRedis({ redis: config.redis, logger });
const db = createDb({ logger, onOrderChange: (orderId, sessionId) => redis.notifyOrder(orderId, sessionId) });
const wakeups = createWakeups({ redis: config.redis, logger });
const raw = new Redis(config.redis);
const reconciler = createReconciler({ db, redis, config: config.reconciler });
// Only wake-ups drive the reads unless a test sets tickMs: the timer is far away.
const quiet = { ...config.stream, tickMs: 60_000, progressMs: 40, settleMs: 400 };
let shop;
let stream;
const closers = [];

before(async () => {
  await redis.ready();
  await wakeups.ready();
  shop = await createTestShop({ stockTotal: 3 });
  await redis.initShopStock([{ id: shop.gameId, stockTotal: 3 }]);
  stream = createStream({ db, redis, wakeups, reconciler, config: quiet, logger });
});

after(async () => {
  closers.forEach((close) => close());
  await raw.del('scoreboard:latest', 'breakers');
  await redis.deletePool(shopPool(shop.gameId));
  await shop.remove();
  await wakeups.close();
  await redis.close();
  await raw.quit();
  await db.close();
});

// Opens a stream for the session; the events it sends are collected.
function follow(sessionId, { streamOf = stream } = {}) {
  const events = [];
  const close = streamOf.open(sessionId, (event, data) => events.push({ event, data: JSON.parse(JSON.stringify(data)) }));
  closers.push(close);
  return {
    events,
    close,
    of: (name) => events.filter((e) => e.event === name).map((e) => e.data),
    async until(check, what) {
      for (const stop = Date.now() + 5000; Date.now() < stop; await new Promise((r) => setTimeout(r, 15))) {
        if (check(events)) return;
      }
      assert.fail(`not reached in time: ${what}; got ${JSON.stringify(events.map((e) => e.event))}`);
    },
  };
}

const newOrder = async (sessionId, gameId = shop.gameId) =>
  (await db.insertOrder({ id: randomUUID(), sessionId, gameId, state: 'reserved', holdMs: 300_000 })).id;
const states = (orderId) => (view) => view.of('order.state').filter((e) => e.orderId === orderId).map((e) => e.to);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a new connection gets each order\'s current state, its email status and the stock; not the history', async () => {
  const session = await shop.newSession();
  const id = await newOrder(session);
  await db.transition(id, 'reserved', 'payment_pending');
  await redis.buy(shopPool(shop.gameId), randomUUID()); // stock 3 -> 2

  const view = follow(session);
  await view.until((e) => e.some((x) => x.event === 'stock' && x.data.gameId === shop.gameId), 'stock');
  await view.until((e) => e.some((x) => x.event === 'email.status'), 'email.status');
  assert.deepEqual(view.of('order.state'), [
    { orderId: id, from: 'reserved', to: 'payment_pending', at: view.of('order.state')[0].at },
  ]);
  assert.deepEqual(view.of('email.status'), [{ orderId: id, emailStatus: 'none' }]);
  assert.deepEqual(view.of('stock').filter((s) => s.gameId === shop.gameId), [{ gameId: shop.gameId, stockLeft: 2 }]);
  view.close();
});

test('a later change arrives through the wake-up, once and in order; a new order through its session', async () => {
  const session = await shop.newSession();
  const view = follow(session);
  await wait(100); // the first read is done: nothing to send yet
  const id = await newOrder(session);
  await view.until(() => states(id)(view).length === 1, 'creation');
  assert.deepEqual(view.of('order.state')[0], { orderId: id, from: null, to: 'reserved', at: view.of('order.state')[0].at });

  await db.transition(id, 'reserved', 'payment_pending');
  await db.transition(id, 'payment_pending', 'paid');
  await view.until((e) => e.filter((x) => x.event === 'order.state').length === 3, 'two transitions');
  assert.deepEqual(states(id)(view), ['reserved', 'payment_pending', 'paid']);
  await wait(150);
  assert.equal(view.of('order.state').length, 3); // no repeat
  view.close();
});

test('without any wake-up the stream\'s own timer still delivers the change', async () => {
  const session = await shop.newSession();
  const deaf = { onOrder: () => () => {} };
  const slow = createStream({ db, redis, wakeups: deaf, reconciler, config: { ...quiet, tickMs: 60 }, logger });
  const id = await newOrder(session);
  const view = follow(session, { streamOf: slow });
  await view.until(() => view.of('order.state').length === 1, 'first state');
  await db.transition(id, 'reserved', 'payment_pending');
  await view.until(() => view.of('order.state').length === 2, 'timer read');
  view.close();
});

test('another session\'s orders are never sent', async () => {
  const mine = await shop.newSession();
  const view = follow(mine);
  await wait(100);
  const other = await newOrder(await shop.newSession());
  await db.transition(other, 'reserved', 'payment_pending');
  await wait(300);
  assert.deepEqual(view.of('order.state'), []);
  view.close();
});

test('email.status follows the delivery row; delivery.retrying says a step failed and will be tried again', async () => {
  const session = await shop.newSession();
  const id = await newOrder(session);
  const view = follow(session);
  await view.until(() => view.of('email.status').length === 1, 'first email.status');

  const step = { orderId: id, connector: 'erp-sim', action: 'sales_order.submit' };
  await db.startDelivery(step);
  await db.updateDelivery({ ...step, status: 'pending', error: 'HTTP 503', failure: { kind: 'retryable' } });
  await view.until(() => view.of('delivery.retrying').length === 1, 'retrying');
  assert.deepEqual(view.of('delivery.retrying')[0], {
    orderId: id, connector: 'erp-sim', action: 'sales_order.submit', attempt: 1, errorClass: 'retryable', nextRetryAt: null,
  });

  await db.startDelivery(step); // attempt 2 is running: not "retrying"
  await db.updateDelivery({ ...step, status: 'pending', error: 'HTTP 429', failure: { kind: 'rateLimited', retryAfterMs: 4000 } });
  await view.until(() => view.of('delivery.retrying').length === 2, 'second retrying');
  assert.deepEqual([view.of('delivery.retrying')[1].attempt, view.of('delivery.retrying')[1].errorClass], [2, 'rateLimited']);
  assert.ok(view.of('delivery.retrying')[1].nextRetryAt);

  await shop.admin.query(`UPDATE orders SET buyer_email = 'a@example.com' WHERE id = $1`, [id]);
  await db.failDelivery({ orderId: id, connector: 'email-gmail', action: 'email.send', error: 'boom' });
  await view.until(() => view.of('email.status').length === 2, 'failed email');
  assert.equal(view.of('email.status')[1].emailStatus, 'failed');
  view.close();
});

test('waitlist.position is sent when it changes', async () => {
  const pool = shopPool(shop.gameId);
  const holders = [];
  for (let i = 0; i < 2; i += 1) { // stock is 3 at the start of the file; take what is left so the next buyer waits
    const orderId = randomUUID();
    if ((await redis.buy(pool, orderId, { joinWaitlist: false })).result === 'reserved') holders.push(orderId);
  }
  const session = await shop.newSession();
  const id = randomUUID();
  const result = await redis.buy(pool, id);
  await db.insertOrder({ id, sessionId: session, gameId: shop.gameId, state: result.result, holdMs: 300_000, waitMs: 60_000 });
  const earlier = randomUUID();
  const ahead = await redis.buy(pool, earlier); // joins the waitlist behind id
  assert.equal(ahead.result, 'waitlisted');

  const view = follow(session);
  await view.until(() => view.of('waitlist.position').length === 1, 'position');
  assert.deepEqual(view.of('waitlist.position')[0], { orderId: id, waitlistPosition: 1 });
  await redis.release(pool, id); // leaves the waitlist: no position any more, nothing new is sent
  await db.transition(id, 'waitlisted', 'waitlist_ended');
  await view.until((e) => e.some((x) => x.event === 'order.state' && x.data.to === 'waitlist_ended'), 'ended');
  assert.equal(view.of('waitlist.position').length, 1);
  view.close();
  await redis.release(pool, earlier);
  for (const orderId of holders) await redis.release(pool, orderId);
});

test('the scoreboard is sent when the reconciler has a new result, not again for the same one', async () => {
  const session = await shop.newSession();
  const board = { sold: 1, stock: 3, oversold: 0, lost: 0, paidNotInvoicedOrRefunded: 0, duplicatesBlocked: 0, checkedAt: new Date().toISOString() };
  await redis.saveScoreboard(board);
  const view = follow(session);
  await view.until(() => view.of('scoreboard').length === 1, 'scoreboard');
  assert.deepEqual(view.of('scoreboard')[0], board);

  const shorter = createStream({ db, redis, wakeups, reconciler, config: { ...quiet, tickMs: 50 }, logger });
  const second = follow(session, { streamOf: shorter });
  await second.until(() => second.of('scoreboard').length === 1, 'scoreboard again');
  await wait(200);
  assert.equal(second.of('scoreboard').length, 1);
  await redis.saveScoreboard({ ...board, checkedAt: new Date(Date.now() + 1000).toISOString() });
  await second.until(() => second.of('scoreboard').length === 2, 'new result');
  view.close();
  second.close();
});

test('breaker.state: shared breakers and the session\'s own run only; a removed entry is closed', async () => {
  const session = await shop.newSession();
  const run = (await db.insertRun({ sessionId: session, gameId: shop.gameId, stockTotal: 1, buyersRequested: 1, faults: {}, durationMs: 60_000, maxRunning: 1000 })).run;
  await redis.initRunStock(run.id, 1);
  const other = randomUUID();
  await redis.clearBreakerStates();
  const view = follow(session, { streamOf: createStream({ db, redis, wakeups, reconciler, config: { ...quiet, tickMs: 50 }, logger }) });
  await wait(150);
  assert.deepEqual(view.of('breaker.state'), []); // nothing open

  await redis.setBreakerState({ connector: 'erp-sim', runId: null, state: 'open' });
  await redis.setBreakerState({ connector: 'erp-sim', runId: run.id, state: 'open' });
  await redis.setBreakerState({ connector: 'erp-sim', runId: other, state: 'open' }); // another visitor's run
  await view.until(() => view.of('breaker.state').length === 2, 'two breakers');
  assert.deepEqual(view.of('breaker.state').map((b) => [b.connector, b.runId, b.state]).sort(),
    [['erp-sim', null, 'open'], ['erp-sim', run.id, 'open']].sort());

  await redis.setBreakerState({ connector: 'erp-sim', runId: null, state: null });
  await view.until(() => view.of('breaker.state').length === 3, 'closed again');
  assert.deepEqual(view.of('breaker.state')[2], { connector: 'erp-sim', runId: null, state: 'closed' });
  view.close();
  await redis.clearBreakerStates();
  await redis.deleteRun(run.id);
});

test('run.progress while the run goes; after it ends progress goes on until the orders settle, then run.ended', async () => {
  const session = await shop.newSession();
  const run = (await db.insertRun({ sessionId: session, gameId: shop.gameId, stockTotal: 2, buyersRequested: 4, faults: {}, durationMs: 60_000, maxRunning: 1000 })).run;
  await redis.initRunStock(run.id, 2);
  const inRun = async () =>
    (await db.insertOrder({ id: randomUUID(), gameId: shop.gameId, state: 'reserved', holdMs: 300_000, runId: run.id, buyerRef: randomUUID(), isSimulated: true })).id;
  const paying = await inRun();
  await db.transition(paying, 'reserved', 'payment_pending');
  await db.transition(paying, 'payment_pending', 'paid');

  const view = follow(session);
  await view.until(() => view.of('run.progress').length >= 1, 'progress');
  const first = view.of('run.progress').at(-1);
  assert.deepEqual(
    [first.runId, first.paid, first.reserved, first.invoiced, first.inFlight, first.stockLeft, first.soldOut],
    [run.id, 1, 0, 0, 1, 2, false],
  );
  assert.deepEqual(Object.keys(first).sort(), [
    'duplicatesBlocked', 'expired', 'failed', 'inFlight', 'invoiced', 'paid', 'refunded', 'reserved', 'runId', 'soldOut',
    'stockLeft', 'waitlistEnded', 'waitlisted',
  ]);

  await db.transition(paying, 'paid', 'so_submitted');
  await view.until(() => view.of('run.progress').at(-1).inFlight === 1, 'still counted');
  await db.endRun(run.id, 'finished');
  await wait(150);
  assert.deepEqual(view.of('run.ended'), []); // the order is still being processed

  await db.transition(paying, 'so_submitted', 'invoiced');
  await db.transition(paying, 'invoiced', 'completed');
  await view.until(() => view.of('run.ended').length === 1, 'run.ended');
  const ended = view.of('run.ended')[0];
  assert.deepEqual([ended.runId, ended.status, ended.sold, ended.invoiced, ended.inFlight, ended.oversold, ended.lost], [run.id, 'finished', 1, 1, 0, 0, 0]);
  assert.deepEqual([ended.paid, ended.soldOut, ended.stockLeft], [1, false, 2]);
  await wait(150);
  assert.equal(view.of('run.ended').length, 1);
  view.close();
  await redis.deleteRun(run.id);
});

test('an order that never settles does not hold run.ended back for ever: settleMs', async () => {
  const session = await shop.newSession();
  const run = (await db.insertRun({ sessionId: session, gameId: shop.gameId, stockTotal: 1, buyersRequested: 1, faults: {}, durationMs: 60_000, maxRunning: 1000 })).run;
  await redis.initRunStock(run.id, 1);
  const stuck = (await db.insertOrder({ id: randomUUID(), gameId: shop.gameId, state: 'reserved', holdMs: 300_000, runId: run.id, buyerRef: randomUUID(), isSimulated: true })).id;
  await db.transition(stuck, 'reserved', 'payment_pending');
  await db.endRun(run.id, 'stopped');

  const view = follow(session);
  await view.until(() => view.of('run.ended').length === 1, 'run.ended after settleMs');
  assert.deepEqual([view.of('run.ended')[0].status, view.of('run.ended')[0].inFlight], ['stopped', 1]);
  view.close();
  await redis.deleteRun(run.id);
});

test('after close nothing more is sent, and a read that fails is only logged', async () => {
  const session = await shop.newSession();
  const view = follow(session);
  await wait(100);
  view.close();
  const count = view.events.length;
  await newOrder(session);
  await wait(200);
  assert.equal(view.events.length, count);

  const broken = createStream({ db: { ...db, streamCards: async () => { throw new Error('db down'); } }, redis, wakeups, reconciler, config: quiet, logger });
  const failing = follow(session, { streamOf: broken });
  await wait(150);
  assert.ok(lines.some((line) => line.msg === 'stream read failed' && line.err.message === 'db down'));
  assert.ok(!JSON.stringify(lines).includes(session), 'the session id is not logged');
  failing.close();
});

test('an invoiced order read before its invoice was visible is sent again with the invoice number', async () => {
  const session = await shop.newSession();
  const id = await completedOrder(shop, db, { sessionId: session, invoiceNo: 'SINV-RACE' });
  let first = true;
  const lateCards = {
    ...db,
    async streamCards(...args) {
      const cards = await db.streamCards(...args);
      if (!first) return cards;
      first = false;
      return cards.map((card) => ({ ...card, invoiceNo: null }));
    },
  };
  const view = follow(session, { streamOf: createStream({ db: lateCards, redis, wakeups, reconciler, config: quiet, logger }) });
  await view.until(() => states(id)(view).length === 1, 'the current state');
  assert.equal(view.of('order.state')[0].invoiceNo, 'SINV-RACE');
});
