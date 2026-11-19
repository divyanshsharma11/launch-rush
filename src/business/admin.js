// What only the owner may do besides replay and refill (design §5.4): the health view, ERP faults for the shop.
import { BusinessError } from './errors.js';
import { NO_FAULTS, parseFaults } from './runs.js';

// connectors: the four connectors by any key; queues: name -> queue with counts().
export function createAdmin({ redis, connectors, queues, logger }) {
  async function gate(call) {
    try {
      return await call();
    } catch (err) {
      logger.error({ err }, 'redis unavailable for admin');
      throw new BusinessError('unavailable', 'redis unavailable');
    }
  }

  return {
    // Each connector's own health check and its shared circuit breaker. The worker reports a breaker only when it
    // changes state, so a connector with no entry has never opened one since the worker started: closed.
    // Also the two settings the page toggles, so it can show what is set now.
    async health() {
      const [states, rushEnabled, erpFaults] = await gate(() =>
        Promise.all([redis.breakerStates(), redis.rushEnabled(), redis.sharedFaults()]));
      const stateOf = (id) => states.find((s) => s.connector === id && s.runId === null)?.state ?? 'closed';
      const names = Object.keys(queues);
      const [connectorList, counts] = await Promise.all([
        Promise.all(Object.values(connectors).map(async (c) => ({ id: c.id, healthy: await c.healthCheck(), breaker: stateOf(c.id) }))),
        gate(() => Promise.all(names.map((name) => queues[name].counts()))),
      ]);
      return {
        connectors: connectorList,
        queues: Object.fromEntries(names.map((name, i) => [name, counts[i]])),
        rushEnabled,
        erpFaults: { ...NO_FAULTS, ...erpFaults },
      };
    },

    // The reconciler's latest result (the public scoreboard), or null before its first pass.
    scoreboard: () => gate(() => redis.loadScoreboard()),

    // The ERP simulator's faults for shop orders. An empty object clears them (every fault back to off).
    async setErpFaults(input) {
      const faults = parseFaults(input);
      await gate(() => redis.setSharedFaults(faults));
    },
  };
}
