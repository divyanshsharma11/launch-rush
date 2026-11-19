// Background job timer: runs passes on its own and stops cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimer } from '../src/jobs/timer.js';
import { captureLogger } from './helpers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('passes repeat; a failing pass is logged and the next one still runs; a non-empty result is logged', async () => {
  const { logger, lines } = captureLogger();
  let calls = 0;
  const timer = createTimer({
    name: 'sweep',
    intervalMs: 10,
    logger,
    run: async () => {
      calls += 1;
      if (calls === 1) throw new Error('db down');
      return { expired: 1, waitsEnded: 0 };
    },
  });
  timer.start();
  while (calls < 3) await wait(5);
  await timer.stop();

  assert.ok(lines.some((line) => line.msg === 'job pass failed' && line.job === 'sweep' && line.err.message === 'db down'));
  assert.ok(lines.some((line) => line.msg === 'job pass' && line.job === 'sweep' && line.expired === 1));
});

test('an all-zero result is not logged', async () => {
  const { logger, lines } = captureLogger();
  let calls = 0;
  const timer = createTimer({
    name: 'sweep',
    intervalMs: 5,
    logger,
    run: async () => {
      calls += 1;
      return { expired: 0 };
    },
  });
  timer.start();
  while (calls < 2) await wait(5);
  await timer.stop();
  assert.equal(lines.filter((line) => line.msg === 'job pass').length, 0);
});

test('stop waits for the pass in progress and no pass starts afterwards', async () => {
  const { logger } = captureLogger();
  let finished = false;
  let calls = 0;
  const timer = createTimer({
    name: 'slow',
    intervalMs: 10,
    logger,
    run: async () => {
      calls += 1;
      await wait(60);
      finished = true;
    },
  });
  timer.start();
  while (calls === 0) await wait(5);
  await timer.stop();
  assert.equal(finished, true);
  await wait(50);
  assert.equal(calls, 1);
});
