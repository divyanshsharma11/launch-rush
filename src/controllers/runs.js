// Demo run routes. Needs req.sessionId (requireSession).
import express from 'express';
import { handle } from './errors.js';
import { bodyObject } from './orders.js';

export function createRunsRouter({ runs }) {
  const router = express.Router();

  router.post('/runs', handle(async (req, res) => {
    res.status(201).json(await runs.start(req.sessionId, bodyObject(req)));
  }));
  router.get('/runs/:id', handle(async (req, res) => {
    res.json(await runs.summary(req.sessionId, req.params.id));
  }));
  router.put('/runs/:id/faults', handle(async (req, res) => {
    await runs.setFaults(req.sessionId, req.params.id, bodyObject(req));
    res.status(204).end();
  }));
  router.post('/runs/:id/stop', handle(async (req, res) => {
    await runs.stop(req.sessionId, req.params.id);
    res.status(204).end();
  }));
  return router;
}
