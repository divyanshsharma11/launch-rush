// Order-to-cash in the ERP (design §5.3): Sales Order, stock reservation, Sales Invoice, Payment Entry.
// Each step moves the order to its next state, so a retried job continues where the last one stopped.

export function createFulfilment({ db, erp, emailQueue, config, logger }) {
  const ctxFor = (order, action, attempt) => ({
    orderId: order.id, runId: order.runId, idempotencyKey: `${action}-${order.id}`, attempt, timeoutMs: config.callTimeoutMs,
  });
  const payloadOf = (order) => ({
    orderId: order.id, itemCode: order.gameId, amountMinor: order.amountMinor, currency: order.currency,
  });

  // One ERP call, tracked in the order's delivery row (attempts, status, last error).
  async function call(order, action, attempt) {
    const delivery = { orderId: order.id, connector: erp.id, action };
    await db.startDelivery(delivery);
    try {
      const doc = await erp.execute(action, payloadOf(order), ctxFor(order, action, attempt));
      await db.updateDelivery({ ...delivery, status: 'succeeded' });
      return doc;
    } catch (err) {
      await db.updateDelivery({ ...delivery, status: 'pending', error: err.message, failure: erp.classifyError(err) });
      throw err;
    }
  }

  async function record(order, doctype, action, attempt) {
    const { name, docstatus } = await call(order, action, attempt);
    await db.saveErpDocument({ orderId: order.id, doctype, name, docstatus });
  }

  const STEPS = {
    async paid(order, attempt) {
      await record(order, 'Sales Order', 'sales_order.submit', attempt);
      return db.transition(order.id, 'paid', 'so_submitted');
    },
    async so_submitted(order, attempt) {
      await record(order, 'Stock Reservation Entry', 'stock.reserve', attempt);
      await record(order, 'Sales Invoice', 'sales_invoice.submit', attempt);
      return db.transition(order.id, 'so_submitted', 'invoiced');
    },
    async invoiced(order, attempt) {
      await record(order, 'Payment Entry', 'payment_entry.submit', attempt);
      return db.transition(order.id, 'invoiced', 'completed');
    },
  };

  return {
    // After a lost race the loop reads the order again; every state has one step, so it ends quickly.
    async process(orderId, { attempt = 1 } = {}) {
      let order = await db.getOrder(orderId);
      while (Object.hasOwn(STEPS, order?.state)) {
        await STEPS[order.state](order, attempt);
        order = await db.getOrder(orderId);
      }
      if (order?.state !== 'completed') return;
      // Added whether or not this run made the last move: a crash after it must not lose the email job.
      if (order.hasEmail || order.isSimulated) await emailQueue.add(order.id);
      logger.info({ orderId }, 'order fulfilled');
    },

    // The last retry failed: the order moves to failed and its pending ERP deliveries too, kept for replay.
    async markFailed(orderId, err) {
      await db.failPendingDeliveries(orderId, erp.id, err.message);
      const order = await db.getOrder(orderId);
      if (Object.hasOwn(STEPS, order?.state) && (await db.transition(orderId, order.state, 'failed'))) {
        logger.error({ orderId, state: order.state, err }, 'fulfilment failed for good');
      }
    },
  };
}
