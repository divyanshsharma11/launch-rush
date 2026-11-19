// Order routes and the Duplicate resend. Needs req.sessionId (requireSession).
import express from 'express';
import { BusinessError } from '../business/errors.js';
import { handle } from './errors.js';

// No body is fine; a body that is not a JSON object is not.
export function bodyObject(req) {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new BusinessError('invalid_input', 'body must be a JSON object');
  return body;
}

export function createOrdersRouter({ orders }) {
  const router = express.Router();

  router.post('/orders', handle(async (req, res) => {
    res.status(201).json(await orders.buy(req.sessionId, bodyObject(req)));
  }));
  router.get('/orders', handle(async (req, res) => {
    res.json({ orders: await orders.listOrders(req.sessionId) });
  }));
  router.get('/orders/:id', handle(async (req, res) => {
    res.json(await orders.getOrder(req.sessionId, req.params.id));
  }));
  router.post('/orders/:id/pay', handle(async (req, res) => {
    const { email = null } = bodyObject(req);
    res.status(202).json(await orders.pay(req.sessionId, req.params.id, { email }));
  }));
  router.post('/orders/:id/resend-webhook', handle(async (req, res) => {
    await orders.resendWebhook(req.sessionId, req.params.id);
    res.status(202).end();
  }));
  return router;
}
