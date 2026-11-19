// k6 load script: each iteration is one new visitor who buys a random game, pays and waits for the invoice.
// Needs the backend started with raised request limits (tools/load/README.md). Run: k6 run tools/load/storefront.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const RATE = Number(__ENV.RATE || 10); // new visitors per second at the plateau
const RAMP = __ENV.RAMP || '30s';
const HOLD = __ENV.HOLD || '60s';
const WAIT_MS = 60_000; // how long one visitor waits for the invoice
const FINISHED = ['completed', 'waitlist_ended', 'reservation_expired', 'refunded', 'failed'];

const completed = new Counter('orders_completed');
const notCompleted = new Counter('orders_not_completed'); // waitlisted, expired, refunded, failed or no answer in WAIT_MS
const limited = new Counter('responses_429');
const unexpected = new Counter('responses_unexpected');
const paidToCompleted = new Trend('pay_to_completed_ms', true); // measured by polling, so its resolution is the poll interval

export const options = {
  scenarios: {
    visitors: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 2000,
      stages: [
        { target: RATE, duration: RAMP },
        { target: RATE, duration: HOLD },
        { target: 0, duration: '5s' },
      ],
    },
  },
};

export function setup() {
  const session = http.post(`${BASE}/api/session`).json('sessionId');
  const games = http.get(`${BASE}/api/games`, { headers: { 'X-Session-Id': session } }).json('games');
  return { gameIds: games.filter((game) => game.stockLeft > 0).map((game) => game.id) };
}

function call(method, path, sessionId, body, name) {
  const params = { headers: { 'X-Session-Id': sessionId, 'Content-Type': 'application/json' }, tags: { name } };
  const response = http.request(method, `${BASE}/api${path}`, body === undefined ? null : JSON.stringify(body), params);
  if (response.status === 429) limited.add(1);
  return response;
}

export default function ({ gameIds }) {
  const created = http.post(`${BASE}/api/session`, null, { tags: { name: 'POST /session' } });
  if (created.status === 429) limited.add(1);
  if (!check(created, { 'session created': (r) => r.status === 201 })) return unexpected.add(1);
  const sessionId = created.json('sessionId');

  const gameId = gameIds[Math.floor(Math.random() * gameIds.length)];
  const bought = call('POST', '/orders', sessionId, { gameId }, 'POST /orders');
  if (!check(bought, { 'buy accepted': (r) => r.status === 201 })) return unexpected.add(1);
  const order = bought.json();
  if (order.state !== 'reserved') return notCompleted.add(1);

  const paid = call('POST', `/orders/${order.orderId}/pay`, sessionId, {}, 'POST /orders/:id/pay');
  if (!check(paid, { 'pay accepted': (r) => r.status === 202 })) return unexpected.add(1);

  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_MS) {
    sleep(0.5);
    const state = call('GET', `/orders/${order.orderId}`, sessionId, undefined, 'GET /orders/:id').json('state');
    if (FINISHED.includes(state)) {
      if (state === 'completed') {
        completed.add(1);
        paidToCompleted.add(Date.now() - startedAt);
      } else {
        notCompleted.add(1);
      }
      return;
    }
  }
  notCompleted.add(1);
}
