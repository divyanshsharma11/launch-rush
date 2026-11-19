// BullMQ queues, job ids and the worker factory.
import { Queue, Worker } from 'bullmq';

// The job's BullMQ state ('failed', 'delayed', 'waiting', 'active', ...) and failure reason, or null when there is no
// such job.
async function findJob(queue, jobId) {
  const job = await queue.getJob(jobId);
  return job ? { state: await job.getState(), failedReason: job.failedReason } : null;
}

// Admin replay (design §6): a failed job goes back to waiting with fresh attempts. Both counters are reset, or
// maxStartedAttempts would fail it again at once. If BullMQ already removed the failed job, a new one is added.
async function retryOrAdd(queue, jobId, add) {
  const job = await queue.getJob(jobId);
  if (job && (await job.isFailed())) return job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
  return add();
}

// Jobs per state for the admin health view (design §5.4): queue depth is waiting + delayed, failed is BullMQ's failed set.
const counts = (queue) => queue.getJobCounts('waiting', 'active', 'delayed', 'failed');

// Used from an HTTP request, so it fails fast when Redis is down (BullMQ connections + production docs): no offline
// queue, 1 retry per command. Measured: rejects in ~1 ms during an outage and reconnects by itself afterwards.
// Before the FIRST connection add() would wait forever, so the entry point awaits ready() before taking requests.
export function createWebhookQueue({ redis, jobOptions, logger, name = 'webhooks' }) {
  const queue = new Queue(name, { connection: { ...redis, enableOfflineQueue: false, maxRetriesPerRequest: 1 } });
  // Without a listener, a connection error event would crash the process (measured).
  queue.on('error', (err) => logger.error({ err }, 'webhook queue redis error'));

  // Design §5.2 step 4: jobId = event id; a job whose id already exists is ignored (BullMQ job ids docs, measured).
  // Job data is only the id: BullMQ stores job data in clear text; the worker loads the event from payment_events.
  const add = (eventId) => queue.add('payment-event', { eventId }, { ...jobOptions, jobId: eventId });

  return {
    ready: () => queue.waitUntilReady(),
    add,
    counts: () => counts(queue),
    find: (eventId) => findJob(queue, eventId),
    replay: (eventId) => retryOrAdd(queue, eventId, () => add(eventId)),
    close: () => queue.close(),
  };
}

// Fulfilment jobs: one per order, jobId fulfil-<orderId>, so a second webhook adds nothing.
export function createFulfilmentQueue({ redis, jobOptions, logger, name = 'fulfilment' }) {
  const queue = new Queue(name, { connection: { ...redis, enableOfflineQueue: false, maxRetriesPerRequest: 1 } });
  queue.on('error', (err) => logger.error({ err }, 'fulfilment queue redis error'));
  const add = (orderId) => queue.add('fulfil-order', { orderId }, { ...jobOptions, jobId: `fulfil-${orderId}` });
  return {
    ready: () => queue.waitUntilReady(),
    add,
    counts: () => counts(queue),
    find: (orderId) => findJob(queue, `fulfil-${orderId}`),
    replay: (orderId) => retryOrAdd(queue, `fulfil-${orderId}`, () => add(orderId)),
    close: () => queue.close(),
  };
}

// Email jobs: one per order, jobId email-<orderId> (design §5.3 hand-off). The fulfilment job adds them; replay is the
// admin's.
export function createEmailQueue({ redis, jobOptions, logger, name = 'email' }) {
  const queue = new Queue(name, { connection: { ...redis, enableOfflineQueue: false, maxRetriesPerRequest: 1 } });
  queue.on('error', (err) => logger.error({ err }, 'email queue redis error'));
  const add = (orderId) => queue.add('send-email', { orderId }, { ...jobOptions, jobId: `email-${orderId}` });
  return {
    ready: () => queue.waitUntilReady(),
    add,
    counts: () => counts(queue),
    replay: (orderId) => retryOrAdd(queue, `email-${orderId}`, () => add(orderId)),
    close: () => queue.close(),
  };
}

// Demo run jobs: one per run, jobId run-<runId>. The worker's run driver acts for the simulated buyers.
export function createRunQueue({ redis, logger, name = 'runs' }) {
  const queue = new Queue(name, { connection: { ...redis, enableOfflineQueue: false, maxRetriesPerRequest: 1 } });
  queue.on('error', (err) => logger.error({ err }, 'run queue redis error'));
  return {
    counts: () => counts(queue),
    add: (runId) => queue.add('drive-run', { runId }, { jobId: `run-${runId}`, removeOnComplete: true, removeOnFail: true }),
    close: () => queue.close(),
  };
}

// A worker needs maxRetriesPerRequest: null (BullMQ going-to-production docs). onFinalFailure runs when a job will not
// be retried again: attempts used up, an UnrecoverableError, or maxStartedAttempts reached (BullMQ then fails the job
// with an UnrecoverableError without running it again).
export function createWorker({ name, redis, processor, concurrency = 1, maxStartedAttempts, onFinalFailure, logger }) {
  const worker = new Worker(name, processor, {
    connection: { ...redis, maxRetriesPerRequest: null },
    concurrency,
    maxStartedAttempts,
  });
  worker.on('error', (err) => logger.error({ err, queue: name }, 'worker error'));
  const hooks = new Set(); // BullMQ does not wait for this listener, so close() does
  worker.on('failed', (job, err) => {
    if (!job || !onFinalFailure) return;
    const final = err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!final) return;
    const hook = onFinalFailure(job, err)
      .catch((hookErr) => logger.error({ err: hookErr, queue: name, jobId: job.id }, 'final-failure handler failed'))
      .finally(() => hooks.delete(hook));
    hooks.add(hook);
  });
  return {
    worker,
    async close() {
      await worker.close();
      await Promise.all(hooks);
    },
  };
}
