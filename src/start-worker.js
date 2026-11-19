// Starts the BullMQ workers and the background timers, and returns their shutdown.
import { WaitingError } from 'bullmq';
import { closeAll } from './close-all.js';
import { createDb } from './services/db/index.js';
import { createRedis } from './services/redis/index.js';
import {
  createEmailQueue, createFulfilmentQueue, createRunQueue, createWebhookQueue, createWorker,
} from './services/queue/index.js';
import { createPaymentConnector } from './services/connectors/payment-mock.js';
import { createErpConnector } from './services/connectors/erp-sim.js';
import { createGmailConnector } from './services/connectors/email-gmail.js';
import { createMockEmailConnector } from './services/connectors/email-mock.js';
import { createBreakers } from './services/connectors/breaker.js';
import { createStockGate } from './business/waitlist-stock.js';
import { createEmail } from './business/email.js';
import { SENDER_NAME } from './business/email-content.js';
import { createFulfilment } from './business/fulfilment.js';
import { createOrders } from './business/orders.js';
import { createPaymentEvents } from './business/payment-events.js';
import { createReconciler } from './business/reconciler.js';
import { createRecovery } from './business/recovery.js';
import { createRedelivery } from './business/redelivery.js';
import { createRestock } from './business/restock.js';
import { createRuns } from './business/runs.js';
import { createRunDriver } from './business/run-driver.js';
import { createWebhookJob } from './jobs/webhook-job.js';
import { createFulfilmentJob } from './jobs/fulfilment-job.js';
import { createEmailJob } from './jobs/email-job.js';
import { createTimer } from './jobs/timer.js';

