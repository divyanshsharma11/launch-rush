// Starts the API: wires config, services, business and controllers, listens, and returns its shutdown.
import { once } from 'node:events';
import express from 'express';
import { closeAll } from './close-all.js';
import { createDb } from './services/db/index.js';
import { createEmailQueue, createFulfilmentQueue, createRunQueue, createWebhookQueue } from './services/queue/index.js';
import { createRedis } from './services/redis/index.js';
import { createWakeups } from './services/redis/wakeups.js';
import { createInboundVerifier, createPaymentConnector } from './services/connectors/payment-mock.js';
import { createErpConnector } from './services/connectors/erp-sim.js';
import { createGmailConnector } from './services/connectors/email-gmail.js';
import { createMockEmailConnector } from './services/connectors/email-mock.js';
import { createBreakers } from './services/connectors/breaker.js';
import { createAdmin } from './business/admin.js';
import { createAdminAuth } from './business/admin-auth.js';
import { SENDER_NAME } from './business/email-content.js';
import { createReplay } from './business/replay.js';
import { createRestock } from './business/restock.js';
import { createPayments } from './business/payments.js';
import { createStockGate } from './business/waitlist-stock.js';
import { createOrders } from './business/orders.js';
import { createRateLimiter } from './business/rate-limit.js';
import { createReconciler } from './business/reconciler.js';
import { createRuns } from './business/runs.js';
import { createStream } from './business/stream.js';
import { createWebhookRouter } from './controllers/webhook.js';
import { createAdminRouter } from './controllers/admin.js';
import { createAdminPage } from './controllers/admin-page.js';
import { createApiRouter } from './controllers/api.js';
import { createStreamRouter } from './controllers/stream.js';
import { createErrorHandler, notFound } from './controllers/errors.js';

export async function startApi({ config, logger }) {
  const redis = createRedis({ redis: config.redis, logger });
  const db = createDb({ logger, onOrderChange: (orderId, sessionId) => redis.notifyOrder(orderId, sessionId) });
  const webhookQueue = createWebhookQueue({ redis: config.redis, jobOptions: config.webhookJob, logger });
  const runQueue = createRunQueue({ redis: config.redis, logger });
  const breakers = createBreakers({ settings: config.breaker, logger });
  const wakeups = createWakeups({ redis: config.redis, logger });
  // The admin API (design §5.4) also replays failed jobs, so it needs the fulfilment and email queues; without admin
  // settings they are not created.
  const adminQueues = config.admin
    ? {
        fulfilment: createFulfilmentQueue({ redis: config.redis, jobOptions: config.webhookJob, logger }),
        email: createEmailQueue({ redis: config.redis, jobOptions: config.webhookJob, logger }),
      }
    : {};
  const closeResources = () =>
    closeAll([
      () => breakers.close(), () => webhookQueue.close(), () => runQueue.close(), () => wakeups.close(), () => redis.close(),
      () => db.close(), ...Object.values(adminQueues).map((queue) => () => queue.close()),
    ]);

  // A failed start (Redis, PostgreSQL, a port in use) must not leave connections open: the process could not exit.
  try {
    return await listen({ config, logger, db, webhookQueue, redis, wakeups, runQueue, breakers, adminQueues, closeResources });
  } catch (err) {
    await closeResources().catch((closeErr) => logger.error({ err: closeErr }, 'closing after a failed start failed'));
    throw err;
  }
}

async function listen({ config, logger, db, webhookQueue, redis, wakeups, runQueue, breakers, adminQueues, closeResources }) {
  // Before the first Redis connection, add() would wait forever, so wait here.
  // No time limit: failed attempts are logged, and the port opens only once Redis is ready.
  logger.info('waiting for redis');
  await webhookQueue.ready();
  await redis.ready();
  await wakeups.ready();
  await Promise.all(Object.values(adminQueues).map((queue) => queue.ready()));
  await redis.initShopStock(await db.listShopGames());

  const verifier = createInboundVerifier({
    secret: config.payment.webhookSecret,
    toleranceSeconds: config.payment.webhookToleranceSeconds,
  });
  const payments = createPayments({ verifier, db, webhookQueue, logger });
  const payment = breakers.protect(
    createPaymentConnector({ baseUrl: config.payment.providerUrl, apiKey: config.payment.apiKey }),
  );
  const erp = breakers.protect(createErpConnector(config.erp));
  const stockGate = createStockGate({ db, redis, config: config.stock, logger });
  const orders = createOrders({ db, redis, stockGate, payment, config, logger });
  const rateLimiter = createRateLimiter({ redis, limits: config.rateLimits, logger });
  const reconciler = createReconciler({ db, redis, config: config.reconciler });
  const runs = createRuns({ db, redis, erp, stockGate, runQueue, reconciler, config, logger });
  const stream = createStream({ db, redis, wakeups, reconciler, config: config.stream, logger });
  const streamRouter = createStreamRouter({ orders, stream, config: config.stream, logger });

  const app = express();
  app.set('trust proxy', config.api.trustProxy);
  app.use(createWebhookRouter({ payments, logger })); // before express.json(): raw body for the signature
  app.use('/api', createApiRouter({ orders, runs, rateLimiter, cors: config.cors, streamRouter, logger }));
  if (config.admin) {
    app.use('/admin', createAdminPage({ dir: config.admin.pageDir })); // before the routes: the page loads without a login
    app.use('/admin', createAdminRouter({
      auth: createAdminAuth({ admin: config.admin, redis }),
      admin: createAdmin({
        redis,
        connectors: {
          payment,
          erp,
          gmail: createGmailConnector({ ...config.gmail, senderName: SENDER_NAME }),
          mock: createMockEmailConnector(),
        },
        queues: { webhooks: webhookQueue, ...adminQueues, runs: runQueue },
        logger,
      }),
      replay: createReplay({ db, fulfilmentQueue: adminQueues.fulfilment, webhookQueue, emailQueue: adminQueues.email }),
      restock: createRestock({ db, redis, erp, stockGate, config, logger }),
      runs,
      rateLimiter,
      origin: config.admin.origin,
      sessionTtlSeconds: config.admin.sessionTtlSeconds,
      logger,
    }));
  }
  app.use(notFound);
  app.use(createErrorHandler({ logger })); // last

  const { host, port } = config.api;
  const server = app.listen(port, host);
  await once(server, 'listening'); // rejects on a listen error, e.g. EADDRINUSE
  logger.info({ host, port, admin: Boolean(config.admin) }, 'api listening'); // admin: off until ADMIN_PASSWORD_HASH is set

  // Stop taking requests and let the ones in flight finish (Express graceful shutdown), then close the connections.
  // Open streams never finish by themselves, so they are ended first; their pages reconnect to the next API.
  async function stop() {
    logger.info('api shutting down');
    try {
      const closed = new Promise((resolve) => server.close(resolve));
      streamRouter.endAll();
      await closed;
    } finally {
      await closeResources();
    }
    logger.info('api stopped');
  }
  let stopping = null;
  return { port: server.address().port, shutdown: () => (stopping ??= stop()) };
}
