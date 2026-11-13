// Mock provider db.js createCharge (design §5.2, §6) against the real PostgreSQL container (paysim schema).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createProviderDb } from '../sims/payment-provider/db.js';
import { captureLogger } from './helpers.js';

const db = createProviderDb({ logger: captureLogger().logger });
const admin = new pg.Client();
await admin.connect();
const paymentIds = [];

after(async () => {
  // Children first (deliveries -> events, refunds -> payments); only the rows these tests created.
  await admin.query(
    'DELETE FROM paysim.deliveries WHERE event_id IN (SELECT id FROM paysim.events WHERE payment_id = ANY($1))',
    [paymentIds],
  );
  await admin.query('DELETE FROM paysim.events WHERE payment_id = ANY($1)', [paymentIds]);
  await admin.query('DELETE FROM paysim.refunds WHERE payment_id = ANY($1)', [paymentIds]);
  await admin.query('DELETE FROM paysim.payments WHERE id = ANY($1)', [paymentIds]);
  await admin.end();
  await db.close();
});

const hex = () => randomBytes(16).toString('hex');

// A charge request as app.js will build it: fresh ids, key 'charge-<orderId>' (§6).
function charge({ orderId = randomUUID(), amountMinor = 580000, runId = null, sends } = {}) {
  const payment = {
    id: `pay_${hex()}`, idempotencyKey: `charge-${orderId}`, orderId, amountMinor, currency: 'INR', runId,
  };
  paymentIds.push(payment.id);
  const body = JSON.stringify({ id: `evt_${hex()}`, type: 'payment.succeeded', data: { paymentId: payment.id, orderId, note: 'Ragnarök' } });
  return { payment, event: { id: JSON.parse(body).id, body }, sends };
}

async function rowsFor(paymentId) {
  const { rows: events } = await admin.query('SELECT id, type, body FROM paysim.events WHERE payment_id = $1', [paymentId]);
  const { rows: deliveries } = await admin.query(
    'SELECT status, attempts FROM paysim.deliveries WHERE event_id = ANY($1)',
    [events.map((e) => e.id)],
  );
  return { events, deliveries };
}

test('new charge: payment + one payment.succeeded event (body byte-exact) + one pending delivery', async () => {
  const request = charge();
  const result = await db.createCharge(request);
  assert.equal(result.outcome, 'created');
  assert.equal(result.payment.id, request.payment.id);
  const { events, deliveries } = await rowsFor(request.payment.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'payment.succeeded');
  assert.equal(events[0].body, request.event.body);
  assert.deepEqual(deliveries, [{ status: 'pending', attempts: 0 }]);
});

test('same key, same body: existing, returns the first payment, creates nothing new', async () => {
  const first = charge();
  await db.createCharge(first);
  const retry = charge({ orderId: first.payment.orderId }); // new ids, as a retried request would bring
  const result = await db.createCharge(retry);
  assert.equal(result.outcome, 'existing');
  assert.equal(result.payment.id, first.payment.id);
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM paysim.payments WHERE id = $1', [retry.payment.id]);
  assert.equal(rows[0].n, 0);
  assert.equal((await rowsFor(first.payment.id)).deliveries.length, 1);
});

test('same key, order id in upper case in the body: still the same body (uuid compared in SQL)', async () => {
  const first = charge();
  await db.createCharge(first);
  const retry = charge({ orderId: first.payment.orderId });
  retry.payment.orderId = first.payment.orderId.toUpperCase();
  assert.equal((await db.createCharge(retry)).outcome, 'existing');
});

test('same key, different amount: conflict, nothing new', async () => {
  const first = charge();
  await db.createCharge(first);
  const result = await db.createCharge(charge({ orderId: first.payment.orderId, amountMinor: 1 }));
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.payment.id, first.payment.id);
  assert.equal((await rowsFor(first.payment.id)).deliveries.length, 1);
});

test('run duplicate: sends 2 gives two pending deliveries for the one event; run_id stored', async () => {
  const runId = randomUUID();
  const request = charge({ runId, sends: 2 });
  assert.equal((await db.createCharge(request)).outcome, 'created');
  const { events, deliveries } = await rowsFor(request.payment.id);
  assert.equal(events.length, 1);
  assert.equal(deliveries.length, 2);
  const { rows } = await admin.query('SELECT run_id FROM paysim.payments WHERE id = $1', [request.payment.id]);
  assert.equal(rows[0].run_id, runId);
});

test('5 parallel charges with the same key: exactly one created, the others existing, one payment row', async () => {
  const orderId = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => db.createCharge(charge({ orderId }))));
  assert.equal(results.filter((r) => r.outcome === 'created').length, 1);
  assert.equal(results.filter((r) => r.outcome === 'existing').length, 4);
  assert.equal(new Set(results.map((r) => r.payment.id)).size, 1);
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM paysim.payments WHERE idempotency_key = $1', [`charge-${orderId}`]);
  assert.equal(rows[0].n, 1);
});

