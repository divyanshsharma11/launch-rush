// ERP simulator entry point (npm run erp-sim). Ctrl+C or SIGTERM shuts it down cleanly.
import { loadErpSimConfig } from './config.js';
import { createLogger } from '../../src/logger.js';
import { startErpSimulator } from './start.js';

const config = loadErpSimConfig(process.env);
const logger = createLogger(config.log);

try {
  const { shutdown } = await startErpSimulator({ config, logger });
  const onSignal = () =>
    shutdown().catch((err) => {
      logger.error({ err }, 'erp simulator shutdown failed');
      process.exitCode = 1;
    });
  // once: a second Ctrl+C gets Node's default handling and ends the process at once.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
} catch (err) {
  logger.fatal({ err }, 'erp simulator failed to start');
  process.exitCode = 1;
}
