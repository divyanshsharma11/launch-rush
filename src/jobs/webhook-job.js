// Webhook queue job: load the stored event, let the business layer handle it, turn failures into BullMQ outcomes:
// retryable -> throw (backoff), permanent -> UnrecoverableError, rateLimited -> delay without an attempt.
import { DelayedError, UnrecoverableError } from 'bullmq';

export function createWebhookJob({ db, paymentEvents, classifyError }) {
  return {
    async process(job, token) {
      const event = await db.getPaymentEvent(job.data.eventId);
      if (!event) throw new UnrecoverableError(`event ${job.data.eventId} is not stored`);
      try {
        await paymentEvents.process(event, { attempt: job.attemptsMade + 1 });
      } catch (err) {
        const { kind, retryAfterMs } = classifyError(err);
        if (kind === 'permanent') throw new UnrecoverableError(err.message);
        if (kind === 'rateLimited') {
          await job.moveToDelayed(Date.now() + retryAfterMs, token);
          throw new DelayedError();
        }
        throw err;
      }
    },

    async onFinalFailure(job, err) {
      const event = await db.getPaymentEvent(job.data.eventId);
      if (event) await paymentEvents.markFailed(event, err);
    },
  };
}
