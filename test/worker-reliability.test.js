// Retry, delay and start limits of createWorker, against the real Redis container (unique queue names, obliterated).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DelayedError, Queue, UnrecoverableError, WaitingError } from 'bullmq';
import { loadConfig } from '../src/config.js';
import { createWorker } from '../src/services/queue/index.js';
import { captureLogger } from './helpers.js';

const config = loadConfig({
  ...process.env,
  PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32),
});
const { logger } = captureLogger();
const cleanups = [];

// A queue and a worker on it. onFinal collects the jobs the final-failure hook saw.
function setup({ processor, maxStartedAttempts, jobOptions = {} }) {
  const name = `reliability-test-${randomUUID()}`;
  const queue = new Queue(name, { connection: config.redis });
  const finals = [];
  const { worker, close } = createWorker({
    name,
    redis: config.redis,
    processor,
    maxStartedAttempts,
    onFinalFailure: async (job, err) => finals.push({ id: job.id, message: err.message, name: err.name }),
    logger,
  });
  cleanups.push(async () => {
    await close();
    await queue.obliterate({ force: true });
    await queue.close();
  });
  const add = (id) => queue.add('test', {}, { jobId: id, attempts: 5, backoff: { type: 'exponential', delay: 20, jitter: 0.5 }, ...jobOptions });
  return { queue, worker, add, finals };
}

const until = async (check) => {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached in 5 s');
};

after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

test('a retryable error is retried with backoff until it works; the final hook is not called', async () => {
  let calls = 0;
  const { add, queue, finals } = setup({
    processor: async () => {
      calls += 1;
      if (calls < 3) throw new Error('upstream 503');
    },
  });
  const job = await add('retry-then-ok');
  await until(async () => (await queue.getJob(job.id)) === undefined || (await job.isCompleted()));
  assert.equal(calls, 3);
  assert.deepEqual(finals, []);
});

test('attempts used up: the final hook is called once and the job stays in the failed set', async () => {
  const { add, queue, finals } = setup({ processor: async () => { throw new Error('upstream 503'); } });
  await add('always-fails');
  await until(() => finals.length === 1);
  const job = await queue.getJob('always-fails');
  assert.equal(await job.getState(), 'failed');
  assert.equal(job.attemptsMade, 5);
  assert.equal(finals[0].message, 'upstream 503');
});

test('an UnrecoverableError stops at once: one attempt, final hook called', async () => {
  const { add, queue, finals } = setup({
    processor: async () => { throw new UnrecoverableError('bad data'); },
  });
  await add('permanent');
  await until(() => finals.length === 1);
  assert.equal((await queue.getJob('permanent')).attemptsMade, 1);
});

test('a delayed job does not use up attempts; maxStartedAttempts then fails it for replay', async () => {
  const { add, queue, finals } = setup({
    maxStartedAttempts: 4,
    processor: async (job, token) => {
      await job.moveToDelayed(Date.now() + 20, token);
      throw new DelayedError();
    },
  });
  await add('delayed-forever');
  await until(() => finals.length === 1);
  const job = await queue.getJob('delayed-forever');
  assert.equal(await job.getState(), 'failed');
  assert.equal(job.attemptsMade, 1); // only the final failure counts as an attempt
  assert.equal(job.attemptsStarted, 5);
  assert.equal(finals[0].message, 'job started more than allowable limit');
  assert.equal(finals[0].name, 'UnrecoverableError');
});

test('replay of a failed job needs both counters reset, or it fails again at once', async () => {
  let fail = true;
  const { add, queue, finals } = setup({
    maxStartedAttempts: 2,
    processor: async (job, token) => {
      if (!fail) return;
      await job.moveToDelayed(Date.now() + 20, token);
      throw new DelayedError();
    },
  });
  await add('replayed');
  await until(() => finals.length === 1);
  fail = false;

  const onlyAttempts = await queue.getJob('replayed');
  await onlyAttempts.retry('failed', { resetAttemptsMade: true });
  await until(() => finals.length === 2);
  assert.equal(finals[1].message, 'job started more than allowable limit');

  const both = await queue.getJob('replayed');
  await both.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
  await until(async () => (await queue.getJob('replayed')) === undefined || (await (await queue.getJob('replayed')).isCompleted()));
});

test('shutdown gives a running job back to the queue, and the next worker continues it', async () => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const { worker, queue, add } = setup({
    processor: async (job, token, signal) => {
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      await job.moveToWait(token);
      throw new WaitingError();
    },
  });
  await add('long-run');
  await running;

  worker.cancelAllJobs('shutdown');
  await worker.close();
  assert.equal(await (await queue.getJob('long-run')).getState(), 'waiting');

  const next = createWorker({ name: queue.name, redis: config.redis, processor: async () => 'done', logger });
  cleanups.push(() => next.close());
  await until(async () => (await queue.getJob('long-run')).isCompleted());
});
