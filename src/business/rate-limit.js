// Request limits (design §5 conventions): a fixed window per key, counted in Redis.
export function createRateLimiter({ redis, limits, logger }) {
  return {
    // scope: a key of `limits`; id: the IP (session creation) or the session id. If Redis cannot be reached the
    // request is allowed: the limiter protects the service, and the stock gate itself refuses sales without Redis.
    async check(scope, id) {
      const { limit, windowMs } = limits[scope];
      try {
        const { count, resetMs } = await redis.hit(`ratelimit:${scope}:${id}`, windowMs);
        return count > limit ? { allowed: false, retryAfterMs: resetMs } : { allowed: true };
      } catch (err) {
        logger.error({ err, scope }, 'rate limiter unavailable, request allowed');
        return { allowed: true };
      }
    },
  };
}
