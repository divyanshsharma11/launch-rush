// Mock provider app.js: Bearer auth, GET /health, POST /charges, JSON 404/500. Real HTTP via app.listen; real DB.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createProviderDb } from '../sims/payment-provider/db.js';
import { createProviderApp } from '../sims/payment-provider/app.js';
import { captureLogger } from './helpers.js';

const API_KEY = 'k'.repeat(32);
const db = createProviderDb({ logger: captureLogger().logger });
const admin = new pg.Client();
await admin.connect();
const servers = [];
const keys = []; // idempotency keys used by these tests; cleanup deletes only their rows

after(async () => {
  for (const server of servers) server.close();
  const payments = 'SELECT id FROM paysim.payments WHERE idempotency_key = ANY($1)';
  await admin.query(
    `DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id IN (${payments}))`,
    [keys],
  );
  await admin.query(`DELETE FROM paysim.events WHERE payment_id IN (${payments})`, [keys]);
  await admin.query(`DELETE FROM paysim.refunds WHERE payment_id IN (${payments})`, [keys]);
  await admin.query('DELETE FROM paysim.payments WHERE idempotency_key = ANY($1)', [keys]);
  await admin.end();
  await db.close();
});

// Starts the app on a free port; returns its base URL and the captured log lines.
async function start({ store = db, config = {} } = {}) {
  const { logger, lines } = captureLogger();
  const server = createProviderApp({ db: store, config: { apiKey: API_KEY, ...config }, logger }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, lines };
}

const auth = (value) => ({ headers: { Authorization: value } });

test('GET /health with the right key: 200 { status: ok } (real DB)', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/health`, auth(`Bearer ${API_KEY}`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('scheme name is case-insensitive (RFC 9110 §11.1): "bearer" accepted', async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/health`, auth(`bearer ${API_KEY}`))).status, 200);
});

test('missing, wrong, shorter, Basic or empty credentials: 401 unauthorized + WWW-Authenticate: Bearer; key never logged', async () => {
  const { base, lines } = await start();
  const cases = [
    {},
    auth(`Bearer ${'x'.repeat(32)}`),
    auth('Bearer short'),
    auth(`Basic ${Buffer.from(`user:${API_KEY}`).toString('base64')}`),
    auth('Bearer '),
    auth(API_KEY),
  ];
  for (const options of cases) {
    const res = await fetch(`${base}/health`, options);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await res.json(), { error: { code: 'unauthorized', message: 'missing or invalid API key' } });
  }
  assert.equal(lines.filter((l) => l.msg === 'provider request unauthorized').length, cases.length);
  assert.ok(!JSON.stringify(lines).includes(API_KEY), 'API key not in logs');
});