export async function startWorker({ config, logger }) {
  const redis = createRedis({ redis: config.redis, logger });
  const db = createDb({ logger, onOrderChange: (orderId, sessionId) => redis.notifyOrder(orderId, sessionId) });
  // A failed start (Redis or PostgreSQL unreachable) must not leave connections open: the process could not exit.
  try {
    await redis.ready();
    await redis.clearBreakerStates(); // left by a worker that was killed; this one starts with closed breakers
    await redis.initShopStock(await db.listShopGames());
  } catch (err) {
    await closeAll([() => redis.close(), () => db.close()]).catch(() => {});
    throw err;
  }

  // The streams show these states (design §8.3 breaker.state); the API's own breakers are not reported.
  const breakers = createBreakers({ settings: config.breaker, logger, onState: (state) => redis.setBreakerState(state) });
  const payment = breakers.protect(
    createPaymentConnector({ baseUrl: config.payment.providerUrl, apiKey: config.payment.apiKey }),
  );
  const erp = breakers.protect(createErpConnector(config.erp));
  const emailConnectors = {
    gmail: breakers.protect(createGmailConnector({ ...config.gmail, senderName: SENDER_NAME })),
    mock: breakers.protect(createMockEmailConnector()),
  };
  const fulfilmentQueue = createFulfilmentQueue({ redis: config.redis, jobOptions: config.webhookJob, logger });
  const emailQueue = createEmailQueue({ redis: config.redis, jobOptions: config.webhookJob, logger });
  const runQueue = createRunQueue({ redis: config.redis, logger });
  const webhookQueue = createWebhookQueue({ redis: config.redis, jobOptions: config.webhookJob, logger });
  const stockGate = createStockGate({ db, redis, config: config.stock, logger });
  const orders = createOrders({ db, redis, stockGate, payment, config, logger });
  const reconciler = createReconciler({ db, redis, config: config.reconciler });
  const runs = createRuns({ db, redis, erp, stockGate, runQueue, reconciler, config, logger });
  const restock = createRestock({ db, redis, erp, stockGate, config, logger });
  const paymentEvents = createPaymentEvents({ db, redis, payment, fulfilmentQueue, config: config.payment, logger });

  const webhookJob = createWebhookJob({ db, paymentEvents, classifyError: payment.classifyError });
  const webhooksWorker = createWorker({
    name: 'webhooks',
    redis: config.redis,
    processor: (job, token) => webhookJob.process(job, token),
    maxStartedAttempts: config.worker.maxStartedAttempts,
    onFinalFailure: (job, err) => webhookJob.onFinalFailure(job, err),
    logger,
  });

  const fulfilment = createFulfilment({ db, erp, emailQueue, config: config.erp, logger });
  const fulfilmentJob = createFulfilmentJob({ fulfilment, classifyError: erp.classifyError });
  const fulfilmentWorker = createWorker({
    name: 'fulfilment',
    redis: config.redis,
    concurrency: config.fulfilment.concurrency,
    maxStartedAttempts: config.worker.maxStartedAttempts,
    processor: (job, token) => fulfilmentJob.process(job, token),
    onFinalFailure: (job, err) => fulfilmentJob.onFinalFailure(job, err),
    logger,
  });

  const email = createEmail({ db, redis, connectors: emailConnectors, config: config.email, logger });
  const emailJob = createEmailJob({ email });
  const emailWorker = createWorker({
    name: 'email',
    redis: config.redis,
    concurrency: config.email.concurrency,
    maxStartedAttempts: config.worker.maxStartedAttempts,
    processor: (job, token) => emailJob.process(job, token),
    onFinalFailure: (job, err) => emailJob.onFinalFailure(job, err),
    logger,
  });

  const recovery = createRecovery({
    db, fulfilment, paymentEvents, fulfilmentQueue, webhookQueue, config: config.recovery, logger,
  });

  const redelivery = createRedelivery({ payment, config: config.redelivery, timeoutMs: config.payment.callTimeoutMs });

  const runDriver = createRunDriver({ db, orders, config, logger });
  const runsWorker = createWorker({
    name: 'runs',
    redis: config.redis,
    concurrency: config.runs.maxRunning,
    // On shutdown the signal is aborted; the job goes back to the queue and the next worker continues the run.
    processor: async (job, token, signal) => {
      if ((await runDriver.drive(job.data.runId, signal)) !== false) return;
      await job.moveToWait(token);
      throw new WaitingError();
    },
    logger,
  });

  const timers = [
    { name: 'sweeper', run: async () => stockGate.sweep(config.sweeper.batchSize), intervalMs: config.sweeper.intervalMs },
    { name: 'run-closer', run: () => runs.closeDue(), intervalMs: config.sweeper.intervalMs },
    { name: 'run-cleanup', run: () => runs.cleanup(), intervalMs: config.runs.cleanupAfterMs / 4 },
    { name: 'restock', run: () => restock.tick(), intervalMs: config.restock.intervalMs },
    { name: 'reconciler', run: () => reconciler.run(), intervalMs: config.reconciler.intervalMs },
    { name: 'recovery', run: () => recovery.run(), intervalMs: config.recovery.intervalMs },
    { name: 'redelivery', run: () => redelivery.run(), intervalMs: config.redelivery.intervalMs },
    { name: 'email-purge', run: () => email.purge(), intervalMs: config.email.purge.intervalMs },
  ].map((timer) => createTimer({ ...timer, logger }));
  for (const timer of timers) timer.start();
  logger.info('worker running');

  // BullMQ close() waits for the jobs in progress (BullMQ graceful shutdown docs); a job cut short by a kill is
  // picked up again as stalled. Resources are closed only after nothing can use them.
  async function stop() {
    logger.info('worker shutting down');
    runsWorker.worker.cancelAllJobs('worker shutting down');
    const workers = [webhooksWorker, fulfilmentWorker, emailWorker, runsWorker];
    try {
      await closeAll([...timers.map((timer) => () => timer.stop()), ...workers.map((w) => () => w.close())]);
    } finally {
      await closeAll([
        () => breakers.close(),
        () => fulfilmentQueue.close(),
        () => emailQueue.close(),
        () => runQueue.close(),
        () => webhookQueue.close(),
        () => redis.close(),
        () => db.close(),
      ]);
    }
    logger.info('worker stopped');
  }
  let stopping = null;
  return { shutdown: () => (stopping ??= stop()) };
}
