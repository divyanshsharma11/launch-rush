// Starts the mock payment provider (HTTP API + webhook delivery loop) and returns its shutdown.
import { once } from 'node:events';
import { createProviderDb } from './db.js';
import { createWebhookSigner } from './sign.js';
import { createDeliverer } from './deliver.js';
import { createProviderApp } from './app.js';

export async function startProvider({ config, logger }) {
  const db = createProviderDb({ logger });
  const deliverer = createDeliverer({ db, signer: createWebhookSigner({ secret: config.webhookSecret }), config, logger });
  const server = createProviderApp({ db, config, logger }).listen(config.port, config.host);
  try {
    await once(server, 'listening'); // rejects on a listen error, e.g. EADDRINUSE
  } catch (err) {
    await db.close();
    throw err;
  }
  deliverer.start();
  const { port } = server.address();
  logger.info({ host: config.host, port }, 'provider listening');

  // Stop taking requests, let the ones in flight and the current delivery batch finish, then close the DB.
  async function stop() {
    logger.info('provider shutting down');
    await Promise.all([new Promise((resolve) => server.close(resolve)), deliverer.stop()]);
    await db.close();
    logger.info('provider stopped');
  }
  let stopping = null;
  return { port, shutdown: () => (stopping ??= stop()) };
}
