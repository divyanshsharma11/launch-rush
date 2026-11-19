// Orders left in an ERP or refund step with no live job. This happens when the final-failure hook could not run
// (PostgreSQL was down at that moment) or the job was lost (design §7 "After the final failure").
//   job failed  -> run the final-failure handling now: the order moves to failed, ready for replay
//   job missing -> add it again (job ids make a repeat harmless)
export function createRecovery({ db, fulfilment, paymentEvents, fulfilmentQueue, webhookQueue, config, logger }) {
  // The queue job that works on an order in this state.
  async function jobOf(order) {
    if (order.state !== 'refund_pending') {
      return {
        found: await fulfilmentQueue.find(order.id),
        add: () => fulfilmentQueue.add(order.id),
        fail: (err) => fulfilment.markFailed(order.id, err),
      };
    }
    const event = await db.findSucceededPayment(order.id);
    if (!event) return null;
    return {
      found: await webhookQueue.find(event.id),
      add: () => webhookQueue.add(event.id),
      fail: (err) => paymentEvents.markFailed(event, err),
    };
  }

  return {
    async run() {
      let failed = 0;
      let requeued = 0;
      // Page through all of them: orders whose job is alive stay in the list, and must not hide the ones behind them.
      for (let offset = 0, page = []; offset === 0 || page.length === config.batchSize; offset += config.batchSize) {
        page = await db.stuckOrders(config.graceMs, config.batchSize, offset);
        for (const order of page) {
          const job = await jobOf(order);
          if (!job) continue;
          if (job.found?.state === 'failed') {
            await job.fail(new Error(job.found.failedReason));
            failed += 1;
          } else if (!job.found) {
            await job.add();
            requeued += 1;
          }
        }
      }
      if (failed || requeued) logger.warn({ failed, requeued }, 'recovered orders without a live job');
      return { recoveredFailed: failed, recoveredRequeued: requeued };
    },
  };
}
