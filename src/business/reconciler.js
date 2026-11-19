// The reconciler: the scoreboard and run invariants, computed from PostgreSQL (and Redis stock), never from the
// animation. Hard checks (oversold, completedWithoutInvoice, stockMismatches) must stay 0.
import { runPool, shopPool } from '../services/redis/index.js';

// Run orders in these states are still moving; the others have ended for good (completed, failed, refunded, ...).
const IN_FLIGHT = ['reserved', 'payment_pending', 'waitlisted', 'paid', 'so_submitted', 'invoiced', 'refund_pending'];

export function createReconciler({ db, redis, config }) {
  // A pool's copies are either in stock or held by an order, so stock + holds equals its starting stock.
  async function copiesMismatch(pool, expected) {
    const { stock, holds } = await redis.poolCopies(pool);
    return stock + holds !== expected;
  }

  async function runSummary(run) {
    const counts = await db.invariantCounts({ runId: run.id }, config.graceMs);
    const [stockLeft] = await redis.stockLeft([runPool(run.id)]);
    const states = counts.byState;
    return {
      runId: run.id,
      status: run.status,
      gameId: run.gameId,
      endsAt: run.endsAt,
      buyersRequested: run.buyersRequested,
      stockTotal: run.stockTotal,
      stockLeft,
      sold: counts.sold,
      oversold: Math.max(0, counts.sold - run.stockTotal),
      reserved: states.reserved ?? 0,
      waitlisted: states.waitlisted ?? 0,
      invoiced: (states.invoiced ?? 0) + (states.completed ?? 0), // orders with a submitted Sales Invoice
      inFlight: IN_FLIGHT.reduce((sum, state) => sum + (states[state] ?? 0), 0),
      refunded: states.refunded ?? 0,
      expired: states.reservation_expired ?? 0,
      waitlistEnded: states.waitlist_ended ?? 0,
      failed: states.failed ?? 0,
      duplicatesBlocked: counts.duplicatesBlocked,
      lost: counts.lost,
      paidNotInvoicedOrRefunded: counts.paidNotInvoicedOrRefunded,
      completedWithoutInvoice: counts.completedWithoutInvoice,
      stockMismatch: await copiesMismatch(runPool(run.id), run.stockTotal),
    };
  }

  // The shop scoreboard: all-time, per game: sold <= starting stock + all recorded receipts.
  async function scoreboard() {
    const [games, counts] = await Promise.all([db.shopStockTotals(), db.invariantCounts({}, config.graceMs)]);
    const mismatched = [];
    for (const game of games) {
      // A receipt not yet marked done is "in progress", not a mismatch.
      if (!game.inProgress && (await copiesMismatch(shopPool(game.gameId), game.start + game.receivedInRedis))) {
        mismatched.push(game.gameId);
      }
    }
    return {
      sold: counts.sold,
      stock: games.reduce((sum, game) => sum + game.start + game.received, 0),
      oversold: games.reduce((sum, game) => sum + Math.max(0, game.sold - game.start - game.received), 0),
      lost: counts.lost,
      paidNotInvoicedOrRefunded: counts.paidNotInvoicedOrRefunded,
      completedWithoutInvoice: counts.completedWithoutInvoice,
      duplicatesBlocked: counts.duplicatesBlocked,
      stockMismatches: mismatched,
      checkedAt: new Date().toISOString(),
    };
  }

  // Shop holds whose order cannot hold a copy (a crash between the Redis and the PostgreSQL step, design §1). Such a
  // hold also exists for a moment during a normal Buy or release, so it counts only when it was already found on the
  // previous pass. Detect only: releasing it could free a copy that a late payment is about to take.
  let previousOrphans = new Set();
  async function leakedHolds() {
    const games = await db.shopStockTotals();
    const holds = (await Promise.all(games.map((game) => redis.holdOrderIds(shopPool(game.gameId))))).flat();
    const orphans = new Set(await db.ordersWithoutCopy(holds));
    const leaked = [...orphans].filter((id) => previousOrphans.has(id));
    previousOrphans = orphans;
    return leaked;
  }

  return {
    runSummary,
    scoreboard,
    // Timer pass: store the latest result; return only the violations, so a healthy pass logs nothing.
    async run() {
      const result = { ...(await scoreboard()), leakedHolds: await leakedHolds() };
      await redis.saveScoreboard(result);
      return {
        oversold: result.oversold,
        lost: result.lost,
        paidNotInvoicedOrRefunded: result.paidNotInvoicedOrRefunded,
        completedWithoutInvoice: result.completedWithoutInvoice,
        stockMismatches: result.stockMismatches.length,
        leakedHolds: result.leakedHolds.length,
      };
    },
  };
}
