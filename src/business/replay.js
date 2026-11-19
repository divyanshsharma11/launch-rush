// Dead-letter list and replay (design §5.4, §6): a delivery that failed for good can be run again.
import { BusinessError } from './errors.js';
import { UUID } from './orders.js';

export function createReplay({ db, fulfilmentQueue, webhookQueue, emailQueue }) {
  // Per connector: how to put the failed work back on its queue.
  const REQUEUE = {
    'erp-sim': (orderId) => fulfilmentQueue.replay(orderId),
    'payment-mock': async (orderId) => webhookQueue.replay((await db.findSucceededPayment(orderId)).id),
    // The order stays completed: only the delivery row is reopened (reopenDelivery moves an order only out of failed).
    'email-gmail': (orderId) => emailQueue.replay(orderId),
    'email-mock': (orderId) => emailQueue.replay(orderId),
  };

  return {
    listFailed: (limit = 100) => db.listFailedDeliveries(limit),

    async replay(deliveryId) {
      const delivery = UUID.test(deliveryId) ? await db.getDelivery(deliveryId) : null;
      if (!delivery) throw new BusinessError('not_found', 'no such delivery');
      if (!Object.hasOwn(REQUEUE, delivery.connector)) {
        throw new BusinessError('invalid_state', `deliveries of ${delivery.connector} cannot be replayed`);
      }
      // The order is back in its last good state before the job exists, so the job continues from there.
      const reopened = await db.reopenDelivery(deliveryId);
      if (!reopened) throw new BusinessError('invalid_state', 'delivery is not failed');
      await REQUEUE[reopened.connector](reopened.orderId);
    },
  };
}