test('unknown route: 401 without the key, JSON 404 not_found with it', async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/nope`)).status, 401);
  const res = await fetch(`${base}/nope`, auth(`Bearer ${API_KEY}`));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'route not found' } });
});

test('database unreachable: 503 unavailable, error logged', async () => {
  const down = { ping: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) };
  const { base, lines } = await start({ store: down });
  const res = await fetch(`${base}/health`, auth(`Bearer ${API_KEY}`));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: { code: 'unavailable', message: 'database unreachable' } });
  const [log] = lines.filter((l) => l.msg === 'health check failed: database unreachable');
  assert.equal(log.level, 50);
  assert.equal(log.err.code, 'ECONNREFUSED');
});

// POST /charges (piece 9b).
const { base: chargeBase, lines: chargeLines } = await start();

function postCharge(body, { key = `charge-${body?.orderId ?? randomUUID()}`, run, raw, contentType = 'application/json' } = {}) {
  if (key) keys.push(key);
  const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': contentType };
  if (key) headers['Idempotency-Key'] = key;
  if (run) headers['X-Sim-Run'] = run;
  return fetch(`${chargeBase}/charges`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
}

const validCharge = () => ({ orderId: randomUUID(), amountMinor: 580000, currency: 'INR' });

async function savedFor(key) {
  const { rows: payments } = await admin.query(
    'SELECT id, order_id, amount_minor, currency, run_id FROM paysim.payments WHERE idempotency_key = $1',
    [key],
  );
  const { rows: events } = await admin.query('SELECT id, type, body FROM paysim.events WHERE payment_id = ANY($1)', [payments.map((p) => p.id)]);
  const { rows: deliveries } = await admin.query('SELECT status FROM paysim.deliveries WHERE event_id = ANY($1)', [events.map((e) => e.id)]);
  return { payments, events, deliveries };
}

test('charge: 201 with the saved payment; payment + payment.succeeded event (design §5.2 shape) + one pending delivery', async () => {
  const charge = validCharge();
  const before = Math.floor(Date.now() / 1000);
  const res = await postCharge(charge);
  assert.equal(res.status, 201);
  const reply = await res.json();
  assert.match(reply.paymentId, /^pay_[0-9a-f]{32}$/);
  assert.deepEqual(reply, { paymentId: reply.paymentId, ...charge });
  const { payments, events, deliveries } = await savedFor(`charge-${charge.orderId}`);
  assert.deepEqual(payments, [{ id: reply.paymentId, order_id: charge.orderId, amount_minor: 580000, currency: 'INR', run_id: null }]);
  const event = JSON.parse(events[0].body);
  assert.deepEqual(Object.keys(event), ['id', 'type', 'created', 'data']);
  assert.equal(event.id, events[0].id);
  assert.match(event.id, /^evt_[0-9a-f]{32}$/);
  assert.equal(event.type, 'payment.succeeded');
  assert.ok(Number.isInteger(event.created) && event.created >= before);
  assert.deepEqual(event.data, { paymentId: reply.paymentId, ...charge });
  assert.deepEqual(deliveries, [{ status: 'pending' }]);
  assert.equal(chargeLines.find((l) => l.paymentId === reply.paymentId).msg, 'charge created');
});

test('replay (same key, same body): 201 with the identical body; still one payment, one event, one delivery', async () => {
  const charge = validCharge();
  const first = await (await postCharge(charge)).json();
  const res = await postCharge(charge);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), first);
  const { payments, events, deliveries } = await savedFor(`charge-${charge.orderId}`);
  assert.deepEqual([payments.length, events.length, deliveries.length], [1, 1, 1]);
  assert.equal(chargeLines.filter((l) => l.paymentId === first.paymentId && l.msg === 'charge replayed').length, 1);
});

test('orderId in upper case: saved and replied in lower case, so first reply and replay are identical', async () => {
  const charge = { ...validCharge(), orderId: randomUUID().toUpperCase() };
  const key = `charge-${charge.orderId}`;
  const first = await (await postCharge(charge, { key })).json();
  assert.equal(first.orderId, charge.orderId.toLowerCase());
  assert.deepEqual(await (await postCharge(charge, { key })).json(), first);
});

test('same key, different amount: 409 idempotency_conflict, nothing new', async () => {
  const charge = validCharge();
  await postCharge(charge);
  const res = await postCharge({ ...charge, amountMinor: 1 });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: { code: 'idempotency_conflict', message: 'Idempotency-Key was already used with a different request' },
  });
  assert.equal((await savedFor(`charge-${charge.orderId}`)).payments[0].amount_minor, 580000);
});

test('X-Sim-Run: a uuid is stored as run_id (not in the reply); anything else is 400', async () => {
  const runId = randomUUID();
  const charge = validCharge();
  const reply = await (await postCharge(charge, { run: runId })).json();
  assert.equal('runId' in reply, false);
  assert.equal((await savedFor(`charge-${charge.orderId}`)).payments[0].run_id, runId);
  for (const run of ['run-1', ' ']) {
    const bad = validCharge();
    const res = await postCharge(bad, { run });
    assert.equal(res.status, 400, `X-Sim-Run "${run}"`);
    assert.equal((await res.json()).error.message, 'X-Sim-Run must be a uuid');
    assert.equal((await savedFor(`charge-${bad.orderId}`)).payments.length, 0);
  }
});

test('invalid requests: 400 invalid_request naming the problem, nothing saved', async () => {
  const keyRule = 'Idempotency-Key header is required (1-255 characters)';
  const amountRule = 'amountMinor must be an integer from 0 to 2147483647';
  const cases = [
    [{ key: '' }, validCharge(), keyRule],
    [{ key: 'k'.repeat(256) }, validCharge(), keyRule],
    [{ contentType: 'text/plain' }, validCharge(), 'body must be a JSON object'],
    [{ raw: '[1,2]' }, validCharge(), 'body must be a JSON object'],
    [{}, { ...validCharge(), orderId: 'order-1' }, 'orderId must be a uuid'],
    [{}, { ...validCharge(), amountMinor: -1 }, amountRule],
    [{}, { ...validCharge(), amountMinor: 1.5 }, amountRule],
    [{}, { ...validCharge(), amountMinor: '100' }, amountRule],
    [{}, { ...validCharge(), amountMinor: 2_147_483_648 }, amountRule],
    [{}, { ...validCharge(), currency: 'inr' }, 'currency must be 3 upper-case letters'],
  ];
  for (const [options, body, message] of cases) {
    const key = options.key ?? `charge-${randomUUID()}`;
    const res = await postCharge(body, { ...options, key });
    assert.equal(res.status, 400, message);
    assert.deepEqual(await res.json(), { error: { code: 'invalid_request', message } });
    if (key) assert.equal((await savedFor(key)).payments.length, 0);
  }
});

test('malformed JSON: 400 invalid_request from the body parser, warn logged', async () => {
  const res = await postCharge(null, { raw: '{"orderId":' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_request');
  assert.ok(chargeLines.some((l) => l.msg === 'provider request rejected' && l.status === 400));
});

test('DB error: 500 internal_error without details, error logged; API key never logged', async () => {
  const broken = { createCharge: () => Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })) };
  const { base, lines } = await start({ store: broken });
  const res = await fetch(`${base}/charges`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `charge-${randomUUID()}` },
    body: JSON.stringify(validCharge()),
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: { code: 'internal_error', message: 'internal error' } });
  const [log] = lines.filter((l) => l.msg === 'unhandled provider request error');
  assert.equal(log.err.code, '42P01');
  assert.ok(!JSON.stringify([...lines, ...chargeLines]).includes(API_KEY), 'API key not in logs');
});

// POST /refunds (piece 9c). Refund keys are only cleaned up through their payment, which a charge key tracks.
function postRefund(body, { key = `refund-${randomUUID()}`, raw } = {}) {
  const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  return fetch(`${chargeBase}/refunds`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
}

async function paidCharge() {
  return (await postCharge(validCharge())).json();
}

const UNKNOWN_PAYMENT = `pay_${'0'.repeat(32)}`; // well-formed, never issued

async function refundRowsFor(paymentId) {
  const { rows: refunds } = await admin.query('SELECT id FROM paysim.refunds WHERE payment_id = $1', [paymentId]);
  const { rows: events } = await admin.query(
    `SELECT id, body FROM paysim.events WHERE payment_id = $1 AND type = 'payment.refunded'`,
    [paymentId],
  );
  const { rows: deliveries } = await admin.query('SELECT status FROM paysim.deliveries WHERE event_id = ANY($1)', [events.map((e) => e.id)]);
  return { refunds, events, deliveries };
}

test('refund: 201 { refundId, paymentId }; refund + payment.refunded event + one pending delivery', async () => {
  const charge = await paidCharge();
  const res = await postRefund({ paymentId: charge.paymentId }, { key: `refund-${charge.orderId}` });
  assert.equal(res.status, 201);
  const reply = await res.json();
  assert.match(reply.refundId, /^re_[0-9a-f]{32}$/);
  assert.deepEqual(reply, { refundId: reply.refundId, paymentId: charge.paymentId });
  const { refunds, events, deliveries } = await refundRowsFor(charge.paymentId);
  assert.deepEqual(refunds, [{ id: reply.refundId }]);
  const event = JSON.parse(events[0].body);
  assert.equal(event.type, 'payment.refunded');
  assert.deepEqual(event.data, { refundId: reply.refundId, paymentId: charge.paymentId, orderId: charge.orderId, amountMinor: 580000, currency: 'INR' });
  assert.deepEqual(deliveries, [{ status: 'pending' }]);
  assert.equal(chargeLines.find((l) => l.refundId === reply.refundId).msg, 'refund created');
});

test('refund replay (same key, same payment): 201 with the identical body; still one refund and one event', async () => {
  const charge = await paidCharge();
  const key = `refund-${charge.orderId}`;
  const first = await (await postRefund({ paymentId: charge.paymentId }, { key })).json();
  const res = await postRefund({ paymentId: charge.paymentId }, { key });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), first);
  const { refunds, events } = await refundRowsFor(charge.paymentId);
  assert.deepEqual([refunds.length, events.length], [1, 1]);
});

test('refund: same key with another or unknown payment → 409 idempotency_conflict (key checked first)', async () => {
  const [charge, other] = [await paidCharge(), await paidCharge()];
  const key = `refund-${charge.orderId}`;
  await postRefund({ paymentId: charge.paymentId }, { key });
  for (const paymentId of [other.paymentId, UNKNOWN_PAYMENT]) {
    const res = await postRefund({ paymentId }, { key });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'idempotency_conflict');
  }
  assert.equal((await refundRowsFor(other.paymentId)).refunds.length, 0);
});

test('refund: unknown payment with a new key → 404 payment_not_found', async () => {
  const res = await postRefund({ paymentId: UNKNOWN_PAYMENT });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: 'payment_not_found', message: 'payment not found' } });
});

test('refund: already refunded under another key → 409 already_refunded, nothing new', async () => {
  const charge = await paidCharge();
  await postRefund({ paymentId: charge.paymentId }, { key: `refund-${charge.orderId}` });
  const res = await postRefund({ paymentId: charge.paymentId });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: { code: 'already_refunded', message: 'payment already refunded' } });
  assert.equal((await refundRowsFor(charge.paymentId)).refunds.length, 1);
});

// POST /payments/:paymentId/resend-webhook (piece 9d).
const resend = (paymentId) =>
  fetch(`${chargeBase}/payments/${paymentId}/resend-webhook`, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}` } });

