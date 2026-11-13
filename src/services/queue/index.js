// BullMQ queues and job ids (plan §14 item 10, design §6). This piece: the webhook queue (design §5.2 step 4).
import { Queue } from 'bullmq';

// Used from an HTTP request, so it fails fast when Redis is down (BullMQ connections + production docs): no offline
// queue, 1 retry per command. Measured: rejects in ~1 ms during an outage and reconnects by itself afterwards.
// Before the FIRST connection add() would wait forever, so the entry point awaits ready() before taking requests.
export function createWebhookQueue({ redis, jobOptions, logger, name = 'webhooks' }) {
  const queue = new Queue(name, { connection: { ...redis, enableOfflineQueue: false, maxRetriesPerRequest: 1 } });
  // Without a listener, a connection error event would crash the process (measured).
  queue.on('error', (err) => logger.error({ err }, 'webhook queue redis error'));

  return {
    ready: () => queue.waitUntilReady(),
    // Design §5.2 step 4: jobId = event id; a job whose id already exists is ignored (BullMQ job ids docs, measured).
    // Job data is only the id: BullMQ stores job data in clear text; the worker loads the event from payment_events.
    add: (eventId) => queue.add('payment-event', { eventId }, { ...jobOptions, jobId: eventId }),
    close: () => queue.close(),
  };
}
