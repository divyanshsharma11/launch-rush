// Mock payment provider: webhook delivery loop with retries. Never logs the body or the signature.
export function createDeliverer({ db, signer, config, logger }) {
  const { retries, baseDelayMs, maxDelayMs, jitter, timeoutMs, leaseMs, pollMs, batchSize } = config.delivery;
  const maxAttempts = 1 + retries;
  let timer = null;
  let running = null;
  let stopped = true;

  // Exponential backoff with jitter, capped; whole ms (the SQL casts it to integer).
  function retryDelayMs(attempts) {
    const max = Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs);
    return Math.round(max * (1 - jitter * Math.random()));
  }

  // Returns null on a 2xx, else the error text for last_error.
  async function send(delivery) {
    const body = Buffer.from(delivery.body);
    try {
      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Mock-Signature': signer.sign(body) },
        body,
        redirect: 'manual', // a redirect counts as a failure, as at Stripe
        signal: AbortSignal.timeout(timeoutMs),
      });
      // An unread body can keep the connection busy (undici).
      await res.body?.cancel().catch(() => {});
      return res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`;
    } catch (err) {
      return err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code ?? err.name);
    }
  }

  // Never throws, so one failure cannot stop the batch.
  async function handle(delivery) {
    const log = { deliveryId: delivery.id, eventId: delivery.eventId, attempts: delivery.attempts };
    try {
      if (delivery.attempts > maxAttempts) {
        // The last attempt died mid-send.
        await db.markFailed({ id: delivery.id, error: 'attempts used up' });
        logger.error({ ...log, maxAttempts }, 'webhook delivery gave up (attempts used up)');
        return;
      }
      const error = await send(delivery);
      if (error === null) {
        await db.markDelivered(delivery.id);
        logger.info(log, 'webhook delivered');
      } else if (delivery.attempts >= maxAttempts) {
        await db.markFailed({ id: delivery.id, error });
        logger.error({ ...log, error }, 'webhook delivery gave up');
      } else {
        const retryInMs = retryDelayMs(delivery.attempts);
        await db.scheduleRetry({ id: delivery.id, delayMs: retryInMs, error });
        logger.warn({ ...log, error, retryInMs }, 'webhook delivery failed, retrying');
      }
    } catch (err) {
      logger.error({ ...log, err }, 'webhook delivery update failed; retried after the lease');
    }
  }

  // Sent in parallel, so the whole batch ends inside the lease.
  async function runOnce() {
    const claimed = await db.claimDueDeliveries({ limit: batchSize, leaseMs });
    await Promise.all(claimed.map(handle));
    return claimed.length;
  }

  // Ticks never overlap; after a full batch the next one starts at once.
  async function tick() {
    let claimed = 0;
    try {
      claimed = await runOnce();
    } catch (err) {
      logger.error({ err }, 'webhook delivery tick failed');
    }
    if (!stopped) timer = setTimeout(() => { running = tick(); }, claimed === batchSize ? 0 : pollMs);
  }

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      running = tick();
    },
    // Waits for the tick in progress.
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
