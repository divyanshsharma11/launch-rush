// What the webhook job does with a stored payment event.
import { poolOf } from './waitlist-stock.js';

export function createPaymentEvents({ db, redis, payment, fulfilmentQueue, config, logger }) {
  const ctxFor = (order, attempt) => ({
    orderId: order.id, runId: order.runId, idempotencyKey: `refund-${order.id}`, attempt, timeoutMs: config.callTimeoutMs,
  });

  // refund_pending is recorded before the call, so a retry can only finish the refund.
  async function refund(order, event, attempt) {
    const action = { orderId: order.id, connector: payment.id, action: 'refund' };
    await db.startDelivery(action);
    try {
      await payment.execute('refund', { paymentId: event.data.paymentId }, ctxFor(order, attempt));
    } catch (err) {
      await db.updateDelivery({ ...action, status: 'pending', error: err.message, failure: payment.classifyError(err) });
      throw err;
    }
    await db.updateDelivery({ ...action, status: 'succeeded' });
    await db.transition(order.id, 'refund_pending', 'refunded');
    logger.info({ orderId: order.id }, 'order refunded');
  }

  const fulfil = (orderId) => fulfilmentQueue.add(orderId);

  // After a lost race the loop reads the order again; each state has one action, so it ends quickly.
  async function onSucceeded(event, attempt) {
    for (let round = 0; round < 3; round += 1) {
      const order = await db.getOrder(event.data.orderId);
      switch (order?.state) {
        case 'payment_pending':
          if (await db.transition(order.id, 'payment_pending', 'paid')) return fulfil(order.id);
          break;
        case 'paid': // crash after the update but before the enqueue: enqueue again, BullMQ ignores a repeat
          return fulfil(order.id);
        case 'reservation_expired': {
          const copy = await redis.buy(poolOf(order), order.id, { buyerRef: order.buyerRef ?? '', joinWaitlist: false });
          const next = copy.result === 'reserved' ? 'paid' : 'refund_pending';
          if (!(await db.transition(order.id, 'reservation_expired', next))) break;
          return next === 'paid' ? fulfil(order.id) : refund(order, event, attempt);
        }
        case 'refund_pending':
          return refund(order, event, attempt);
        default:
          logger.info({ orderId: order?.id, state: order?.state }, 'payment event already handled');
          return;
      }
    }
  }

  return {
    // payment.refunded is confirmation only: it never changes the order.
    async process(event, { attempt = 1 } = {}) {
      if (event.type === 'payment.succeeded') await onSucceeded(event, attempt);
    },

    // The refund could not be done: the order moves to failed, kept for replay.
    async markFailed(event, err) {
      const orderId = event.data.orderId;
      await db.updateDelivery({ orderId, connector: payment.id, action: 'refund', status: 'failed', error: err.message });
      if (await db.transition(orderId, 'refund_pending', 'failed')) logger.error({ orderId, err }, 'refund failed for good');
    },
  };
}
