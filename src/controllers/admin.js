// The /admin routes (design §5.4): owner only. A cookie-based login, so every call that changes something also checks
// the Origin header (a second guard against cross-site requests). No CORS headers: only the admin page, served from the
// backend's own origin, calls these.
import express from 'express';
import { handle, sendError, createInvalidInputHandler } from './errors.js';
import { createRateLimit } from './rate-limit.js';
import { bodyObject } from './orders.js';

const COOKIE = 'admin_session';
const COOKIE_PATH = '/admin';
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookieValue(req, name) {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

// origin: the backend's own origin, as browsers send it in Origin. A missing or "null" Origin never matches.
export function createAdminRouter({ auth, admin, replay, restock, runs, rateLimiter, origin, sessionTtlSeconds, logger }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json());

  router.use((req, res, next) => {
    if (READ_ONLY.has(req.method) || req.get('origin') === origin) return next();
    sendError(res, 403, 'bad_origin', 'request must come from the admin page');
  });

  router.post('/login', createRateLimit({ rateLimiter, scope: 'adminLogin', idOf: (req) => req.ip }), handle(async (req, res) => {
    const id = await auth.login(bodyObject(req).password);
    if (!id) {
      logger.warn({ ip: req.ip }, 'admin login failed');
      return sendError(res, 401, 'bad_credentials', 'wrong password');
    }
    logger.info({ ip: req.ip }, 'admin logged in');
    res.cookie(COOKIE, id, {
      httpOnly: true, secure: true, sameSite: 'strict', path: COOKIE_PATH, maxAge: sessionTtlSeconds * 1000,
    });
    res.status(204).end();
  }));

  router.use(async (req, res, next) => {
    req.adminSession = cookieValue(req, COOKIE);
    if (await auth.isLoggedIn(req.adminSession)) return next();
    sendError(res, 401, 'admin_required', 'log in first');
  });

  router.post('/logout', handle(async (req, res) => {
    await auth.logout(req.adminSession);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
    res.status(204).end();
  }));
  router.get('/health', handle(async (req, res) => {
    res.json(await admin.health());
  }));
  router.get('/scoreboard', handle(async (req, res) => {
    res.json({ scoreboard: await admin.scoreboard() });
  }));
  router.get('/deliveries', handle(async (req, res) => {
    if (req.query.status !== undefined && req.query.status !== 'failed') {
      return sendError(res, 400, 'invalid_input', 'status must be failed');
    }
    res.json({ deliveries: await replay.listFailed() });
  }));
  router.post('/deliveries/:id/replay', handle(async (req, res) => {
    await replay.replay(req.params.id);
    res.status(202).end();
  }));
  router.post('/stock/reset', handle(async (req, res) => {
    const { gameId = null } = bodyObject(req);
    res.status(202).json({ refilled: await restock.refill(gameId) });
  }));
  router.put('/rush', handle(async (req, res) => {
    const { enabled } = bodyObject(req);
    if (typeof enabled !== 'boolean') return sendError(res, 400, 'invalid_input', 'enabled must be true or false');
    await runs.setRushEnabled(enabled);
    res.status(204).end();
  }));
  router.put('/erp-sim/faults', handle(async (req, res) => {
    await admin.setErpFaults(bodyObject(req));
    res.status(204).end();
  }));

  router.use(createInvalidInputHandler({ logger, hideReason: true }));
  return router;
}
