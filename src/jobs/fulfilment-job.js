// Fulfilment queue job: run the ERP steps for one order, turn failures into BullMQ outcomes:
// retryable -> throw (backoff), permanent -> UnrecoverableError, rateLimited -> delay without an attempt.
import { DelayedError, UnrecoverableError } from 'bullmq';

export function createFulfilmentJob({ fulfilment, classifyError }) {
  return {
    async process(job, token) {
      try {
        await fulfilment.process(job.data.orderId, { attempt: job.attemptsMade + 1 });
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

    onFinalFailure: (job, err) => fulfilment.markFailed(job.data.orderId, err),
  };
}
