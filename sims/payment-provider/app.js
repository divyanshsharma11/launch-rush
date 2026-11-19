// Mock payment provider: internal HTTP API for our payment-mock connector.
import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_ID = /^pay_[0-9a-f]{32}$/; // same rule as the paysim.payments CHECK
const MAX_INT = 2_147_483_647; // amount_minor is a PostgreSQL integer

const CONFLICT = [409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request'];
const NOT_FOUND = [404, 'payment_not_found', 'payment not found'];
const NO_PAYMENT = { outcome: 'payment_not_found' }; // a malformed id cannot exist: no DB call
const REFUND_ERRORS = {
  conflict: CONFLICT,
  payment_not_found: NOT_FOUND,
  already_refunded: [409, 'already_refunded', 'payment already refunded'],
};

export function createProviderApp({ db, config, logger }) {
  const app = express();
  app.use(requireApiKey(config.apiKey, logger));
  app.use(express.json()); // after auth, so unauthorized bodies are never parsed

  const invalid = (req, res, reason) => {
    logger.warn({ method: req.method, url: req.originalUrl, reason }, 'provider request rejected');
    sendError(res, 400, 'invalid_request', reason);
  };

  app.post('/charges', async (req, res) => {
    const key = req.headers['idempotency-key'];
    const runId = req.headers['x-sim-run']?.toLowerCase() ?? null;
    const badRun = runId !== null && !UUID.test(runId);
    const problem = keyProblem(key) ?? (badRun ? 'X-Sim-Run must be a uuid' : chargeProblem(req.body));
    if (problem) return invalid(req, res, problem);

    const orderId = req.body.orderId.toLowerCase(); // as PostgreSQL returns it, so a replay is identical
    const { amountMinor, currency } = req.body;
    const payment = { id: `pay_${hex()}`, idempotencyKey: key, orderId, amountMinor, currency, runId };
    const eventId = `evt_${hex()}`;
    const body = JSON.stringify({
      id: eventId,
      type: 'payment.succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { paymentId: payment.id, orderId, amountMinor, currency },
    });

    // Run payments only: a share of them get the same webhook sent twice, to show duplicates blocked.
    const sends = runId !== null && Math.random() < config.runDuplicateShare ? 2 : 1;
    const { outcome, payment: saved } = await db.createCharge({ payment, event: { id: eventId, body }, sends });
    if (outcome === 'conflict') {
      logger.warn({ paymentId: saved.id, orderId }, 'charge rejected: idempotency conflict');
      return sendError(res, ...CONFLICT);
    }
    const replay = outcome === 'existing';
    const log = { paymentId: saved.id, orderId, runId: saved.runId, replay, ...(!replay && { webhookSends: sends }) };
    logger.info(log, replay ? 'charge replayed' : 'charge created');
    res.status(201).json({ paymentId: saved.id, orderId: saved.orderId, amountMinor: saved.amountMinor, currency: saved.currency });
  });

  app.post('/refunds', async (req, res) => {
    const key = req.headers['idempotency-key'];
    const problem = keyProblem(key) ?? refundProblem(req.body);
    if (problem) return invalid(req, res, problem);

    const { paymentId } = req.body;
    const refund = { id: `re_${hex()}`, idempotencyKey: key, paymentId };
    const { outcome, refund: saved } = await db.createRefund({ refund, eventId: `evt_${hex()}` });
    if (REFUND_ERRORS[outcome]) {
      logger.warn({ paymentId, outcome }, 'refund rejected');
      return sendError(res, ...REFUND_ERRORS[outcome]);
    }
    const replay = outcome === 'existing';
    logger.info({ refundId: saved.id, paymentId, replay }, replay ? 'refund replayed' : 'refund created');
    res.status(201).json({ refundId: saved.id, paymentId: saved.paymentId });
  });

  // No idempotency key: every call is meant to send the webhook again.
  app.post('/payments/:paymentId/resend-webhook', async (req, res) => {
    const { paymentId } = req.params;
    const { outcome, eventId } = PAYMENT_ID.test(paymentId) ? await db.resendWebhook(paymentId) : NO_PAYMENT;
    if (outcome === 'payment_not_found') {
      logger.warn({ paymentId, outcome }, 'resend rejected');
      return sendError(res, ...NOT_FOUND);
    }
    logger.info({ paymentId, eventId }, 'webhook resend queued');
    res.status(202).json({ eventId });
  });

  // Stripe's "process undelivered events" (design §6): failed deliveries of recent events are sent again.
  app.post('/deliveries/redeliver-failed', async (req, res) => {
    const maxAgeMs = req.body?.maxAgeMs;
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_INT) {
      return invalid(req, res, `maxAgeMs must be an integer from 1 to ${MAX_INT}`);
    }
    const redelivered = await db.redeliverFailed(maxAgeMs);
    if (redelivered > 0) logger.info({ redelivered }, 'failed webhook deliveries queued again');
    res.status(202).json({ redelivered });
  });

  app.get('/health', async (req, res) => {
    try {
      await db.ping();
    } catch (err) {
      logger.error({ err }, 'health check failed: database unreachable');
      return sendError(res, 503, 'unavailable', 'database unreachable');
    }
    res.json({ status: 'ok' });
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));

  // Express needs all 4 parameters to treat this as the error handler.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const request = { method: req.method, url: req.originalUrl };
    if (isClientError(err)) {
      logger.warn({ ...request, status: err.status, reason: err.message }, 'provider request rejected');
      return sendError(res, err.status, 'invalid_request', err.message);
    }
    logger.error({ ...request, err }, 'unhandled provider request error');
    sendError(res, 500, 'internal_error', 'internal error');
  });
  return app;
}

function keyProblem(key) {
  return key && key.length <= 255 ? null : 'Idempotency-Key header is required (1-255 characters)';
}

function chargeProblem(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (typeof body.orderId !== 'string' || !UUID.test(body.orderId)) return 'orderId must be a uuid';
  if (!Number.isInteger(body.amountMinor) || body.amountMinor < 0 || body.amountMinor > MAX_INT) {
    return `amountMinor must be an integer from 0 to ${MAX_INT}`;
  }
  if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) return 'currency must be 3 upper-case letters';
  return null;
}

function refundProblem(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (typeof body.paymentId !== 'string' || body.paymentId === '') return 'paymentId must be a non-empty string';
  if (!PAYMENT_ID.test(body.paymentId)) return 'paymentId must be pay_ followed by 32 lower-case hex characters';
  return null;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// body-parser and the router (a bad %-escape in a path) mark client errors with a 4xx status.
const isClientError = (err) => err.status >= 400 && err.status < 500;
const hex = () => randomBytes(16).toString('hex');

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

// Bearer API key, compared in constant time (hashed first: timingSafeEqual needs equal lengths).
function requireApiKey(apiKey, logger) {
  const expected = sha256(apiKey);
  return (req, res, next) => {
    const match = /^Bearer +(\S+)$/i.exec(req.headers.authorization ?? '');
    if (match && timingSafeEqual(sha256(match[1]), expected)) return next();
    logger.warn({ method: req.method, url: req.originalUrl }, 'provider request unauthorized');
    res.set('WWW-Authenticate', 'Bearer');
    sendError(res, 401, 'unauthorized', 'missing or invalid API key');
  };
}

const sha256 = (value) => createHash('sha256').update(value).digest();