test('resend: 202 { eventId } with the payment.succeeded event id; a second pending delivery for it', async () => {
  const charge = await paidCharge();
  const { events } = await savedFor(`charge-${charge.orderId}`);
  const res = await resend(charge.paymentId);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { eventId: events[0].id });
  assert.deepEqual((await savedFor(`charge-${charge.orderId}`)).deliveries, [{ status: 'pending' }, { status: 'pending' }]);
  assert.ok(chargeLines.some((l) => l.msg === 'webhook resend queued' && l.eventId === events[0].id));
});

test('resend: unknown payment → 404 payment_not_found; no key → 401', async () => {
  const res = await resend('pay_unknown');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: 'payment_not_found', message: 'payment not found' } });
  assert.equal((await fetch(`${chargeBase}/payments/pay_unknown/resend-webhook`, { method: 'POST' })).status, 401);
});

test('resend: well-formed unknown id or a NUL byte → 404; a broken %-escape → 400 invalid_request, not 500', async () => {
  for (const paymentId of [UNKNOWN_PAYMENT, 'pay_%00x']) {
    const res = await resend(paymentId);
    assert.equal(res.status, 404, paymentId);
    assert.equal((await res.json()).error.code, 'payment_not_found');
  }
  const res = await resend('pay_%E0%A4%A');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_request');
  assert.ok(!chargeLines.some((l) => l.msg === 'unhandled provider request error'), 'no 500 logged');
});

