// ERP simulator over real HTTP, with the real PostgreSQL (erpsim schema) and Redis (fault settings).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { loadErpSimConfig } from '../sims/erp-simulator/config.js';
import { startErpSimulator } from '../sims/erp-simulator/start.js';
import { createErpSimApp } from '../sims/erp-simulator/app.js';
import { createErpSimDb, documentName } from '../sims/erp-simulator/db.js';
import { captureLogger } from './helpers.js';

const config = { ...loadErpSimConfig(process.env), port: 0 };
const { logger, lines } = captureLogger();
const admin = new pg.Client();
const redis = new Redis(config.redis);
const TOKEN = `token ${config.apiKey}:${config.apiSecret}`;
let sim;
let base;
const runs = [];
const orderRefs = [];

const newRun = () => {
  const runId = randomUUID();
  runs.push(runId);
  return runId;
};
const newRef = () => {
  const ref = randomUUID();
  orderRefs.push(ref);
  return ref;
};

async function call(method, path, { body, runId, authorization = TOKEN } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(authorization && { Authorization: authorization }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(runId && { 'X-Sim-Run': runId }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const resource = (doctype) => `/api/resource/${encodeURIComponent(doctype)}`;
const items = [{ item_code: 'elden-ring', qty: 1, rate: 5800 }];
const salesOrder = (ref) => ({ customer: 'Demo Customer', items, order_ref: ref, currency: 'INR' });
const submit = (doctype, name, options) => call('POST', '/api/method/frappe.client.submit', { body: { doc: { doctype, name } }, ...options });

// A run with `qty` copies of elden-ring in the simulator, seeded the way the run start does it.
async function runWithStock(qty) {
  const runId = newRun();
  const receipt = await call('POST', '/sim/stock-receipts', { body: { receiptId: `run-${runId}`, itemCode: 'elden-ring', qty, runId } });
  assert.deepEqual(receipt.body, { applied: true });
  return runId;
}

async function submittedSalesOrder(ref, runId) {
  const created = await call('POST', resource('Sales Order'), { body: salesOrder(ref), runId });
  assert.equal(created.status, 200);
  assert.equal((await submit('Sales Order', created.body.data.name, { runId })).status, 200);
  return created.body.data.name;
}

before(async () => {
  sim = await startErpSimulator({ config, logger });
  base = `http://127.0.0.1:${sim.port}`;
  await admin.connect();
});

after(async () => {
  await redis.del('faults:shared', ...runs.map((id) => `faults:${id}`));
  for (const runId of runs) await call('DELETE', `/sim/runs/${runId}`);
  await admin.query('DELETE FROM erpsim.documents WHERE order_ref = ANY($1)', [orderRefs]);
  await admin.end();
  await redis.quit();
  await sim.shutdown();
});

test('every route needs the token: missing, wrong key, wrong secret, wrong scheme -> 401 with WWW-Authenticate', async () => {
  const bad = [null, `token wrong:${config.apiSecret}`, `token ${config.apiKey}:wrong`, `Bearer ${config.apiKey}`, 'token nocolon'];
  for (const authorization of bad) {
    for (const path of ['/health', resource('Sales Order'), '/sim/runs/x', '/nope']) {
      const res = await call('GET', path, { authorization });
      assert.equal(res.status, 401, `${authorization} ${path}`);
      assert.equal(res.headers.get('www-authenticate'), 'token');
      assert.equal(res.body.exc_type, 'AuthenticationError');
    }
  }
  assert.equal((await call('GET', '/health')).status, 200);
  assert.ok(!lines.some((line) => JSON.stringify(line).includes(config.apiSecret)), 'secret is never logged');
});

test('create, list by order_ref and read: Frappe-shaped replies, names count up, default list fields = name only', async () => {
  const ref = newRef();
  const created = await call('POST', resource('Sales Order'), { body: salesOrder(ref) });
  assert.equal(created.status, 200);
  const { data } = created.body;
  assert.match(data.name, /^SO-\d{4,}$/);
  assert.equal(data.docstatus, 0);
  assert.equal(data.doctype, 'Sales Order');
  assert.equal(data.order_ref, ref);
  assert.deepEqual(data.items, items);

  const filters = encodeURIComponent(JSON.stringify([['order_ref', '=', ref]]));
  const byName = await call('GET', `${resource('Sales Order')}?filters=${filters}`);
  assert.deepEqual(byName.body, { data: [{ name: data.name }] });

  const fields = encodeURIComponent(JSON.stringify(['name', 'docstatus', 'nope']));
  const picked = await call('GET', `${resource('Sales Order')}?filters=${filters}&fields=${fields}`);
  assert.deepEqual(picked.body, { data: [{ name: data.name, docstatus: 0 }] });

  const read = await call('GET', `${resource('Sales Order')}/${data.name}`);
  assert.deepEqual(read.body.data, data);
  assert.equal((await call('GET', `${resource('Sales Order')}/SO-999999`)).status, 404);

  const second = await call('POST', resource('Sales Order'), { body: salesOrder(newRef()) });
  assert.equal(Number(second.body.data.name.slice(3)) > Number(data.name.slice(3)), true);

  const drafts = encodeURIComponent(JSON.stringify([['order_ref', '=', ref], ['docstatus', '=', 1]]));
  assert.deepEqual((await call('GET', `${resource('Sales Order')}?filters=${drafts}`)).body, { data: [] });
});

test('the list returns 20 documents by default and limit_page_length / limit_start page through them', async () => {
  const ref = newRef();
  for (let i = 0; i < 22; i++) await call('POST', resource('Sales Order'), { body: salesOrder(ref) });
  const filters = encodeURIComponent(JSON.stringify([['order_ref', '=', ref]]));
  assert.equal((await call('GET', `${resource('Sales Order')}?filters=${filters}`)).body.data.length, 20);
  const page = await call('GET', `${resource('Sales Order')}?filters=${filters}&limit_page_length=5&limit_start=20`);
  assert.equal(page.body.data.length, 2);
});

test('the simulator does not hide duplicates: the same order_ref can be created twice (the connector must prevent it)', async () => {
  const ref = newRef();
  const first = await call('POST', resource('Sales Order'), { body: salesOrder(ref) });
  const second = await call('POST', resource('Sales Order'), { body: salesOrder(ref) });
  assert.notEqual(first.body.data.name, second.body.data.name);
});

test('submit: draft -> docstatus 1 (method accepts POST and PUT); a second submit is 409, an unknown name 404', async () => {
  const created = await call('POST', resource('Sales Order'), { body: salesOrder(newRef()) });
  const { name } = created.body.data;
  const submitted = await submit('Sales Order', name);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.message.docstatus, 1);
  assert.equal(submitted.body.message.name, name);
  assert.equal((await call('GET', `${resource('Sales Order')}/${name}`)).body.data.docstatus, 1);

  const again = await call('PUT', '/api/method/frappe.client.submit', { body: { doc: { doctype: 'Sales Order', name } } });
  assert.equal(again.status, 409);
  assert.equal(again.body.exc_type, 'DocstatusTransitionError');
  assert.equal((await submit('Sales Order', 'SO-999999')).status, 404);
  assert.equal((await submit('Delivery Note', 'DN-1')).status, 404);
});

test('order to cash through the API: SO -> reserve -> SI -> PE, each linked to a submitted parent', async () => {
  const runId = await runWithStock(2);
  const ref = newRef();
  const so = await submittedSalesOrder(ref, runId);

  const reservation = await call('POST', resource('Stock Reservation Entry'), {
    body: { voucher_type: 'Sales Order', voucher_no: so, item_code: 'elden-ring', reserved_qty: 1, order_ref: ref },
    runId,
  });
  assert.equal(reservation.status, 200);
  assert.match(reservation.body.data.name, /^SRE-\d{4,}$/);
  assert.equal(reservation.body.data.docstatus, 1);

  const si = await call('POST', resource('Sales Invoice'), { body: { ...salesOrder(ref), sales_order: so }, runId });
  assert.equal(si.status, 200);
  assert.match(si.body.data.name, /^SINV-\d{4,}$/);
  assert.equal((await submit('Sales Invoice', si.body.data.name, { runId })).body.message.docstatus, 1);

  const pe = await call('POST', resource('Payment Entry'), {
    body: {
      party: 'Demo Customer', paid_amount: 5800, order_ref: ref,
      references: [{ reference_doctype: 'Sales Invoice', reference_name: si.body.data.name }],
    },
    runId,
  });
  assert.equal(pe.status, 200);
  assert.match(pe.body.data.name, /^PE-\d{4,}$/);
  assert.equal((await submit('Payment Entry', pe.body.data.name, { runId })).body.message.docstatus, 1);
});

test('links are checked: draft or missing parents, unknown customer or item -> 400 with a Frappe exc_type', async () => {
  const runId = await runWithStock(1);
  const ref = newRef();
  const draft = (await call('POST', resource('Sales Order'), { body: salesOrder(ref), runId })).body.data.name;

  const reserveDraft = await call('POST', resource('Stock Reservation Entry'), {
    body: { voucher_type: 'Sales Order', voucher_no: draft, item_code: 'elden-ring', reserved_qty: 1, order_ref: ref }, runId,
  });
  assert.equal(reserveDraft.status, 400);
  assert.equal(reserveDraft.body.exc_type, 'ValidationError');

  const invoiceDraft = await call('POST', resource('Sales Invoice'), { body: { ...salesOrder(ref), sales_order: draft }, runId });
  assert.equal(invoiceDraft.status, 400);

  const draftInvoice = (await call('POST', resource('Sales Invoice'), {
    body: { ...salesOrder(ref), sales_order: await submittedSalesOrder(ref, runId) }, runId,
  })).body.data.name;
  const payDraft = await call('POST', resource('Payment Entry'), {
    body: { party: 'Demo Customer', paid_amount: 1, order_ref: ref, references: [{ reference_doctype: 'Sales Invoice', reference_name: draftInvoice }] },
    runId,
  });
  assert.equal(payDraft.status, 400);

  const customer = await call('POST', resource('Sales Order'), { body: { ...salesOrder(ref), customer: 'Nobody' } });
  assert.equal(customer.body.exc_type, 'LinkValidationError');
  const item = await call('POST', resource('Sales Order'), { body: { ...salesOrder(ref), items: [{ item_code: 'no-such-game', qty: 1, rate: 1 }] } });
  assert.equal(item.status, 400);
  assert.equal(item.body.exc_type, 'LinkValidationError');
  assert.equal((await call('POST', resource('Payment Entry'), {
    body: { party: 'Demo Customer', paid_amount: 1, order_ref: ref, references: [{ reference_doctype: 'Sales Order', reference_name: draft }] },
  })).status, 400);
});

test('stock reservation: the quantity never goes below 0, parallel reserves of 3 copies -> exactly 3 entries', async () => {
  const runId = await runWithStock(3);
  const orders = [];
  for (let i = 0; i < 10; i++) orders.push({ ref: newRef() });
  for (const order of orders) order.so = await submittedSalesOrder(order.ref, runId);

  const results = await Promise.all(orders.map((order) => call('POST', resource('Stock Reservation Entry'), {
    body: { voucher_type: 'Sales Order', voucher_no: order.so, item_code: 'elden-ring', reserved_qty: 1, order_ref: order.ref }, runId,
  })));
  const refused = results.filter((res) => res.status === 409);
  assert.equal(results.filter((res) => res.status === 200).length, 3);
  assert.equal(refused.length, 7);
  assert.equal(refused[0].body.exc_type, 'InsufficientStock');

  const { rows } = await admin.query(
    `SELECT available FROM erpsim.item_stock WHERE scope = $1 AND item_code = 'elden-ring'`, [`run:${runId}`],
  );
  assert.equal(rows[0].available, 0);
});

test('a run has its own quantity: a run without any quantity cannot reserve, and the shop quantity is not used', async () => {
  const runId = newRun();
  const ref = newRef();
  const so = await submittedSalesOrder(ref, runId);
  const reserve = await call('POST', resource('Stock Reservation Entry'), {
    body: { voucher_type: 'Sales Order', voucher_no: so, item_code: 'elden-ring', reserved_qty: 1, order_ref: ref }, runId,
  });
  assert.equal(reserve.status, 409);
  assert.equal(reserve.body.exc_type, 'InsufficientStock');
});

test('stock receipts: a repeated receipt id adds nothing, a different receipt adds, an unknown item is 404', async () => {
  const runId = newRun();
  const add = (receiptId, qty) => call('POST', '/sim/stock-receipts', { body: { receiptId, itemCode: 'elden-ring', qty, runId } });
  assert.deepEqual((await add(`r-${runId}`, 2)).body, { applied: true });
  assert.deepEqual((await add(`r-${runId}`, 2)).body, { applied: false });
  assert.deepEqual((await add(`s-${runId}`, 3)).body, { applied: true });
  const { rows } = await admin.query(`SELECT available FROM erpsim.item_stock WHERE scope = $1`, [`run:${runId}`]);
  assert.equal(rows[0].available, 5);
  await admin.query('DELETE FROM erpsim.stock_additions WHERE receipt_id = ANY($1)', [[`r-${runId}`, `s-${runId}`]]);

  const unknown = await call('POST', '/sim/stock-receipts', { body: { receiptId: `u-${runId}`, itemCode: 'no-such-game', qty: 1, runId } });
  assert.equal(unknown.status, 404);
  const { rowCount } = await admin.query('SELECT 1 FROM erpsim.stock_additions WHERE receipt_id = $1', [`u-${runId}`]);
  assert.equal(rowCount, 0);
});

test('deleting a run removes its documents, quantity and receipts; other runs are untouched', async () => {
  const runId = await runWithStock(2);
  const other = await runWithStock(2);
  await submittedSalesOrder(newRef(), runId);
  await submittedSalesOrder(newRef(), other);

  const deleted = await call('DELETE', `/sim/runs/${runId}`);
  assert.deepEqual(deleted.body, { documents: 1, quantities: 1 });
  const left = async (id) => (await admin.query(
    `SELECT (SELECT count(*)::int FROM erpsim.documents WHERE scope = $1) AS documents,
            (SELECT count(*)::int FROM erpsim.item_stock WHERE scope = $1) AS quantities,
            (SELECT count(*)::int FROM erpsim.stock_additions WHERE scope = $1) AS additions`, [`run:${id}`],
  )).rows[0];
  assert.deepEqual(await left(runId), { documents: 0, quantities: 0, additions: 0 });
  assert.deepEqual(await left(other), { documents: 1, quantities: 1, additions: 1 });
  assert.deepEqual((await call('DELETE', `/sim/runs/${runId}`)).body, { documents: 0, quantities: 0 });
});

test('faults: latency delays, down = 503, rate limit = 429 with Retry-After, failure rate 1 = 500; internal routes are exempt', async () => {
  const runId = await runWithStock(1);
  const get = () => call('GET', resource('Sales Order'), { runId });
  const set = (faults) => redis.set(`faults:${runId}`, JSON.stringify(faults));

  await set({ latencyMs: 300 });
  const started = Date.now();
  assert.equal((await get()).status, 200);
  assert.ok(Date.now() - started >= 280, 'slow call');

  await set({ down: true });
  const down = await get();
  assert.equal(down.status, 503);
  assert.equal(down.body.exc_type, 'ServiceUnavailable');
  assert.equal((await call('POST', '/sim/stock-receipts', { body: { receiptId: `x-${runId}`, itemCode: 'elden-ring', qty: 1, runId } })).status, 200);

  await set({ rateLimitPerSec: 2 });
  const statuses = [];
  const startedSecond = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 4; i++) statuses.push((await get()).status);
  const sameSecond = Math.floor(Date.now() / 1000) === startedSecond;
  if (sameSecond) assert.deepEqual(statuses, [200, 200, 429, 429]);
  const limited = statuses.indexOf(429);
  assert.ok(limited >= 0, 'rate limit applied');

  await set({ failureRate: 1 });
  assert.equal((await get()).status, 500);

  await redis.del(`faults:${runId}`);
  assert.equal((await get()).status, 200);
});

test('rate limit reply carries Retry-After: 1', async () => {
  const runId = newRun();
  await redis.set(`faults:${runId}`, JSON.stringify({ rateLimitPerSec: 1 }));
  const replies = [];
  for (let i = 0; i < 6; i++) replies.push(await call('GET', resource('Sales Order'), { runId }));
  const limited = replies.find((res) => res.status === 429);
  assert.ok(limited, 'a call above the limit is refused');
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal(limited.body.exc_type, 'TooManyRequests');
});

test('fault settings are per scope: a run\'s faults do not touch other runs or the shop; shared faults hit only calls without X-Sim-Run', async () => {
  const faulty = newRun();
  const healthy = newRun();
  await redis.set(`faults:${faulty}`, JSON.stringify({ down: true }));
  assert.equal((await call('GET', resource('Sales Order'), { runId: faulty })).status, 503);
  assert.equal((await call('GET', resource('Sales Order'), { runId: healthy })).status, 200);
  assert.equal((await call('GET', resource('Sales Order'))).status, 200);
  assert.equal((await call('GET', '/health')).status, 200);

  await redis.set('faults:shared', JSON.stringify({ down: true }));
  try {
    assert.equal((await call('GET', resource('Sales Order'))).status, 503);
    assert.equal((await call('GET', resource('Sales Order'), { runId: healthy })).status, 200);
    const health = await call('GET', '/health');
    assert.equal(health.status, 503, 'health shows the ERP as down');
  } finally {
    await redis.del('faults:shared');
  }
  assert.equal((await call('GET', '/health')).status, 200);
});

test('bad input is 400 with nothing created and no error logged: shape, filters, header, JSON', async () => {
  const errorsBefore = lines.filter((line) => line.level >= 50).length;
  const ref = newRef();
  const before = (await admin.query('SELECT count(*)::int AS n FROM erpsim.documents')).rows[0].n;
  const badBodies = [
    null, [], {}, { ...salesOrder(ref), order_ref: '' }, { ...salesOrder(ref), customer: 5 }, { ...salesOrder(ref), items: [] },
    { ...salesOrder(ref), items: [{ item_code: 'elden-ring', qty: 0, rate: 1 }] },
    { ...salesOrder(ref), items: [{ item_code: 'elden-ring', qty: 1, rate: -1 }] },
    { ...salesOrder(ref), items: [{ item_code: 'elden-ring', qty: 1.5, rate: 1 }] },
    { ...salesOrder(ref), items: [{ item_code: 'a\0b', qty: 1, rate: 1 }] },
    { ...salesOrder(ref), currency: 'a\0b' },
  ];
  for (const body of badBodies) {
    const res = await call('POST', resource('Sales Order'), { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.exc_type, 'ValidationError');
  }
  assert.equal((await call('POST', resource('Sales Invoice'), { body: salesOrder(ref) })).status, 400); // no sales_order
  assert.equal((await call('POST', resource('Stock Reservation Entry'), { body: { order_ref: ref, voucher_type: 'Quotation' } })).status, 400);
  assert.equal((await call('POST', resource('Payment Entry'), { body: { order_ref: ref, party: 'Demo Customer', paid_amount: 1, references: [] } })).status, 400);

  const badQueries = [
    'filters=not-json', 'filters={}', 'filters=[["order_ref","like","x"]]', 'filters=[["body","=","x"]]',
    'filters=[["docstatus","=",7]]', `filters=${encodeURIComponent('[["order_ref","=","a\0b"]]')}`, 'fields=name', 'fields=[1]', 'limit_page_length=0', 'limit_page_length=abc', 'limit_start=-1',
  ];
  for (const query of badQueries) assert.equal((await call('GET', `${resource('Sales Order')}?${query}`)).status, 400, query);

  assert.equal((await call('GET', resource('Sales Order'), { runId: 'not-a-uuid' })).status, 400);
  assert.equal((await call('GET', `${resource('Sales Order')}/%00`)).status, 404);
  assert.equal((await call('POST', '/api/method/frappe.client.submit', { body: { doc: 'x' } })).status, 400);
  assert.equal((await call('POST', '/sim/stock-receipts', { body: { receiptId: 'r', itemCode: 'elden-ring', qty: 0 } })).status, 400);
  assert.equal((await call('POST', '/sim/stock-receipts', { body: { receiptId: 'r', itemCode: 'elden-ring', qty: 1, runId: 'x' } })).status, 400);
  assert.equal((await call('DELETE', '/sim/runs/not-a-uuid')).status, 400);
  assert.equal((await call('GET', resource('Delivery Note'))).status, 404);
  assert.equal((await call('GET', '/nope')).status, 404);

  const malformed = await fetch(`${base}${resource('Sales Order')}`, {
    method: 'POST', headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: '{broken',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).exc_type, 'ValidationError');

  assert.equal((await admin.query('SELECT count(*)::int AS n FROM erpsim.documents')).rows[0].n, before);
  assert.equal(lines.filter((line) => line.level >= 50).length, errorsBefore, 'no error-level log for a bad request');
});

test('a database failure: 500 internal error without details, and /health is 503 (stub database)', async () => {
  const stub = captureLogger();
  const failing = { ping: async () => { throw new Error('down'); }, findDocuments: async () => { throw new Error('secret detail'); } };
  const app = createErpSimApp({ db: failing, faults: { check: async () => null, isDown: async () => false }, config, logger: stub.logger });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: TOKEN };
    assert.equal((await fetch(`${url}/health`, { headers })).status, 503);
    const list = await fetch(`${url}${resource('Sales Order')}`, { headers });
    assert.equal(list.status, 500);
    assert.deepEqual(await list.json(), { exc_type: 'InternalServerError', exc: 'internal error' });
    assert.ok(stub.lines.some((line) => line.level === 50 && line.err?.message === 'secret detail'));
  } finally {
    server.close();
  }
});

test('a frozen database is bounded by the query timeout (stub timeout 200 ms against a row lock)', async () => {
  const db = createErpSimDb({ logger, queryTimeoutMs: 200 });
  const holder = new pg.Client();
  await holder.connect();
  const ref = newRef();
  const { rows } = await admin.query(
    `INSERT INTO erpsim.documents (doctype, name, docstatus, order_ref, scope, body)
     VALUES ('Sales Order', 'SO-LOCK-' || $1::text, 0, $1, 'shop', '{}') RETURNING name`, [ref],
  );
  await holder.query('BEGIN');
  await holder.query(`SELECT 1 FROM erpsim.documents WHERE name = $1 FOR UPDATE`, [rows[0].name]);
  try {
    await assert.rejects(db.submitDocument('Sales Order', rows[0].name), /Query read timeout/);
  } finally {
    await holder.query('ROLLBACK');
    await holder.end();
    await db.close();
  }
});

test('document names pad to four digits and keep growing past 9999 (no truncation, no repeated names)', () => {
  assert.deepEqual(
    [1, 42, 9999, 10000, 12213].map((n) => documentName('SO', n)),
    ['SO-0001', 'SO-0042', 'SO-9999', 'SO-10000', 'SO-12213'],
  );
});
