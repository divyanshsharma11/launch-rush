// Webhook queue (design §5.2 step 4) against the real Redis container (plan §14 item 11).
// A unique queue name per run; obliterate() removes it at the end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { loadConfig } from '../src/config.js';
import { createWebhookQueue } from '../src/services/queue/index.js';
import { captureLogger } from './helpers.js';

const config = loadConfig({ ...process.env, PAYMENT_WEBHOOK_SECRET: 'a'.repeat(32) });
const name = `webhooks-test-${randomUUID()}`;
const { logger } = captureLogger();
const webhooks = createWebhookQueue({ redis: config.redis, jobOptions: config.webhookJob, logger, name });
const inspect = new Queue(name, { connection: config.redis }); // test-only reader

before(() => webhooks.ready());

after(async () => {
  await inspect.obliterate({ force: true });
  await inspect.close();
  await webhooks.close();
});

test('the same event id added twice gives one job', async () => {
  const first = await webhooks.add('evt_dup');
  const second = await webhooks.add('evt_dup');
  assert.equal(first.id, 'evt_dup');
  assert.equal(second.id, 'evt_dup');
  assert.equal((await inspect.getJobCounts('waiting')).waiting, 1);
});

test('job data is only the event id, and the job options come from config', async () => {
  await webhooks.add('evt_opts');
  const job = await inspect.getJob('evt_opts');
  assert.deepEqual(job.data, { eventId: 'evt_opts' });
  assert.equal(job.opts.attempts, 5);
  assert.deepEqual(job.opts.backoff, { type: 'exponential', delay: 2000, jitter: 0.5 });
  assert.equal(job.opts.removeOnComplete, true);
  assert.deepEqual(job.opts.removeOnFail, { count: 5000 });
});
