// POST /webhooks/payment (design §5.2).
import express from 'express';
import { sendError } from './errors.js';

const CLIENT_ERRORS = new Set(['invalid_signature', 'invalid_payload']);

// Mount before express.json(): the signature is checked on the untouched raw body.
export function createWebhookRouter({ payments, logger }) {
  const reject = (res, code, reason) => {
    logger.warn({ code, reason }, 'payment webhook rejected');
    sendError(res, 400, code, reason);
  };

  const router = express.Router();
  router.post('/webhooks/payment', express.raw({ type: 'application/json' }), async (req, res) => {
    // req.body is undefined when there is no body or the type is not application/json.
    if (!Buffer.isBuffer(req.body)) return reject(res, 'invalid_payload', 'expected an application/json body');

    try {
      await payments.receiveWebhook(req.body, req.headers);
    } catch (err) {
      if (!CLIENT_ERRORS.has(err.code)) throw err; // errorHandler replies 500, so the provider retries
      return reject(res, err.code, err.message);
    }
    res.json({ received: true });
  });
  return router;
}
