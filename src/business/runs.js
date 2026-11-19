// Demo runs: start, summary, faults, stop, the kill switch, closing and cleaning up runs.
import { BusinessError } from './errors.js';
import { UUID, isGameId } from './orders.js';

export const NO_FAULTS = { latencyMs: 0, down: false, rateLimitPerSec: 0, failureRate: 0 };
// Our own limits: latency up to the connector's 10 s timeout.
const FAULT_RANGES = { latencyMs: [0, 10_000], rateLimitPerSec: [0, 1000], failureRate: [0, 1] };

const invalid = (message) => new BusinessError('invalid_input', message);
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validFault(name, value) {
  if (name === 'down') return typeof value === 'boolean';
  const [min, max] = FAULT_RANGES[name];
  const whole = name === 'failureRate' || Number.isInteger(value);
  return typeof value === 'number' && whole && value >= min && value <= max;
}

export function parseFaults(input = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('faults must be an object');
  const faults = { ...NO_FAULTS };
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(NO_FAULTS, name)) throw invalid(`unknown fault ${name}`);
    if (!validFault(name, value)) throw invalid(`fault ${name} is out of range`);
    faults[name] = value;
  }
  return faults;
}

export function createRuns({ db, redis, erp, stockGate, runQueue, reconciler, config, logger }) {
  const caps = config.runs;
  const ctx = { timeoutMs: config.erp.callTimeoutMs };

  async function own(sessionId, runId) {
    const run = UUID.test(runId) ? await db.getRun(runId) : null;
    if (!run || run.sessionId !== sessionId) throw new BusinessError('not_found', 'run not found');
    return run;
  }

  // The run ends, then its waiting orders end. Safe to repeat: a crash between the two is finished by a retry.
  async function finish(run, status) {
    if (await db.endRun(run.id, status)) logger.info({ runId: run.id, status }, 'run ended');
    await stockGate.endWaits(await db.runWaitlisted(run.id));
  }

  async function gate(call) {
    try {
      return await call();
    } catch (err) {
      logger.error({ err }, 'redis unavailable for runs');
      throw new BusinessError('unavailable', 'stock gate unavailable');
    }
  }

  return {
    async start(sessionId, body = {}) {
      const { gameId, buyers, stock } = body;
      if (!isGameId(gameId)) throw invalid('gameId (string) is required');
      if (!isInt(buyers, 0, caps.maxBuyers)) throw invalid(`buyers must be a whole number from 0 to ${caps.maxBuyers}`);
      if (!isInt(stock, 0, buyers)) throw invalid('stock must be a whole number from 0 to buyers');
      const faults = parseFaults(body.faults);

      if (!(await gate(() => redis.rushEnabled()))) throw new BusinessError('rush_disabled', 'rush runs are switched off');
      const game = await db.getGame(gameId);
      if (!game?.listedInShop) throw new BusinessError('unknown_game', 'unknown game');

      const { outcome, run } = await db.insertRun({
        sessionId, gameId, stockTotal: stock, buyersRequested: buyers, faults, durationMs: caps.maxDurationMs,
        maxRunning: caps.maxRunning,
      });
      if (outcome === 'busy') throw new BusinessError('runs_busy', 'too many runs at the moment, try again soon');
      if (outcome === 'active') throw new BusinessError('run_active', 'you already have a run in progress');

      try {
        await gate(() => Promise.all([redis.initRunStock(run.id, stock), redis.setRunFaults(run.id, faults)]));
        if (stock > 0) await erp.execute('stock.add', { receiptId: `run-${run.id}`, itemCode: gameId, qty: stock, runId: run.id }, ctx);
        await runQueue.add(run.id);
      } catch (err) {
        await finish(run, 'stopped');
        throw err instanceof BusinessError ? err : new BusinessError('unavailable', 'could not start the run');
      }
      logger.info({ runId: run.id, gameId, buyers, stock }, 'run started');
      return { runId: run.id, endsAt: run.endsAt };
    },

    async summary(sessionId, runId) {
      return reconciler.runSummary(await own(sessionId, runId));
    },

    async setFaults(sessionId, runId, input) {
      const run = await own(sessionId, runId);
      const faults = parseFaults(input);
      if (!(await db.setRunFaults(run.id, faults))) throw new BusinessError('run_ended', 'run has ended');
      await gate(() => redis.setRunFaults(run.id, faults));
    },

    async stop(sessionId, runId) {
      await finish(await own(sessionId, runId), 'stopped');
    },

    // Kill switch: off = no new runs, and every running run stops.
    async setRushEnabled(enabled) {
      await gate(() => redis.setRushEnabled(enabled));
      if (enabled) return 0;
      const running = await db.listRunningRuns();
      for (const run of running) await finish(run, 'stopped');
      return running.length;
    },

    // Timer pass: runs whose time is up end as finished.
    async closeDue() {
      const due = await db.dueRuns(caps.cleanupBatch);
      for (const run of due) await finish(run, 'finished');
      return { runsFinished: due.length };
    },

    // Timer pass: ended runs older than cleanupAfterMs are deleted with their orders (cascade), Redis keys and ERP data.
    // A run whose ERP data cannot be deleted now stays for the next pass.
    async cleanup() {
      const ids = await db.endedRunsBefore(caps.cleanupAfterMs, caps.cleanupBatch);
      let deleted = 0;
      for (const id of ids) {
        try {
          await erp.execute('run.delete', { runId: id }, ctx);
        } catch (err) {
          logger.error({ err, runId: id }, 'run ERP data not deleted, will retry');
          continue;
        }
        await redis.deleteRun(id);
        await db.deleteRun(id);
        deleted += 1;
      }
      return { runsDeleted: deleted };
    },
  };
}
