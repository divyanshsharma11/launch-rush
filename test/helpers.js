// Shared test fixtures. Setup/cleanup SQL here is test-only; app SQL stays in src/services/db.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { Queue } from 'bullmq';
import { createLogger } from '../src/logger.js';

export const SECRET = 'a'.repeat(32);

// A real pino logger whose JSON lines are collected in `lines` (parsed) instead of stdout.
export function captureLogger() {
  const lines = [];
  const logger = createLogger({ level: 'info' }, { write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

// One session + one payment_pending order. Deleting the order cascades to payment_events.
export async function createTestOrder() {
  const admin = new pg.Client();
  const sessionId = randomUUID();
  const orderId = randomUUID();
  await admin.connect();
  await admin.query('INSERT INTO sessions (id) VALUES ($1)', [sessionId]);
  await admin.query(
    `INSERT INTO orders (id, session_id, game_id, amount_minor, currency, state)
     VALUES ($1, $2, 'elden-ring', 580000, 'INR', 'payment_pending')`,
    [orderId, sessionId],
  );
  return {
    admin,
    orderId,
    async remove() {
      await admin.query('DELETE FROM orders WHERE id = $1', [orderId]);
      await admin.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      await admin.end();
    },
  };
}

// A test-only game (unique id, listed) and a session. remove() deletes everything that refers to the game,
// then the game and sessions. Redis keys are the caller's to delete.
export async function createTestShop({ stockTotal = 2, priceMinor = 450000 } = {}) {
  const admin = new pg.Client();
  await admin.connect();
  const gameId = `test-${randomUUID()}`;
  await admin.query(
    `INSERT INTO games (id, title, price_minor, currency, stock_total, listed_in_shop)
     VALUES ($1, 'Test Game', $2, 'INR', $3, true)`,
    [gameId, priceMinor, stockTotal],
  );
  const sessions = [];
  return {
    admin,
    gameId,
    async newSession() {
      const { rows } = await admin.query('INSERT INTO sessions DEFAULT VALUES RETURNING id');
      sessions.push(rows[0].id);
      return rows[0].id;
    },
    // A session created elsewhere (e.g. through the API) that remove() should delete too.
    trackSession: (id) => sessions.push(id),
    async remove() {
      await admin.query('DELETE FROM orders WHERE game_id = $1', [gameId]);
      await admin.query('DELETE FROM demo_runs WHERE game_id = $1', [gameId]);
      await admin.query('DELETE FROM stock_receipts WHERE game_id = $1', [gameId]);
      await admin.query('DELETE FROM games WHERE id = $1', [gameId]);
      await admin.query('DELETE FROM sessions WHERE id = ANY($1)', [sessions]);
      await admin.end();
    },
  };
}

export async function countPaymentEvents(admin, eventId) {
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM payment_events WHERE event_id = $1', [eventId]);
  return rows[0].n;
}

export function paymentEvent(id, orderId) {
  return {
    id,
    type: 'payment.succeeded',
    created: 1_800_000_000,
    data: { paymentId: 'pay_test', orderId, amountMinor: 580000, currency: 'INR' },
  };
}

// Signs like the mock provider: v1 = HMAC-SHA256(secret, "<t>.<raw body>").
export function signatureHeader(raw, secret = SECRET) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return `t=${t},v1=${v1}`;
}

// A uniquely named queue name plus a reader for it; cleanup() deletes the queue.
export function testQueue(connection) {
  const name = `webhooks-test-${randomUUID()}`;
  const inspect = new Queue(name, { connection });
  return {
    name,
    inspect,
    async cleanup() {
      await inspect.obliterate({ force: true });
      await inspect.close();
    },
  };
}

// The ERP simulator only knows the catalog games: a test game needs its own item and shop quantity there.
// removeErpItem() deletes everything the simulator holds for it.
export async function addErpItem(admin, itemCode, shopQty) {
  await admin.query('INSERT INTO erpsim.items (item_code) VALUES ($1)', [itemCode]);
  await admin.query("INSERT INTO erpsim.item_stock (scope, item_code, available) VALUES ('shop', $1, $2)", [itemCode, shopQty]);
}

export async function removeErpItem(admin, itemCode) {
  await admin.query(
    `DELETE FROM erpsim.documents WHERE doctype = 'Payment Entry' AND body->'references'->0->>'reference_name' IN
       (SELECT name FROM erpsim.documents WHERE doctype = 'Sales Invoice' AND body->'items'->0->>'item_code' = $1)`,
    [itemCode],
  );
  await admin.query("DELETE FROM erpsim.documents WHERE body->'items'->0->>'item_code' = $1 OR body->>'item_code' = $1", [itemCode]);
  await admin.query('DELETE FROM erpsim.stock_additions WHERE item_code = $1', [itemCode]);
  await admin.query('DELETE FROM erpsim.item_stock WHERE item_code = $1', [itemCode]);
  await admin.query('DELETE FROM erpsim.items WHERE item_code = $1', [itemCode]);
}

// The shop quantity the simulator holds for an item.
export async function erpShopQty(admin, itemCode) {
  const { rows } = await admin.query("SELECT available FROM erpsim.item_stock WHERE scope = 'shop' AND item_code = $1", [itemCode]);
  return rows[0]?.available;
}

// A fake Google on 127.0.0.1: the OAuth token endpoint (refresh and authorization-code grants) and Gmail's
// messages.send, shaped as in Google's docs. A real HTTP server, so the connectors run unchanged.
// - sent: every accepted message { bearer, raw, message } (message = decoded raw text)
// - sendFailures: replies handed out one per send before sends succeed again, { status, body?, headers? }
// - tokenFailure: when set, every refresh gets this reply { status, body }
// - rejectAccessTokens(): access tokens issued so far stop working (a send with one gets 401)
export async function startFakeGoogle({ clientId = 'client-id', clientSecret = 'client-secret', refreshToken = 'refresh-1' } = {}) {
  const state = { refreshes: 0, sent: [], sendFailures: [], tokenFailure: null, codes: new Map(), valid: new Set(), refreshToken };
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/token') {
      const form = new URLSearchParams(body);
      if (state.tokenFailure) return json(res, state.tokenFailure.status, state.tokenFailure.body);
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
        return json(res, 401, { error: 'invalid_client' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== state.refreshToken) return json(res, 400, { error: 'invalid_grant' });
        state.refreshes += 1;
        const access = `access-${state.refreshes}`;
        state.valid.add(access);
        return json(res, 200, { access_token: access, expires_in: 3599, scope: 'x', token_type: 'Bearer' });
      }
      const grant = state.codes.get(form.get('code'));
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (form.get('grant_type') !== 'authorization_code' || !grant || grant.challenge !== challenge
        || grant.redirectUri !== form.get('redirect_uri')) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      return json(res, 200, { access_token: 'access-code', expires_in: 3599, refresh_token: 'refresh-from-code', token_type: 'Bearer' });
    }
    if (req.url === '/gmail/v1/users/me/messages/send' && req.method === 'POST') {
      const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
      const failure = state.sendFailures.shift();
      if (failure) return json(res, failure.status, failure.body ?? {}, failure.headers);
      if (!state.valid.has(bearer)) {
        return json(res, 401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
      }
      const { raw } = JSON.parse(body);
      state.sent.push({ bearer, raw, message: Buffer.from(raw, 'base64url').toString('utf8') });
      return json(res, 200, { id: `msg-${state.sent.length}`, threadId: 't', labelIds: ['SENT'] });
    }
    return json(res, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return Object.assign(state, {
    clientId,
    clientSecret,
    tokenUrl: `${origin}/token`,
    apiUrl: origin,
    rejectAccessTokens: () => state.valid.clear(),
    close: () => new Promise((resolve) => server.close(resolve)),
  });
}

const ORDER_PATH = ['reserved', 'payment_pending', 'paid', 'so_submitted', 'invoiced', 'completed'];

// A visitor's order that went through Pay (with an address, if given) and the ERP: state completed, one submitted
// Sales Invoice. shop comes from createTestShop(); db from createDb().
export async function completedOrder(shop, db, { sessionId, email = null, invoiceNo = 'SINV-0001' }) {
  const order = await db.insertOrder({ id: randomUUID(), sessionId, gameId: shop.gameId, state: 'reserved', holdMs: 300_000 });
  for (let i = 1; i < ORDER_PATH.length; i += 1) {
    await db.transition(order.id, ORDER_PATH[i - 1], ORDER_PATH[i], i === 1 ? { email } : {});
  }
  await shop.admin.query(
    `INSERT INTO erp_documents (order_id, doctype, name, docstatus) VALUES ($1, 'Sales Invoice', $2, 1)`,
    [order.id, invoiceNo],
  );
  return order.id;
}

// A simulated rush buyer's completed order inside a new demo run of the shop's game.
export async function completedRunOrder(shop, db, sessionId) {
  const { rows } = await shop.admin.query(
    `INSERT INTO demo_runs (session_id, game_id, stock_total, buyers_requested, faults, status, ends_at)
     VALUES ($1, $2, 1, 1, '{}', 'finished', now() + interval '5 minutes') RETURNING id`,
    [sessionId, shop.gameId],
  );
  const order = await db.insertOrder({
    id: randomUUID(), gameId: shop.gameId, state: 'reserved', holdMs: 30_000, runId: rows[0].id, buyerRef: 'sim-1', isSimulated: true,
  });
  for (let i = 1; i < ORDER_PATH.length; i += 1) await db.transition(order.id, ORDER_PATH[i - 1], ORDER_PATH[i]);
  return order.id;
}
