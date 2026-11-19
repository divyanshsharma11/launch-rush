// Payment webhook ingress (design §5.2 steps 2-4).
import { InvalidPayloadError } from '../services/connectors/payment-mock.js';

const EVENT_TYPES = new Set(['payment.succeeded', 'payment.refunded']);
const EVENT_ID = /^[^0-9:][^:]*$/; // reused as a BullMQ job id; same rule as migration 008
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPayments({ verifier, db, webhookQueue, logger }) {
  // Feeds the scoreboard's "duplicates blocked". Best effort: a failed count must not fail the webhook.
  async function countDuplicate(orderId) {
    try {
      await db.recordDuplicate(orderId, 'webhook');
    } catch (err) {
      logger.warn({ err, orderId }, 'duplicate webhook not counted');
    }
  }

  return {
    async receiveWebhook(rawBody, headers) {
      const event = verifier.verifyInbound(rawBody, headers);
      if (!isValidEvent(event)) throw new InvalidPayloadError('event fields missing or invalid');

      const stored = await db.insertPaymentEvent(event);
      // Enqueue even if the event was already stored: a crash between the two steps
      // is then fixed by the provider's retry. Duplicate job ids are ignored.
      await webhookQueue.add(event.id);

      const { id: eventId, type, data } = event;
      logger.info({ eventId, type, orderId: data.orderId, duplicate: !stored }, 'payment event received');
      if (!stored) await countDuplicate(data.orderId);
    },
  };
}

function isValidEvent(event) {
  return (
    isObject(event) &&
    isString(event.id) && EVENT_ID.test(event.id) &&
    EVENT_TYPES.has(event.type) &&
    isObject(event.data) &&
    isString(event.data.orderId) && UUID.test(event.data.orderId)
  );
}

// JSON.parse can return null, numbers or arrays; typeof null is 'object'.
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