const redeliver = (body, headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }) =>
  fetch(`${chargeBase}/deliveries/redeliver-failed`, { method: 'POST', headers, body: JSON.stringify(body) });

test('redeliver-failed: 202 { redelivered }; a failed delivery of a recent event is pending again, logged', async () => {
  const charge = await paidCharge();
  const { events } = await savedFor(`charge-${charge.orderId}`);
  await admin.query("UPDATE paysim.deliveries SET status = 'failed' WHERE event_id = $1", [events[0].id]);
  const res = await redeliver({ maxAgeMs: 86_400_000 });
  assert.equal(res.status, 202);
  assert.ok((await res.json()).redelivered >= 1);
  assert.deepEqual((await savedFor(`charge-${charge.orderId}`)).deliveries, [{ status: 'pending' }]);
  assert.ok(chargeLines.some((l) => l.msg === 'failed webhook deliveries queued again'));
});

test('redeliver-failed: nothing to do → 202 { redelivered: 0 } and no log line', async () => {
  await redeliver({ maxAgeMs: 86_400_000 });
  const logged = chargeLines.length;
  const res = await redeliver({ maxAgeMs: 86_400_000 });
  assert.deepEqual(await res.json(), { redelivered: 0 });
  assert.equal(chargeLines.length, logged);
});

