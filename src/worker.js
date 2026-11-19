// Worker entry point: BullMQ workers and the background timers. Run: npm run worker
// Ctrl+C or SIGTERM shuts it down cleanly.
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWorker } from './start-worker.js';

const config = loadConfig(process.env);
const logger = createLogger(config.log);

try {
  const { shutdown } = await startWorker({ config, logger });
  const onSignal = () =>
    shutdown().catch((err) => {
      logger.error({ err }, 'worker shutdown failed');
      process.exitCode = 1;
    });
  // once: a second Ctrl+C gets Node's default handling and ends the process at once.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  process.exitCode = 1;
}