test('forced race: a charge waits for an uncommitted payment with the same key, then returns existing', async () => {
  const first = charge();
  const other = new pg.Client(); // stands in for a concurrent request that has inserted but not committed yet
  await other.connect();
  await other.query('BEGIN');
  await other.query(
    `INSERT INTO paysim.payments (id, idempotency_key, order_id, amount_minor, currency) VALUES ($1, $2, $3, $4, 'INR')`,
    [first.payment.id, first.payment.idempotencyKey, first.payment.orderId, first.payment.amountMinor],
  );
  let settled = false;
  const pending = db.createCharge(charge({ orderId: first.payment.orderId })).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, 'createCharge should wait while the other transaction is open');
  await other.query('COMMIT');
  await other.end();
  const result = await pending;
  assert.equal(result.outcome, 'existing');
  assert.equal(result.payment.id, first.payment.id);
});

test('a failing event insert rolls back the payment too (one transaction)', async () => {
  const request = charge();
  request.event.id = 'evt_bad'; // breaks events_id_format
  await assert.rejects(db.createCharge(request), { code: '23514', constraint: 'events_id_format' });
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM paysim.payments WHERE id = $1', [request.payment.id]);
  assert.equal(rows[0].n, 0);
});

// Deliveries (lease claim). The claim takes every due row, also those left by the tests above (cleaned up in after()),
// so each test looks only at its own delivery.
const LEASE = { limit: 1000, leaseMs: 30_000 };

async function newDelivery() {
  const request = charge();
  await db.createCharge(request);
  const { rows } = await admin.query('SELECT id FROM paysim.deliveries WHERE event_id = $1', [request.event.id]);
  return { id: rows[0].id, event: request.event };
}

const mine = (claimed, id) => claimed.filter((d) => d.id === id);

async function deliveryRow(id) {
  const { rows } = await admin.query(
    `SELECT status, attempts, last_error, next_attempt_at > now() + interval '25 seconds' AS leased
     FROM paysim.deliveries WHERE id = $1`,
    [id],
  );
  return rows[0];
}

test('claim: a due delivery comes back once, attempts 1, exact event body; not again while its lease runs', async () => {
  const { id, event } = await newDelivery();
  assert.deepEqual(mine(await db.claimDueDeliveries(LEASE), id), [{ id, eventId: event.id, attempts: 1, body: event.body }]);
  assert.deepEqual(await deliveryRow(id), { status: 'pending', attempts: 1, last_error: null, leased: true });
  assert.deepEqual(mine(await db.claimDueDeliveries(LEASE), id), []);
});

test('kill during a send: once the lease runs out the same delivery is claimed again, attempts 2', async () => {
  const { id } = await newDelivery();
  assert.equal(mine(await db.claimDueDeliveries({ limit: 1000, leaseMs: 200 }), id).length, 1);
  // no markDelivered/scheduleRetry: the sender "died"
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(mine(await db.claimDueDeliveries(LEASE), id)[0].attempts, 2);
});

test('SKIP LOCKED: a row held by another connection is skipped without waiting, then claimed once released', async () => {
  const { id } = await newDelivery();
  const other = new pg.Client(); // stands in for another claimer in the middle of its claim
  await other.connect();
  await other.query('BEGIN');
  await other.query('SELECT id FROM paysim.deliveries WHERE id = $1 FOR UPDATE', [id]);
  const claimed = await Promise.race([
    db.claimDueDeliveries(LEASE),
    new Promise((resolve) => setTimeout(() => resolve('waited'), 2000)),
  ]);
  assert.notEqual(claimed, 'waited', 'the claim should not wait for the locked row');
  assert.deepEqual(mine(claimed, id), []);
  await other.query('ROLLBACK');
  await other.end();
  assert.equal(mine(await db.claimDueDeliveries(LEASE), id).length, 1);
});

test('scheduleRetry: stores last_error; not claimed before the delay, claimed after it (attempts 2)', async () => {
  const { id } = await newDelivery();
  await db.claimDueDeliveries(LEASE);
  await db.scheduleRetry({ id, delayMs: 60_000, error: 'HTTP 503' });
  assert.deepEqual(mine(await db.claimDueDeliveries(LEASE), id), []);
  assert.equal((await deliveryRow(id)).last_error, 'HTTP 503');
  await db.scheduleRetry({ id, delayMs: 0, error: 'HTTP 503' });
  assert.equal(mine(await db.claimDueDeliveries(LEASE), id)[0].attempts, 2);
});

test('markDelivered and markFailed are final: never claimed again, a late update changes nothing', async () => {
  const delivered = await newDelivery();
  await db.claimDueDeliveries(LEASE);
  await db.markDelivered(delivered.id);
  await db.markFailed({ id: delivered.id, error: 'late' });
  await db.scheduleRetry({ id: delivered.id, delayMs: 0, error: 'late' });
  assert.deepEqual(await deliveryRow(delivered.id), { status: 'delivered', attempts: 1, last_error: null, leased: true });

  const failed = await newDelivery();
  await db.claimDueDeliveries(LEASE);
  await db.markFailed({ id: failed.id, error: 'TimeoutError' });
  await db.markDelivered(failed.id);
  assert.deepEqual(await deliveryRow(failed.id), { status: 'failed', attempts: 1, last_error: 'TimeoutError', leased: true });

  const claimed = await db.claimDueDeliveries(LEASE);
  assert.deepEqual([...mine(claimed, delivered.id), ...mine(claimed, failed.id)], []);
});

