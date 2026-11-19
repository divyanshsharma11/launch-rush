// Email queue job: send the confirmation email for one order, turn failures into BullMQ outcomes:
// retryable -> throw (backoff), permanent -> UnrecoverableError, rateLimited -> delay without an attempt.
import { DelayedError, UnrecoverableError } from 'bullmq';

export function createEmailJob({ email }) {
  return {
    async process(job, token) {
      try {
        await email.send(job.data.orderId, { attempt: job.attemptsMade + 1 });
      } catch (err) {
        const { kind, retryAfterMs } = email.classifyError(err);
        if (kind === 'permanent') throw new UnrecoverableError(err.message);
        if (kind === 'rateLimited') {
          await job.moveToDelayed(Date.now() + retryAfterMs, token);
          throw new DelayedError();
        }
        throw err;
      }
    },

    onFinalFailure: (job, err) => email.markFailed(job.data.orderId, err),
  };
}
