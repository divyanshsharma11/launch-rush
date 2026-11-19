// A background job on a timer (sweeper, reconciler, run cleanup). A setTimeout chain, so ticks never overlap.
// run(): one pass; a failing pass is logged and the next one still runs. Its result is logged when it is not empty.
export function createTimer({ name, run, intervalMs, logger }) {
  let timer = null;
  let running = Promise.resolve();
  let stopped = true;

  async function tick() {
    try {
      const result = await run();
      if (result && Object.values(result).some(Boolean)) logger.info({ job: name, ...result }, 'job pass');
    } catch (err) {
      logger.error({ err, job: name }, 'job pass failed');
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().then(schedule);
    }, intervalMs);
  }

  return {
    start() {
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
