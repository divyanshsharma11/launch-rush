// The /api router: JSON bodies, then the public session route, then the session check for the rest.
import express from 'express';
import { createCors } from './cors.js';
import { createInvalidInputHandler } from './errors.js';
import { createRateLimit } from './rate-limit.js';
import { createRequireSession, createSessionRouter } from './session.js';
import { createGamesRouter } from './games.js';
import { createOrdersRouter } from './orders.js';
import { createRunsRouter } from './runs.js';

// rateLimiter: without one nothing is limited; cors: without it no CORS headers; streamRouter (controllers/stream.js):
// without it no /stream route (start-api.js always passes all three).
export function createApiRouter({
  orders, runs, rateLimiter = { check: async () => ({ allowed: true }) }, cors, streamRouter, logger,
}) {
  const router = express.Router();
  if (cors) router.use(createCors(cors));
  router.use(express.json());
  router.post('/session', createRateLimit({ rateLimiter, scope: 'sessionCreate', idOf: (req) => req.ip }));
  router.use(createSessionRouter({ orders }));
  if (streamRouter) router.use(streamRouter);
  router.use(createRequireSession({ orders }));
  router.use(createRateLimit({ rateLimiter, scope: 'session', idOf: (req) => req.sessionId }));
  router.use(createGamesRouter({ orders }));
  router.use(createOrdersRouter({ orders }));
  router.use(createRunsRouter({ runs }));
  router.use(createInvalidInputHandler({ logger }));
  return router;
}
