// Circuit breakers around connectors (opossum). One breaker per connector for shop orders and one per connector per
// demo run, picked by ctx.runId, so a run's faults trip only that run's breaker.
import CircuitBreaker from 'opossum';

const RETRYABLE = Object.freeze({ kind: 'retryable' });

// settings: { timeoutMs, errorThresholdPercentage, resetTimeoutMs, volumeThreshold, rollingCountTimeoutMs, runIdleMs }
// onState({ connector, runId, state }): called when a breaker opens, half-opens or closes ('open' | 'halfOpen' |
// 'closed'), and with state null when its entry is dropped. It must not throw or reject.
export function createBreakers({ settings, logger, onState = () => {} }) {
  const entries = new Map(); // `${connectorId}:${runId or 'shared'}` -> { breaker, idle, fields }

  function create(connector, runId) {
    const breaker = new CircuitBreaker((action, payload, ctx) => connector.execute(action, payload, ctx), {
      timeout: settings.timeoutMs,
      errorThresholdPercentage: settings.errorThresholdPercentage,
      resetTimeout: settings.resetTimeoutMs,
      volumeThreshold: settings.volumeThreshold,
      rollingCountTimeout: settings.rollingCountTimeoutMs,
      // A permanent error is bad data or a bug, not a sign that the upstream is down.
      errorFilter: (err) => connector.classifyError(err).kind === 'permanent',
    });
    const fields = { connector: connector.id, runId };
    breaker.on('open', () => {
      logger.warn(fields, 'breaker open');
      onState({ ...fields, state: 'open' });
    });
    breaker.on('halfOpen', () => {
      logger.info(fields, 'breaker half-open');
      onState({ ...fields, state: 'halfOpen' });
    });
    breaker.on('close', () => {
      logger.info(fields, 'breaker closed');
      onState({ ...fields, state: 'closed' });
    });
    return { breaker, fields };
  }

  function evict(key) {
    const entry = entries.get(key);
    entry?.breaker.shutdown();
    entries.delete(key);
    if (entry) onState({ ...entry.fields, state: null });
  }

  function breakerFor(connector, runId) {
    const key = `${connector.id}:${runId ?? 'shared'}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { ...create(connector, runId ?? null), idle: null };
      entries.set(key, entry);
    }
    if (runId) {
      // A run's breaker is dropped once nobody has used it for runIdleMs.
      clearTimeout(entry.idle);
      entry.idle = setTimeout(() => evict(key), settings.runIdleMs).unref();
    }
    return entry.breaker;
  }

  return {
    // Same interface as the connector it wraps: only execute goes through a breaker.
    protect: (connector) => ({
      id: connector.id,
      capabilities: connector.capabilities,
      execute: (action, payload, ctx) => breakerFor(connector, ctx.runId).fire(action, payload, ctx),
      classifyError(err) {
        if (CircuitBreaker.isOurError(err)) {
          if (err.code === 'EOPENBREAKER') return { kind: 'rateLimited', retryAfterMs: settings.resetTimeoutMs };
          if (err.code === 'ETIMEDOUT') return RETRYABLE;
        }
        return connector.classifyError(err);
      },
      healthCheck: () => connector.healthCheck(),
    }),

    states: () =>
      [...entries.entries()].map(([key, { breaker }]) => {
        const [connector, runId] = key.split(':');
        return { connector, runId: runId === 'shared' ? null : runId, state: breaker.opened ? 'open' : breaker.halfOpen ? 'halfOpen' : 'closed' };
      }),

    close() {
      for (const key of [...entries.keys()]) {
        clearTimeout(entries.get(key).idle);
        evict(key);
      }
    },
  };
}
