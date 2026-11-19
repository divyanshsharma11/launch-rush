// Redis client for the stock gate: one atomic Lua script per stock change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redis } from 'ioredis';

const lua = (name) => readFileSync(join(import.meta.dirname, 'lua', `${name}.lua`), 'utf8');

// A pool is the shop pool of one game or one demo run's pool.
export const shopPool = (gameId) => `shop:${gameId}`;
export const runPool = (runId) => `run:${runId}`;

const key = (kind, pool) => `${kind}:${pool}`;
const RUSH_DISABLED = 'rush:disabled';
const SCOREBOARD = 'scoreboard:latest';
const BREAKERS = 'breakers';
const ADMIN_SESSION = 'admin:session:';
export const ORDER_CHANNEL = 'order:';
const POOL_KEYS = ['stock', 'holds', 'waitlist', 'tickets', 'grants', 'buyers'];

// Fails fast while Redis is down (no offline queue, 1 retry per command), like the webhook queue.
export function createRedis({ redis, logger }) {
  const client = new Redis({ ...redis, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  client.on('error', (err) => logger.error({ err }, 'redis error'));
  client.defineCommand('stockBuy', { numberOfKeys: 6, lua: lua('buy') });
  client.defineCommand('stockRelease', { numberOfKeys: 5, lua: lua('release') });
  client.defineCommand('stockRestock', { numberOfKeys: 5, lua: lua('restock') });
  client.defineCommand('rateLimit', { numberOfKeys: 1, lua: lua('rate-limit') });
  client.defineCommand('emailQuota', { numberOfKeys: 2, lua: lua('email-quota') });

  return {
    ready: () => (client.status === 'ready' ? Promise.resolve() : new Promise((resolve) => client.once('ready', resolve))),

    // Sets each game's shop stock once; an existing counter is never overwritten.
    async initShopStock(games) {
      const pipeline = client.pipeline();
      for (const game of games) pipeline.set(key('stock', shopPool(game.id)), game.stockTotal, 'NX');
      await pipeline.exec();
    },
    initRunStock: (runId, qty) => client.set(key('stock', runPool(runId)), qty, 'NX'),

    // { result: 'reserved', buyerNumber } | { result: 'waitlisted', position } | { result: 'already', orderId }
    // | { result: 'none' } (no copy and joinWaitlist false: the late-payment re-reserve).
    async buy(pool, orderId, { buyerRef = '', joinWaitlist = true } = {}) {
      const keys = POOL_KEYS.map((kind) => key(kind, pool));
      const [result, value] = await client.stockBuy(...keys, orderId, buyerRef, joinWaitlist ? '1' : '0');
      if (result === 'reserved') return { result, buyerNumber: value };
      if (result === 'waitlisted') return { result, position: value };
      if (result === 'already') return { result, orderId: value };
      return { result };
    },

    // { result: 'handed', orderId } (the earliest waiter now holds the copy) | { result: 'returned' } | { result: 'none' }.
    async release(pool, orderId, { buyerRef = '' } = {}) {
      const keys = ['stock', 'holds', 'waitlist', 'grants', 'buyers'].map((kind) => key(kind, pool));
      const [result, waiter] = await client.stockRelease(...keys, orderId, buyerRef);
      return result === 'handed' ? { result, orderId: waiter } : { result };
    },

    // Adds a restock receipt's copies to a pool: waiters first, the rest to stock. Returns the order ids of the
    // waiters that were handed a copy ([] when the receipt id was applied before).
    async applyReceipt(pool, receiptId, qty) {
      const keys = ['stock', 'holds', 'waitlist', 'grants', 'receipts'].map((kind) => key(kind, pool));
      return client.stockRestock(...keys, receiptId, qty);
    },

    // Counts one request in a fixed window. resetMs: how long until the window ends.
    async hit(counterKey, windowMs) {
      const [count, resetMs] = await client.rateLimit(counterKey, windowMs);
      return { count, resetMs };
    },

    // Which connector may send this order's email: 'gmail' while the session and the UTC day are under their caps
    // (the order is counted once, however often this is called), else 'mock'.
    async emailChannel({ sessionId, orderId, day, caps }) {
      return client.emailQuota(
        `email:session:${sessionId}`, `email:day:${day}`, orderId, caps.perSession, caps.perDay, caps.dayKeyTtlSeconds,
      );
    },

    // Admin login sessions (design §5.4): the key expires by itself after ttlSeconds, so a session never outlives
    // its absolute timeout.
    saveAdminSession: (id, ttlSeconds) => client.set(`${ADMIN_SESSION}${id}`, '1', 'EX', ttlSeconds),
    async adminSessionExists(id) {
      return (await client.exists(`${ADMIN_SESSION}${id}`)) === 1;
    },
    deleteAdminSession: (id) => client.del(`${ADMIN_SESSION}${id}`),

    async stockLeft(pools) {
      if (pools.length === 0) return [];
      const values = await client.mget(pools.map((pool) => key('stock', pool)));
      return values.map((value) => Number(value ?? 0));
    },

    // Copies in stock plus copies held by orders: with the pool's starting stock this must stay constant.
    async poolCopies(pool) {
      const [stock, holds] = await Promise.all([client.get(key('stock', pool)), client.hlen(key('holds', pool))]);
      return { stock: Number(stock ?? 0), holds };
    },

    // The order ids that hold a copy of the pool.
    holdOrderIds: (pool) => client.hkeys(key('holds', pool)),

    async waitlistPosition(pool, orderId) {
      const rank = await client.zrank(key('waitlist', pool), orderId);
      return rank === null ? null : rank + 1;
    },

    deletePool: (pool) => client.del(...POOL_KEYS.map((kind) => key(kind, pool))),

    // A run's fault settings; the ERP simulator reads them by the X-Sim-Run header.
    setRunFaults: (runId, faults) => client.set(`faults:${runId}`, JSON.stringify(faults)),
    // The shop's ERP fault settings (calls without X-Sim-Run), set from the admin API.
    setSharedFaults: (faults) => client.set('faults:shared', JSON.stringify(faults)),
    async sharedFaults() {
      const value = await client.get('faults:shared');
      return value ? JSON.parse(value) : null;
    },
    // Everything Redis holds for one run: its stock pool and its fault settings.
    deleteRun: (runId) => client.del(`faults:${runId}`, ...POOL_KEYS.map((kind) => key(kind, runPool(runId)))),

    // Kill switch: stored as "disabled", so a missing key means rush is on.
    setRushEnabled: (enabled) => (enabled ? client.del(RUSH_DISABLED) : client.set(RUSH_DISABLED, '1')),
    async rushEnabled() {
      return (await client.exists(RUSH_DISABLED)) === 0;
    },

    // Wake-up for the SSE streams (design §8.4): a signal only, never the data, because Pub/Sub is at-most-once.
    // The message is the session id for a new order, so that session's stream starts following it at once.
    // Best effort: a stream's own timer reads the change anyway, so a failure is only logged.
    notifyOrder: (orderId, sessionId = '') =>
      client.publish(`${ORDER_CHANNEL}${orderId}`, sessionId ?? '').catch((err) => logger.warn({ err, orderId }, 'wake-up not published')),

    // Circuit breaker states of the worker, for the stream's breaker.state events. state null removes the entry.
    // Best effort like notifyOrder: the breaker keeps working if this fails.
    setBreakerState: ({ connector, runId, state }) => {
      const field = `${connector}:${runId ?? 'shared'}`;
      return (state ? client.hset(BREAKERS, field, state) : client.hdel(BREAKERS, field)).catch((err) =>
        logger.warn({ err, field }, 'breaker state not stored'));
    },
    async breakerStates() {
      const fields = await client.hgetall(BREAKERS);
      return Object.entries(fields).map(([field, state]) => {
        const [connector, runId] = field.split(':');
        return { connector, runId: runId === 'shared' ? null : runId, state };
      });
    },
    clearBreakerStates: () => client.del(BREAKERS),

    // The reconciler's latest result, read by the scoreboard.
    saveScoreboard: (scoreboard) => client.set(SCOREBOARD, JSON.stringify(scoreboard)),
    async loadScoreboard() {
      const value = await client.get(SCOREBOARD);
      return value ? JSON.parse(value) : null;
    },
    // quit() needs a live connection; while Redis is down, disconnect() stops the reconnect loop instead.
    close: async () => (client.status === 'ready' ? client.quit() : client.disconnect()),
  };
}
