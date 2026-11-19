// Giving up a copy or a waitlist place: Release, waitlist promotion and the expiry sweeper.
import { runPool, shopPool } from '../services/redis/index.js';

export const poolOf = (order) => (order.runId ? runPool(order.runId) : shopPool(order.gameId));

export function createStockGate({ db, redis, config, logger }) {
  const holdMsOf = (order) => (order.runId ? config.runHoldMs : config.shopHoldMs);

  // Release, then promote the waiter it handed the copy to. If that waiter cannot be promoted (its wait ended
  // at the same moment, or it was never saved), release for it too, so the copy moves on.
  async function release(order) {
    let current = order;
    for (;;) {
      const outcome = await redis.release(poolOf(current), current.id, { buyerRef: current.buyerRef ?? '' });
      if (outcome.result !== 'handed') return;

      const waiter = await db.getOrder(outcome.orderId);
      if (waiter && (await db.transition(waiter.id, 'waitlisted', 'reserved', { holdMs: holdMsOf(waiter) }))) {
        logger.info({ orderId: waiter.id }, 'waiter promoted');
        return;
      }
      current = waiter ?? { id: outcome.orderId, gameId: order.gameId, runId: order.runId, buyerRef: null };
    }
  }

  // Only the caller whose state update wins runs Release, so a copy is passed on once.
  async function endEach(orders, to) {
    let moved = 0;
    for (const order of orders) {
      if (!(await db.transition(order.id, order.state, to))) continue;
      moved += 1;
      try {
        await release(order);
      } catch (err) {
        logger.error({ err, orderId: order.id }, 'release failed after the state change');
      }
    }
    return moved;
  }

  return {
    holdMsOf,
    release,
    endWaits: (orders) => endEach(orders, 'waitlist_ended'),
    async sweep(limit) {
      const expired = await endEach(await db.dueHolds(limit), 'reservation_expired');
      const waitsEnded = await endEach(await db.dueWaits(limit), 'waitlist_ended');
      return { expired, waitsEnded };
    },
  };
}
