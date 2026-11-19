// API entry point. Ctrl+C or SIGTERM shuts it down cleanly.
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startApi } from './start-api.js';

const config = loadConfig(process.env);
const logger = createLogger(config.log);

try {
  const { shutdown } = await startApi({ config, logger });
  const onSignal = () =>
    shutdown().catch((err) => {
      logger.error({ err }, 'api shutdown failed');
      process.exitCode = 1;
    });
  // once: a second Ctrl+C gets Node's default handling and ends the process at once.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
} catch (err) {
  logger.fatal({ err }, 'api failed to start'); // e.g. EADDRINUSE
  process.exitCode = 1;
}
