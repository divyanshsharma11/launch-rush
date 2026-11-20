// Starts the real src/api.js twice, without and with TRUST_PROXY=1, and sends each session request with a different
// X-Forwarded-For. Session creation is limited to 10 per minute per client IP, so the 11th shows which IP was used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { Redis } from 'ioredis';

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startApi(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/api.js'], { env: { ...process.env, ...extraEnv, PORT: String(port) } });
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`api exited early with code ${code}`)));
    createInterface({ input: child.stdout }).on('line', (text) => {
      if (JSON.parse(text).msg === 'api listening') resolve();
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function elevenSessions(baseUrl) {
  const statuses = [];
  const sessionIds = [];
  for (let i = 1; i <= 11; i += 1) {
    const res = await fetch(`${baseUrl}/api/session`, { method: 'POST', headers: { 'X-Forwarded-For': `198.51.100.${i}` } });
    statuses.push(res.status);
    if (res.status === 201) sessionIds.push((await res.json()).sessionId);
  }
  return { statuses, sessionIds };
}

async function withCleanup(run) {
  const admin = new pg.Client();
  const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  const clearCounters = async () => {
    const counters = await redis.keys('ratelimit:sessionCreate:*');
    if (counters.length) await redis.del(...counters);
  };
  let sessionIds = [];
  try {
    await admin.connect();
    await clearCounters();
    sessionIds = await run();
  } finally {
    await admin.query('DELETE FROM sessions WHERE id = ANY($1)', [sessionIds]);
    await clearCounters();
    await admin.end();
    redis.disconnect();
  }
}

test('without TRUST_PROXY a spoofed X-Forwarded-For is ignored: the 11th session is still limited', async () => {
  const { child, baseUrl } = await startApi({ TRUST_PROXY: '' });
  try {
    await withCleanup(async () => {
      const { statuses, sessionIds } = await elevenSessions(baseUrl);
      assert.equal(statuses[10], 429);
      return sessionIds;
    });
  } finally {
    child.kill();
  }
});

test('with TRUST_PROXY=1 the client IP comes from X-Forwarded-For: eleven different IPs are all accepted', async () => {
  const { child, baseUrl } = await startApi({ TRUST_PROXY: '1' });
  try {
    await withCleanup(async () => {
      const { statuses, sessionIds } = await elevenSessions(baseUrl);
      assert.deepEqual(statuses, Array(11).fill(201));
      return sessionIds;
    });
  } finally {
    child.kill();
  }
});
