// Circuit breakers around a connector (design §3, §7): when they open, what they ignore, how a run is isolated.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBreakers } from '../src/services/connectors/breaker.js';
import { PERMANENT, UpstreamHttpError, classifyHttpError } from '../src/services/connectors/http-errors.js';
import { captureLogger } from './helpers.js';

const settings = {
  timeoutMs: 200,
  errorThresholdPercentage: 50,
  resetTimeoutMs: 150,
  volumeThreshold: 5,
  rollingCountTimeoutMs: 10_000,
  runIdleMs: 100,
};

// A stand-in connector: `behave` decides what execute does; calls counts how often it ran.
function stub(behave) {
  const connector = {
    id: 'stub',
    capabilities: ['ping'],
    calls: 0,
    execute: async () => {
      connector.calls += 1;
      return behave();
    },
    classifyError: classifyHttpError,
    healthCheck: async () => true,
  };
  return connector;
}

const down = () => { throw new UpstreamHttpError('Stub', 503, null, null); };
const badRequest = () => { throw new UpstreamHttpError('Stub', 400, 'invalid_request', null); };
const ctx = (runId = null) => ({ orderId: 'o', runId, idempotencyKey: 'k', attempt: 1, timeoutMs: 1000 });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let breakers;
afterEach(() => breakers?.close());

function setup(connector) {
  const captured = captureLogger();
  breakers = createBreakers({ settings, logger: captured.logger });
  return { protected: breakers.protect(connector), ...captured };
}

async function fail(connector, times, runId = null) {
  for (let i = 0; i < times; i += 1) await connector.execute('ping', {}, ctx(runId)).catch(() => {});
}

test('one failed call cannot open the breaker: it opens only after volumeThreshold calls', async () => {
  const connector = stub(down);
  const { protected: guarded } = setup(connector);
  await fail(guarded, 4);
  assert.deepEqual(breakers.states(), [{ connector: 'stub', runId: null, state: 'closed' }]);
  await fail(guarded, 1);
  assert.equal(breakers.states()[0].state, 'open');
});

test('an open breaker rejects without calling the connector; the error is rateLimited(resetTimeout)', async () => {
  const connector = stub(down);
  const { protected: guarded, lines } = setup(connector);
  await fail(guarded, 5);
  const callsBefore = connector.calls;

  const err = await guarded.execute('ping', {}, ctx()).catch((e) => e);
  assert.equal(err.code, 'EOPENBREAKER');
  assert.equal(connector.calls, callsBefore);
  assert.deepEqual(guarded.classifyError(err), { kind: 'rateLimited', retryAfterMs: 150 });
  assert.ok(lines.some((line) => line.msg === 'breaker open' && line.connector === 'stub' && line.runId === null));
});

test('after resetTimeout one trial call goes through: success closes it, failure opens it again', async () => {
  let works = false;
  const connector = stub(() => (works ? 'ok' : down()));
  const { protected: guarded } = setup(connector);
  await fail(guarded, 5);

  await wait(200);
  assert.equal(breakers.states()[0].state, 'halfOpen');
  await fail(guarded, 1); // the trial fails
  assert.equal(breakers.states()[0].state, 'open');

  await wait(200);
  works = true;
  assert.equal(await guarded.execute('ping', {}, ctx()), 'ok');
  assert.equal(breakers.states()[0].state, 'closed');
});

test('permanent errors (bad data) do not count against the upstream', async () => {
  const { protected: guarded } = setup(stub(badRequest));
  await fail(guarded, 12);
  assert.equal(breakers.states()[0].state, 'closed');
  assert.deepEqual(guarded.classifyError(new UpstreamHttpError('Stub', 400, 'invalid_request', null)), PERMANENT);
});

test('a call over the breaker timeout is ETIMEDOUT, classified retryable', async () => {
  const { protected: guarded } = setup(stub(() => wait(500)));
  const err = await guarded.execute('ping', {}, ctx()).catch((e) => e);
  assert.equal(err.code, 'ETIMEDOUT');
  assert.deepEqual(guarded.classifyError(err), { kind: 'retryable' });
});

test('a provider error code that looks like a breaker code is not mistaken for one', () => {
  const { protected: guarded } = setup(stub(down));
  assert.deepEqual(guarded.classifyError(new UpstreamHttpError('Stub', 503, 'EOPENBREAKER', null)), { kind: 'retryable' });
});

test('a demo run has its own breaker: its faults do not trip the shop or another run', async () => {
  const connector = stub(() => 'ok');
  connector.execute = async (action, payload, context) => {
    if (context.runId === 'run-a') down();
    return 'ok';
  };
  const { protected: guarded } = setup(connector);

  await fail(guarded, 5, 'run-a');
  const states = Object.fromEntries(breakers.states().map((s) => [s.runId ?? 'shared', s.state]));
  assert.equal(states['run-a'], 'open');
  assert.equal(await guarded.execute('ping', {}, ctx()), 'ok');
  assert.equal(await guarded.execute('ping', {}, ctx('run-b')), 'ok');
  assert.equal(breakers.states().find((s) => s.runId === null).state, 'closed');
  assert.equal(breakers.states().find((s) => s.runId === 'run-b').state, 'closed');
});

test('a run breaker is dropped once idle; the shop breaker stays', async () => {
  const { protected: guarded } = setup(stub(() => 'ok'));
  await guarded.execute('ping', {}, ctx());
  await guarded.execute('ping', {}, ctx('run-x'));
  assert.equal(breakers.states().length, 2);
  await wait(250);
  assert.deepEqual(breakers.states().map((s) => s.runId), [null]);
});

test('healthCheck, id and capabilities pass through to the connector', async () => {
  const { protected: guarded } = setup(stub(() => 'ok'));
  assert.equal(guarded.id, 'stub');
  assert.deepEqual(guarded.capabilities, ['ping']);
  assert.equal(await guarded.healthCheck(), true);
});

test('onState reports open, half-open and closed, and null when a run breaker is dropped', async () => {
  let works = false;
  const reported = [];
  breakers = createBreakers({ settings, logger: captureLogger().logger, onState: (s) => reported.push(`${s.runId ?? 'shared'}:${s.state}`) });
  const guarded = breakers.protect(stub(() => (works ? 'ok' : down())));

  await fail(guarded, 5);
  await wait(200); // resetTimeout 150 ms: the next call is the trial
  works = true;
  await guarded.execute('ping', {}, ctx());
  assert.deepEqual(reported, ['shared:open', 'shared:halfOpen', 'shared:closed']);

  await guarded.execute('ping', {}, ctx('run-y'));
  await wait(250); // runIdleMs
  assert.deepEqual(reported.slice(3), ['run-y:null']);
});
