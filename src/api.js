// API entry point: wires config, services, business and controllers, then listens.
import express from 'express';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDb } from './services/db/index.js';
import { createWebhookQueue } from './services/queue/index.js';
import { createInboundVerifier } from './services/connectors/payment-mock.js';
import { createPayments } from './business/payments.js';
import { createWebhookRouter } from './controllers/webhook.js';
import { createErrorHandler, notFound } from './controllers/errors.js';

const config = loadConfig(process.env);
const logger = createLogger(config.log);

const db = createDb({ logger });
const webhookQueue = createWebhookQueue({ redis: config.redis, jobOptions: config.webhookJob, logger });

// Before the first Redis connection, add() would wait forever, so wait here.
// No time limit (owner decision): failed attempts are logged, and the port opens only once Redis is ready.
logger.info('waiting for redis');
await webhookQueue.ready();

const verifier = createInboundVerifier({
  secret: config.payment.webhookSecret,
  toleranceSeconds: config.payment.webhookToleranceSeconds,
});
const payments = createPayments({ verifier, db, webhookQueue, logger });

const app = express();
app.use(createWebhookRouter({ payments, logger })); // before express.json(): raw body for the signature
app.use(notFound);
app.use(createErrorHandler({ logger })); // last

const { host, port } = config.api;
app.listen(port, host, (err) => {
  if (err) {
    logger.fatal({ err }, 'api failed to listen'); // e.g. EADDRINUSE
    process.exit(1);
  }
  logger.info({ host, port }, 'api listening');
});
