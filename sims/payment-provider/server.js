// Mock payment provider entry point (npm run provider). Ctrl+C or SIGTERM shuts it down cleanly.
import { loadProviderConfig } from './config.js';
import { createLogger } from '../../src/logger.js';
import { startProvider } from './start.js';

const config = loadProviderConfig(process.env);
const logger = createLogger(config.log);

try {
  const { shutdown } = await startProvider({ config, logger });
  const onSignal = () =>
    shutdown().catch((err) => {
      logger.error({ err }, 'provider shutdown failed');
      process.exitCode = 1;
    });
  // once: a second Ctrl+C gets Node's default handling and ends the process at once.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
} catch (err) {
  logger.fatal({ err }, 'provider failed to start');
  process.exitCode = 1;
}
