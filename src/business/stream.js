// What one open SSE stream sends (design §8). A stream follows one session: its own orders (state changes, email
// status, waitlist position, retries), its latest demo run, and the shared stock, scoreboard and breaker states.
// Wake-ups only make a read happen sooner; every read is also done by a timer, so a lost wake-up is a delay.
import { poolOf } from './waitlist-stock.js';
import { shopPool } from '../services/redis/index.js';

const GAMES_TTL_MS = 60_000;
const SUMMARY_TTL_MS = 10_000;

export function createStream({ db, redis, wakeups, reconciler, config, logger }) {
  let games = { at: 0, ids: [] };
  async function shopGameIds() {
    if (Date.now() - games.at > GAMES_TTL_MS) games = { at: Date.now(), ids: (await db.listShopGames()).map((game) => game.id) };
    return games.ids;
  }

  // One run summary per run and progress interval, shared by every stream that follows that run.
  const summaries = new Map();
  function runSummary(runId) {
    const cached = summaries.get(runId);
    if (cached && Date.now() - cached.at < config.progressMs) return cached.promise;
    for (const [id, entry] of summaries) if (Date.now() - entry.at > SUMMARY_TTL_MS) summaries.delete(id);
    const promise = db.getRun(runId).then((run) => run && reconciler.runSummary(run));
    summaries.set(runId, { at: Date.now(), promise });
    promise.catch(() => summaries.delete(runId));
    return promise;
  }

  // send(event, data) writes one event to the client. Returns the function that ends the stream.
  function open(sessionId, send) {
    let closed = false;
    let firstRead = true;
    let watched = new Set(); // ids of the orders being followed
    const cursors = {}; // order id -> id of the last transition sent for that order (design §8.4)
    const sent = new Map(); // what the page last got, so only changes are sent
    const breakersSent = new Map();
    let runId = null; // the run being followed, until its run.ended is sent
    let endedRunId = null;
    let ownRunId = null; // the session's latest run, whatever its status: its breakers are relevant
    let endedSeenAt = null;

    const emit = (event, data) => {
      if (!closed) send(event, data);
    };
    // True when the value differs from what was last sent under this key (or nothing was sent yet).
    const changed = (key, value) => {
      if (sent.get(key) === value) return false;
      sent.set(key, value);
      return true;
    };
    // One read at a time per kind; a request made during a read runs once more after it.
    function serial(read) {
      let running = false;
      let again = false;
      return async function run() {
        if (running) {
          again = true;
          return;
        }
        running = true;
        try {
          do {
            again = false;
            await read();
          } while (again && !closed);
        } catch (err) {
          logger.warn({ err }, 'stream read failed'); // the next tick tries again
        } finally {
          running = false;
        }
      };
    }

    async function readOrders() {
      let cards = await db.streamCards(sessionId, config.maxOrders);
      const ids = cards.map((card) => card.orderId);
      watched = new Set(ids);
      // A new connection starts from each order's current state; after that only what is newer than the cursor.
      const transitions = firstRead ? await db.latestTransitions(ids) : await db.transitionsAfter(ids, cursors);
      firstRead = false;
      // The invoice is saved just before the order moves to invoiced: if the cards were read before that, read them again.
      const needsInvoice = (t) => ['invoiced', 'completed'].includes(t.to) && !cards.find((c) => c.orderId === t.orderId).invoiceNo;
      if (transitions.some(needsInvoice)) cards = await db.streamCards(sessionId, config.maxOrders);
      const byId = new Map(cards.map((card) => [card.orderId, card]));
      for (const t of transitions.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
        cursors[t.orderId] = t.id;
        const invoiceNo = byId.get(t.orderId)?.invoiceNo;
        emit('order.state', { orderId: t.orderId, from: t.from, to: t.to, at: t.at, ...(invoiceNo && { invoiceNo }) });
      }
      for (const card of cards) {
        if (changed(`email:${card.orderId}`, card.emailStatus)) {
          emit('email.status', { orderId: card.orderId, emailStatus: card.emailStatus });
        }
        if (card.state !== 'waitlisted') continue;
        const waitlistPosition = await redis.waitlistPosition(poolOf(card), card.orderId);
        if (waitlistPosition !== null && changed(`position:${card.orderId}`, waitlistPosition)) {
          emit('waitlist.position', { orderId: card.orderId, waitlistPosition });
        }
      }
      for (const delivery of await db.retryingDeliveries(ids)) {
        if (changed(`retry:${delivery.orderId}:${delivery.action}`, delivery.attempt)) emit('delivery.retrying', delivery);
      }
    }

    async function readShared() {
      const run = await db.latestRunOfSession(sessionId);
      ownRunId = run?.id ?? null;
      if (run && run.id !== endedRunId && run.id !== runId) {
        runId = run.id;
        endedSeenAt = null;
      }

      const ids = await shopGameIds();
      const left = await redis.stockLeft(ids.map(shopPool));
      ids.forEach((gameId, i) => {
        if (changed(`stock:${gameId}`, left[i])) emit('stock', { gameId, stockLeft: left[i] });
      });

      const board = await redis.loadScoreboard();
      if (board && changed('scoreboard', board.checkedAt)) emit('scoreboard', board);

      await readBreakers();
    }

    // Breakers that matter to this session: the shared ones and its own run's. A removed entry means closed.
    async function readBreakers() {
      const relevant = (await redis.breakerStates()).filter((b) => b.runId === null || b.runId === ownRunId);
      const current = new Map(relevant.map((b) => [`${b.connector}:${b.runId}`, b]));
      for (const [key, known] of breakersSent) if (!current.has(key)) current.set(key, { ...known, state: 'closed' });
      for (const [key, b] of current) {
        if ((breakersSent.get(key)?.state ?? 'closed') === b.state) continue;
        breakersSent.set(key, b);
        emit('breaker.state', { connector: b.connector, runId: b.runId, state: b.state });
      }
    }

    // While the run is going, and after it ends until its orders have settled (or settleMs passed), send its progress;
    // then run.ended once: the progress fields, the final counters and invariant results.
    async function readProgress() {
      if (!runId) return;
      const summary = await runSummary(runId);
      if (!summary) return;
      if (summary.status !== 'running') {
        endedSeenAt ??= Date.now();
        if (summary.inFlight === 0 || Date.now() - endedSeenAt >= config.settleMs) {
          emit('run.ended', { ...summary, ...progressOf(summary) });
          endedRunId = runId;
          runId = null;
          return;
        }
      }
      if (changed('progress', JSON.stringify(progressOf(summary)))) emit('run.progress', progressOf(summary));
    }

    const orders = serial(readOrders);
    const shared = serial(readShared);
    const progress = serial(readProgress);

    const stopListening = wakeups.onOrder((orderId, sessionOfNewOrder) => {
      if (watched.has(orderId) || sessionOfNewOrder === sessionId) orders();
    });
    const tick = () => {
      orders();
      shared();
    };
    const tickTimer = setInterval(tick, config.tickMs);
    const progressTimer = setInterval(progress, config.progressMs);
    tick();

    return function close() {
      closed = true;
      clearInterval(tickTimer);
      clearInterval(progressTimer);
      stopListening();
    };
  }

  return { open };
}

const progressOf = (summary) => ({
  runId: summary.runId,
  reserved: summary.reserved,
  waitlisted: summary.waitlisted,
  paid: summary.sold,
  invoiced: summary.invoiced,
  refunded: summary.refunded,
  expired: summary.expired,
  waitlistEnded: summary.waitlistEnded,
  failed: summary.failed,
  duplicatesBlocked: summary.duplicatesBlocked,
  soldOut: summary.stockLeft === 0,
  stockLeft: summary.stockLeft,
  inFlight: summary.inFlight,
});
