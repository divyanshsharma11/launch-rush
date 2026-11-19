// Shop restock (design §1.2): a sold-out shop game gets its starting stock again, and the admin can refill.
// Steps of one receipt, each keyed by the receipt id so repeating any of them is safe:
// 1 record it in PostgreSQL, 2 add to the ERP, 3 add to Redis (waiters first), 4 promote those waiters, 5 mark it done.
import { randomUUID } from 'node:crypto';
import { BusinessError } from './errors.js';
import { shopPool } from '../services/redis/index.js';

export function createRestock({ db, redis, erp, stockGate, config, logger, now = Date.now }) {
  const ctx = { orderId: null, runId: null, idempotencyKey: null, attempt: 1, timeoutMs: config.erp.callTimeoutMs };

  // A waiter that got a copy in Redis becomes reserved; if that update changes 0 rows (its wait ended at the same
  // moment, or it was never saved), Release hands the copy on.
  async function promote(orderId, gameId) {
    const waiter = await db.getOrder(orderId);
    if (waiter && (await db.transition(waiter.id, 'waitlisted', 'reserved', { holdMs: stockGate.holdMsOf(waiter) }))) {
      logger.info({ orderId }, 'waiter promoted');
      return;
    }
    await stockGate.release(waiter ?? { id: orderId, gameId, runId: null, buyerRef: null });
  }

  // Steps 2-5. The ERP goes first: a copy that reaches Redis before the ERP could be bought and paid for, and then
  // fail at the ERP's reserve step with InsufficientStock.
  async function apply({ id, gameId, qty }) {
    await erp.execute('stock.add', { receiptId: id, itemCode: gameId, qty }, ctx);
    const waiters = await redis.applyReceipt(shopPool(gameId), id, qty);
    for (const orderId of waiters) await promote(orderId, gameId);
    await db.markReceiptDone(id);
    logger.info({ receiptId: id, gameId, qty, waitersServed: waiters.length }, 'stock restocked');
    return true;
  }

  async function restock(gameId, qty, dedupeKey) {
    const id = await db.insertReceipt({ gameId, dedupeKey, qty });
    return id === null ? false : apply({ id, gameId, qty });
  }

  // A failure leaves the receipt unfinished: the next pass finishes it, and other games are not held up.
  async function attempt(work, fields) {
    try {
      return await work();
    } catch (err) {
      logger.error({ err, ...fields }, 'restock step failed');
      return false;
    }
  }

  return {
    // Timer pass: finish unfinished receipts, then restock every sold-out game once per window.
    // A game whose receipt is still unfinished waits, so a long outage cannot pile up receipts.
    async tick() {
      let finished = 0;
      const unfinished = new Set();
      for (const receipt of await db.pendingReceipts(config.restock.batchSize)) {
        if (await attempt(() => apply(receipt), { receiptId: receipt.id })) finished += 1;
        else unfinished.add(receipt.gameId);
      }

      const games = await db.listShopGames();
      const left = await redis.stockLeft(games.map((game) => shopPool(game.id)));
      const windowStart = Math.floor(now() / config.restock.windowMs) * config.restock.windowMs;
      let restocked = 0;
      for (const [i, game] of games.entries()) {
        if (left[i] > 0 || game.stockTotal <= 0 || unfinished.has(game.id)) continue;
        if (await attempt(() => restock(game.id, game.stockTotal, `timer:${game.id}:${windowStart}`), { gameId: game.id })) {
          restocked += 1;
        }
      }
      return { restocked, finished };
    },

    // Admin "reset demo stock": up to each game's starting level, based on the stock right now. Cancels no orders.
    async refill(gameId = null) {
      if (gameId !== null && typeof gameId !== 'string') throw new BusinessError('invalid_input', 'gameId must be a string');
      const games = (await db.listShopGames()).filter((game) => gameId === null || game.id === gameId);
      if (gameId !== null && games.length === 0) throw new BusinessError('invalid_input', 'unknown game');

      const left = await redis.stockLeft(games.map((game) => shopPool(game.id)));
      const refilled = [];
      for (const [i, game] of games.entries()) {
        const qty = game.stockTotal - left[i];
        if (qty > 0 && (await restock(game.id, qty, `admin:${randomUUID()}`))) refilled.push({ gameId: game.id, qty });
      }
      return refilled;
    },
  };
}