test('redeliver-failed: a missing or invalid maxAgeMs → 400 invalid_request; no key → 401', async () => {
  for (const body of [undefined, {}, { maxAgeMs: 0 }, { maxAgeMs: 1.5 }, { maxAgeMs: '5' }, { maxAgeMs: 2_147_483_648 }]) {
    const res = await redeliver(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, 'invalid_request');
  }
  assert.equal((await redeliver({ maxAgeMs: 1000 }, {})).status, 401);
});

test('refund: invalid requests → 400 invalid_request naming the problem', async () => {
  const keyRule = 'Idempotency-Key header is required (1-255 characters)';
  const idRule = 'paymentId must be pay_ followed by 32 lower-case hex characters';
  const cases = [
    [{ key: '' }, { paymentId: 'pay_x' }, keyRule],
    [{ key: 'k'.repeat(256) }, { paymentId: 'pay_x' }, keyRule],
    [{ raw: '[1]' }, null, 'body must be a JSON object'],
    [{}, {}, 'paymentId must be a non-empty string'],
    [{}, { paymentId: '' }, 'paymentId must be a non-empty string'],
    [{}, { paymentId: 42 }, 'paymentId must be a non-empty string'],
    [{}, { paymentId: 'pay_unknown' }, idRule],
    [{}, { paymentId: `pay_\u0000${'0'.repeat(31)}` }, idRule],
  ];
  for (const [options, body, message] of cases) {
    const res = await postRefund(body, options);
    assert.equal(res.status, 400, message);
    assert.deepEqual(await res.json(), { error: { code: 'invalid_request', message } });
  }
});

// Run duplicates (piece 11): runDuplicateShare is 0.05 in config; 1 and 0 make the outcome certain.
async function chargeVia(base, { run, key } = {}) {
  const charge = validCharge();
  key ??= `charge-${charge.orderId}`;
  keys.push(key);
  const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key };
  if (run) headers['X-Sim-Run'] = run;
  const res = await fetch(`${base}/charges`, { method: 'POST', headers, body: JSON.stringify(charge) });
  assert.equal(res.status, 201);
  return { key, ...(await savedFor(key)) };
}

test('run duplicates, share 1: a run charge gets 2 deliveries of its one event, a replay adds none; a shop charge gets 1', async () => {
  const { base, lines } = await start({ config: { runDuplicateShare: 1 } });
  const run = randomUUID();
  const first = await chargeVia(base, { run });
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.deliveries, [{ status: 'pending' }, { status: 'pending' }]);
  assert.equal(lines.find((l) => l.paymentId === first.payments[0].id && l.msg === 'charge created').webhookSends, 2);
  const replay = await fetch(`${base}/charges`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': first.key, 'X-Sim-Run': run },
    body: JSON.stringify({ orderId: first.payments[0].order_id, amountMinor: 580000, currency: 'INR' }),
  });
  assert.equal(replay.status, 201);
  assert.equal((await savedFor(first.key)).deliveries.length, 2);
  const shop = await chargeVia(base);
  assert.deepEqual(shop.deliveries, [{ status: 'pending' }]);
});

test('run duplicates, share 0: a run charge gets one delivery', async () => {
  const { base } = await start({ config: { runDuplicateShare: 0 } });
  assert.deepEqual((await chargeVia(base, { run: randomUUID() })).deliveries, [{ status: 'pending' }]);
});
