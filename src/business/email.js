// The confirmation email (design §1, §5.1): decide the channel once, send through it, track the delivery row.
// An email failure never touches the order state: only the delivery row and emailStatus show it.
import { confirmationEmail } from './email-content.js';

const ACTION = 'email.send';

// connectors: { gmail, mock }, both with the connector interface (design §3).
export function createEmail({ db, redis, connectors, config, logger, now = () => new Date() }) {
  // Simulated rush buyers always get mock and never use the quota; a visitor's order goes through the cap.
  async function channelOf(order) {
    if (order.emailChannel) return order.emailChannel;
    const wanted = order.isSimulated
      ? 'mock'
      : await redis.emailChannel({
        sessionId: order.sessionId, orderId: order.id, day: now().toISOString().slice(0, 10), caps: config.caps,
      });
    return db.setEmailChannel(order.id, wanted);
  }

  return {
    async send(orderId, { attempt = 1 } = {}) {
      const order = await db.getEmailOrder(orderId);
      if (!order || order.state !== 'completed' || order.deliveryStatus === 'succeeded') return;

      const channel = await channelOf(order);
      const connector = connectors[channel];
      const delivery = { orderId, connector: connector.id, action: ACTION };
      await db.startDelivery(delivery);
      const ctx = {
        orderId, runId: order.runId, idempotencyKey: `${ACTION}-${orderId}`, attempt, timeoutMs: config.callTimeoutMs,
      };
      try {
        await connector.execute(ACTION, { to: order.buyerEmail, ...confirmationEmail(order) }, ctx);
        await db.updateDelivery({ ...delivery, status: 'succeeded' });
      } catch (err) {
        await db.updateDelivery({ ...delivery, status: 'pending', error: err.message, failure: connector.classifyError(err) });
        throw err;
      }
      logger.info({ orderId, channel }, 'confirmation email sent');
    },

    // The mock connector never fails, so what can fail for good is Gmail's classification.
    classifyError: (err) => connectors.gmail.classifyError(err),

    // The last retry failed: the delivery is failed for good, ready for replay. The job may have failed before its
    // delivery row existed (the channel decision itself failed), so the row is created if missing.
    async markFailed(orderId, err) {
      const order = await db.getEmailOrder(orderId);
      if (!order) return;
      const channel = order.emailChannel ?? (order.isSimulated ? 'mock' : 'gmail');
      await db.failDelivery({ orderId, connector: connectors[channel].id, action: ACTION, error: err.message });
      logger.error({ orderId, err }, 'confirmation email failed for good');
    },

    // Email purge (design §1.2).
    async purge() {
      return { purged: await db.purgeEmails(config.purge.afterMs) };
    },
  };
}
