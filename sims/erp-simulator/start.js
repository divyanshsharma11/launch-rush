// Starts the ERP simulator (HTTP API) and returns its shutdown.
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { createErpSimDb } from './db.js';
import { createFaults } from './faults.js';
import { createErpSimApp } from './app.js';

export async function startErpSimulator({ config, logger }) {
  const db = createErpSimDb({ logger });
  // Fails fast while Redis is down (no offline queue, 1 retry per command): fault settings are then read as "none".
  const redis = new Redis({ ...config.redis, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  redis.on('error', (err) => logger.error({ err }, 'erp simulator redis error'));
  const faults = createFaults({ redis, logger });

  const server = createErpSimApp({ db, faults, config, logger }).listen(config.port, config.host);
  try {
    await once(server, 'listening'); // rejects on a listen error, e.g. EADDRINUSE
  } catch (err) {
    redis.disconnect();
    await db.close();
    throw err;
  }
  const { port } = server.address();
  logger.info({ host: config.host, port }, 'erp simulator listening');

  // Stop taking requests and let the ones in flight finish, then close the DB and Redis.
  async function stop() {
    logger.info('erp simulator shutting down');
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    if (redis.status === 'ready') await redis.quit();
    else redis.disconnect();
    logger.info('erp simulator stopped');
  }
  let stopping = null;
  return { port, shutdown: () => (stopping ??= stop()) };
}
