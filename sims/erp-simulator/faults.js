// The simulator's break-it controls. Settings live in Redis: `faults:<runId>` for a demo run's calls,
// `faults:shared` for every other call. A call is delayed, or refused with 503, 429 or 500.
const NONE = Object.freeze({ latencyMs: 0, down: false, rateLimitPerSec: 0, failureRate: 0 });

const key = (scope) => (scope === 'shop' ? 'faults:shared' : `faults:${scope.slice('run:'.length)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFaults({ redis, logger, random = Math.random, now = Date.now }) {
  const windows = new Map(); // scope -> { second, count }

  // If the settings cannot be read, calls go through: the ERP's own work does not depend on the demo's controls.
  async function read(scope) {
    try {
      const raw = await redis.get(key(scope));
      return raw ? { ...NONE, ...JSON.parse(raw) } : NONE;
    } catch (err) {
      logger.error({ err, scope }, 'fault settings unreadable');
      return NONE;
    }
  }

  function overLimit(scope, limit) {
    const second = Math.floor(now() / 1000);
    const window = windows.get(scope);
    if (window?.second === second) window.count += 1;
    else windows.set(scope, { second, count: 1 });
    return windows.get(scope).count > limit;
  }

  return {
    // null: the call goes ahead. Otherwise the refusal: { status, excType, message, retryAfter? }.
    async check(scope) {
      const faults = await read(scope);
      if (faults.latencyMs > 0) await sleep(faults.latencyMs);
      if (faults.down) return { status: 503, excType: 'ServiceUnavailable', message: 'ERP is down' };
      if (faults.rateLimitPerSec > 0 && overLimit(scope, faults.rateLimitPerSec)) {
        return { status: 429, excType: 'TooManyRequests', message: 'Too many requests', retryAfter: 1 };
      }
      if (faults.failureRate > 0 && random() < faults.failureRate) {
        return { status: 500, excType: 'InternalServerError', message: 'Random failure' };
      }
      return null;
    },

    async isDown() {
      return (await read('shop')).down === true;
    },
  };
}
