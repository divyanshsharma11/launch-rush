// Express middleware: over the limit -> 429 rate_limited with Retry-After in whole seconds (RFC 9110 §10.2.3).
import { sendError } from './errors.js';

export function createRateLimit({ rateLimiter, scope, idOf }) {
  return async function rateLimit(req, res, next) {
    const result = await rateLimiter.check(scope, idOf(req));
    if (result.allowed) return next();
    res.set('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    sendError(res, 429, 'rate_limited', 'too many requests; try again later');
  };
}