// Refunds. A refund request as app.js will build it: fresh ids, key 'refund-<orderId>' (§6).
async function paidCharge() {
  const request = charge();
  await db.createCharge(request);
  return request.payment;
}

const refundOf = (payment, key = `refund-${payment.orderId}`) => ({
  refund: { id: `re_${hex()}`, idempotencyKey: key, paymentId: payment.id },
  eventId: `evt_${hex()}`,
});

async function refundRows(paymentId) {
  const { rows: refunds } = await admin.query('SELECT id, idempotency_key FROM paysim.refunds WHERE payment_id = $1', [paymentId]);
  const { rows: events } = await admin.query(
    `SELECT id, body FROM paysim.events WHERE payment_id = $1 AND type = 'payment.refunded'`,
    [paymentId],
  );
  const { rows: deliveries } = await admin.query(
    'SELECT status, attempts FROM paysim.deliveries WHERE event_id = ANY($1)',
    [events.map((e) => e.id)],
  );
  return { refunds, events, deliveries };
}

test('new refund: refund + payment.refunded event with the payment data + one pending delivery', async () => {
  const payment = await paidCharge();
  const request = refundOf(payment);
  assert.deepEqual(await db.createRefund(request), { outcome: 'created', refund: request.refund });
  const { refunds, events, deliveries } = await refundRows(payment.id);
  assert.deepEqual(refunds, [{ id: request.refund.id, idempotency_key: request.refund.idempotencyKey }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, request.eventId);
  assert.deepEqual(JSON.parse(events[0].body), {
    id: request.eventId,
    type: 'payment.refunded',
    data: { refundId: request.refund.id, paymentId: payment.id, orderId: payment.orderId, amountMinor: 580000, currency: 'INR' },
  });
  assert.deepEqual(deliveries, [{ status: 'pending', attempts: 0 }]);
});

test('same key, same payment: existing, returns the first refund, creates nothing new', async () => {
  const payment = await paidCharge();
  const first = refundOf(payment);
  await db.createRefund(first);
  const result = await db.createRefund(refundOf(payment)); // new ids, as a retried request would bring
  assert.deepEqual(result, { outcome: 'existing', refund: first.refund });
  const { refunds, events } = await refundRows(payment.id);
  assert.equal(refunds.length, 1);
  assert.equal(events.length, 1);
});

test('same key, other payment: conflict, also when that payment does not exist (key checked first, as Stripe)', async () => {
  const payment = await paidCharge();
  const first = refundOf(payment);
  await db.createRefund(first);
  const other = await paidCharge();
  const missing = { id: `pay_${hex()}` };
  for (const target of [other, missing]) {
    const result = await db.createRefund(refundOf(target, first.refund.idempotencyKey));
    assert.deepEqual(result, { outcome: 'conflict', refund: first.refund });
  }
  assert.equal((await refundRows(other.id)).refunds.length, 0);
});

test('unknown payment, new key: payment_not_found, nothing written', async () => {
  const request = refundOf({ id: `pay_${hex()}`, orderId: randomUUID() });
  assert.deepEqual(await db.createRefund(request), { outcome: 'payment_not_found' });
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM paysim.refunds WHERE idempotency_key = $1', [request.refund.idempotencyKey]);
  assert.equal(rows[0].n, 0);
});

test('payment already refunded under another key: already_refunded, nothing new', async () => {
  const payment = await paidCharge();
  await db.createRefund(refundOf(payment));
  assert.deepEqual(await db.createRefund(refundOf(payment, `refund-${randomUUID()}`)), { outcome: 'already_refunded' });
  const { refunds, events } = await refundRows(payment.id);
  assert.equal(refunds.length, 1);
  assert.equal(events.length, 1);
});

test('forced race: a refund waits for an uncommitted refund with the same key, then returns existing', async () => {
  const payment = await paidCharge();
  const first = refundOf(payment);
  const other = new pg.Client(); // a concurrent request that has inserted but not committed yet
  await other.connect();
  await other.query('BEGIN');
  await other.query(
    'INSERT INTO paysim.refunds (id, idempotency_key, payment_id) VALUES ($1, $2, $3)',
    [first.refund.id, first.refund.idempotencyKey, payment.id],
  );
  let settled = false;
  const pending = db.createRefund(refundOf(payment)).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, 'createRefund should wait while the other transaction is open');
  await other.query('COMMIT');
  await other.end();
  assert.deepEqual(await pending, { outcome: 'existing', refund: first.refund });
});

test('a failing event insert rolls back the refund too (one transaction)', async () => {
  const payment = await paidCharge();
  const request = refundOf(payment);
  request.eventId = 'evt_bad'; // breaks events_id_format
  await assert.rejects(db.createRefund(request), { code: '23514', constraint: 'events_id_format' });
  assert.equal((await refundRows(payment.id)).refunds.length, 0);
});
