// The run driver: acts for the simulated buyers of one run with the same Buy and Pay logic as the API, but not its
// HTTP layer, so the per-session rate limits do not apply to it.
import { BusinessError } from './errors.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRunDriver({ db, orders, config, logger, random = Math.random }) {
  const { runs: caps, stock } = config;

  // Shares add up to 1; the last behaviour also catches a rounding gap.
  function pickBehaviour() {
    const shares = Object.entries(caps.behaviours);
    let roll = random();
    for (const [name, share] of shares) {
      if (roll < share) return name;
      roll -= share;
    }
    return shares.at(-1)[0];
  }

  // A late payer clicks Pay in time and only the charge is late: the webhook job ignores a payment for a reserved order.
  const clickPay = (buyer, order) =>
    orders.startPayment(order).catch((err) => {
      buyer.acted = true;
      logger.warn({ err, buyer: buyer.ref }, 'simulated payment not started');
    });

  const payTime = (buyer, order) => {
    if (buyer.behaviour === 'late') return order.reservedUntil.getTime() + caps.lateDelayMs;
    return Date.now() + stock.runHoldMs * (0.1 + 0.5 * random());
  };

  async function buy(buyer, game, run) {
    try {
      const { order } = await orders.reserve({ game, run, buyerRef: buyer.ref, isSimulated: true });
      buyer.orderId = order.id;
    } catch (err) {
      if (!(err instanceof BusinessError)) throw err;
      if (err.code === 'already_reserved') buyer.orderId = err.fields.orderId; // this run's job was started again
      return;
    }
    if (buyer.behaviour === 'doubleClick') {
      await orders.reserve({ game, run, buyerRef: buyer.ref, isSimulated: true }).catch((err) => {
        if (!(err instanceof BusinessError)) throw err; // refused: already_reserved, counted as a duplicate blocked
      });
    }
  }

  async function act(buyer) {
    const order = await db.getOrder(buyer.orderId);
    if (buyer.behaviour !== 'late') await orders.startPayment(order);
    await orders.charge(order);
  }

  // Runs until the run ends (status changed or its time is up). Errors of one buyer never stop the others.
  // Returns false when the signal stopped it first (worker shutdown): the run is not over, the job must be given back.
  async function drive(runId, signal) {
    const run = await db.getRun(runId);
    if (!run || run.status !== 'running') return;
    const game = await db.getGame(run.gameId);
    const startedAt = Date.now();
    const buyers = Array.from({ length: run.buyersRequested }, (_, i) => ({
      ref: `sim-${i + 1}`,
      behaviour: pickBehaviour(),
      arriveAt: startedAt + random() * caps.arrivalWindowMs,
      orderId: null,
      actAt: null,
      acted: false,
    }));
    let charged = 0;
    logger.info({ runId, buyers: buyers.length }, 'run driver started');

    for (;;) {
      if (signal?.aborted) return false;
      const current = await db.getRun(runId);
      if (!current || current.status !== 'running' || Date.now() >= current.endsAt.getTime()) break;
      const now = Date.now();

      await Promise.all(
        buyers.filter((b) => !b.orderId && b.arriveAt <= now).map((b) => buy(b, game, run).catch((err) => {
          logger.error({ err, runId, buyer: b.ref }, 'simulated buy failed');
        })),
      );

      const states = new Map((await db.runSimulatedOrders(runId)).map((order) => [order.id, order]));
      const clicks = [];
      for (const buyer of buyers) {
        const order = states.get(buyer.orderId);
        if (order?.state !== 'reserved' || buyer.actAt !== null) continue; // a copy is held: the behaviour starts
        if (buyer.behaviour === 'never') {
          buyer.acted = true;
          continue;
        }
        buyer.actAt = payTime(buyer, order);
        if (buyer.behaviour === 'late') clicks.push(clickPay(buyer, order));
      }
      await Promise.all(clicks);

      await Promise.all(
        buyers.filter((b) => !b.acted && b.actAt !== null && b.actAt <= now).map((b) => {
          b.acted = true;
          return act(b).then(() => { charged += 1; }).catch((err) => {
            logger.warn({ err, runId, buyer: b.ref }, 'simulated payment not made'); // e.g. the hold ended first
          });
        }),
      );
      await wait(caps.tickMs);
    }
    logger.info({ runId, charged }, 'run driver finished');
    return true;
  }

  return { drive };
}
