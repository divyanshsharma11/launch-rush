// Storefront rules: sessions, catalog, Buy, Pay, order cards and the Duplicate resend.
import { randomUUID } from 'node:crypto';
import { BusinessError } from './errors.js';
import { poolOf } from './waitlist-stock.js';
import { shopPool } from '../services/redis/index.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgreSQL rejects NUL in text, which would surface as a 500 for a bad request.
export const isGameId = (value) => typeof value === 'string' && !value.includes('\0');
// WHATWG HTML "valid email address" (the rule browsers use for <input type="email">).
const EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const notFound = () => new BusinessError('not_found', 'order not found');
const already = (order) =>
  new BusinessError('already_reserved', 'an active order already exists', { orderId: order.id, state: order.state });

export function createOrders({ db, redis, stockGate, payment, config, logger }) {
  const { stock, payment: paymentConfig } = config;

  // The stock gate decides; without it nothing is sold.
  async function gate(call) {
    try {
      return await call();
    } catch (err) {
      logger.error({ err }, 'stock gate unavailable');
      throw new BusinessError('unavailable', 'stock gate unavailable');
    }
  }

  async function recordDuplicate(orderId) {
    try {
      await db.recordDuplicate(orderId, 'buy');
    } catch (err) {
      logger.warn({ err, orderId }, 'duplicate buy not recorded'); // e.g. the first order is not saved yet
    }
  }

  // Shared by the API's Buy and the run driver. run: the demo run, or null for the shop.
  async function reserve({ game, run = null, sessionId = null, buyerRef = null, isSimulated = false }) {
    const id = randomUUID();
    const pool = poolOf({ runId: run?.id, gameId: game.id });
    const granted = await gate(() => redis.buy(pool, id, { buyerRef: buyerRef ?? '' }));
    if (granted.result === 'already') {
      await recordDuplicate(granted.orderId);
      throw already((await db.getOrder(granted.orderId)) ?? { id: granted.orderId, state: null }); // first order not saved yet
    }

    let order;
    try {
      order = await db.insertOrder({
        id, sessionId, gameId: game.id, state: granted.result, runId: run?.id ?? null, buyerRef, isSimulated,
        holdMs: run ? stock.runHoldMs : stock.shopHoldMs, waitMs: stock.waitlistMs, waitEndsAt: run?.endsAt ?? null,
      });
    } catch (err) {
      await stockGate.release({ id, gameId: game.id, runId: run?.id ?? null, buyerRef }).catch((releaseErr) => {
        logger.error({ err: releaseErr, orderId: id }, 'release after a failed insert failed');
      });
      const existing = err.constraint === 'orders_one_active_per_session_game'
        && (await db.findActiveShopOrder(sessionId, game.id));
      if (!existing) throw err;
      await recordDuplicate(existing.id);
      throw already(existing);
    }
    return { order, buyerNumber: granted.buyerNumber, position: granted.position };
  }

  async function startPayment(order, email = null) {
    if (await db.transition(order.id, 'reserved', 'payment_pending', { email })) return;
    const current = await db.getOrder(order.id);
    if (current.state !== 'payment_pending') {
      throw new BusinessError('invalid_state', `order is ${current.state}`, { state: current.state });
    }
  }

  // Same key on every call, so a repeat never charges twice.
  async function charge(order) {
    const ctx = ctxFor(order, `charge-${order.id}`);
    try {
      await payment.execute('charge', { orderId: order.id, amountMinor: order.amountMinor, currency: order.currency }, ctx);
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'charge failed');
      throw new BusinessError('payment_unavailable', 'payment provider call failed; safe to retry');
    }
  }

  const ctxFor = (order, idempotencyKey) => ({
    orderId: order.id, runId: order.runId, idempotencyKey, attempt: 1, timeoutMs: paymentConfig.callTimeoutMs,
  });

  async function ownOrder(sessionId, orderId) {
    const order = UUID.test(orderId) ? await db.getOrder(orderId) : null;
    if (!order || order.sessionId !== sessionId) throw notFound();
    return order;
  }

  async function toCard({ runId, waitlistUntil, ...card }) {
    if (card.state !== 'waitlisted') return card;
    const waitlistPosition = await redis.waitlistPosition(poolOf({ runId, gameId: card.gameId }), card.orderId);
    return { ...card, waitlistPosition, waitlistUntil };
  }

  return {
    reserve,
    startPayment,
    charge,

    createSession: () => db.createSession(),
    sessionExists: (id) => UUID.test(id) && db.sessionExists(id),

    async listGames() {
      const games = await db.listShopGames();
      const left = await redis.stockLeft(games.map((game) => shopPool(game.id)));
      return games.map((game, i) => ({ ...game, stockLeft: left[i] }));
    },

    async buy(sessionId, { gameId, runId } = {}) {
      if (!isGameId(gameId) || (runId !== undefined && !(typeof runId === 'string' && UUID.test(runId)))) {
        throw new BusinessError('invalid_input', 'gameId (string) is required; runId must be a uuid');
      }
      const game = await db.getGame(gameId);
      if (!game?.listedInShop) throw new BusinessError('unknown_game', 'unknown game');

      let run = null;
      if (runId) {
        run = await db.getRun(runId);
        if (!run || run.sessionId !== sessionId) throw new BusinessError('not_found', 'run not found');
        if (run.status !== 'running' || run.endsAt <= new Date()) throw new BusinessError('run_ended', 'run has ended');
        if (run.gameId !== gameId) throw new BusinessError('invalid_input', 'gameId is not the run\'s game');
      }

      const { order, buyerNumber, position } = await reserve({ game, run, sessionId, buyerRef: run ? sessionId : null });
      logger.info({ orderId: order.id, gameId, runId: run?.id ?? null, state: order.state }, 'order created');
      return order.state === 'reserved'
        ? { orderId: order.id, state: order.state, reservedUntil: order.reservedUntil, buyerNumber }
        : { orderId: order.id, state: order.state, waitlistPosition: position, waitlistUntil: order.waitlistUntil };
    },

    async pay(sessionId, orderId, { email = null } = {}) {
      if (email !== null && !(typeof email === 'string' && EMAIL.test(email))) {
        throw new BusinessError('invalid_email', 'email is not a valid address');
      }
      const order = await ownOrder(sessionId, orderId);
      await startPayment(order, email);
      await charge(order);
      return { orderId: order.id, state: 'payment_pending' };
    },

    async getOrder(sessionId, orderId) {
      const card = UUID.test(orderId) ? await db.getSessionOrder(sessionId, orderId) : null;
      if (!card) throw notFound();
      return toCard(card);
    },

    async listOrders(sessionId) {
      return Promise.all((await db.listSessionOrders(sessionId)).map(toCard));
    },

    // "Duplicate": the provider re-sends the stored payment event, same event id.
    async resendWebhook(sessionId, orderId) {
      const order = await ownOrder(sessionId, orderId);
      const event = await db.findSucceededPayment(order.id);
      if (!event) throw new BusinessError('invalid_state', 'no payment yet', { state: order.state });
      try {
        await payment.execute('resend_webhook', { paymentId: event.data.paymentId }, ctxFor(order, null));
      } catch (err) {
        logger.warn({ err, orderId: order.id }, 'webhook resend failed');
        throw new BusinessError('payment_unavailable', 'payment provider call failed; safe to retry');
      }
    },
  };
}
