// Anonymous visitor sessions: POST /api/session, and the X-Session-Id check for every other /api call.
import express from 'express';
import { handle, sendError } from './errors.js';

export function createSessionRouter({ orders }) {
  const router = express.Router();
  router.post('/session', handle(async (req, res) => {
    res.status(201).json({ sessionId: await orders.createSession() });
  }));
  return router;
}

export function createRequireSession({ orders }) {
  return async function requireSession(req, res, next) {
    const id = req.get('x-session-id');
    if (!id || !(await orders.sessionExists(id))) {
      return sendError(res, 401, 'session_required', 'missing or unknown X-Session-Id; create a session first');
    }
    req.sessionId = id.toLowerCase(); // PostgreSQL returns uuids in lower case; the business layer compares strings
    next();
  };
}
