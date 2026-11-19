// A payment whose webhook gave up on its way to us must not stay unknown: failed deliveries at the provider are
// sent again (Stripe's "process undelivered events"; design §6). Duplicates are harmless, ingress dedupes by event id.
export function createRedelivery({ payment, config, timeoutMs }) {
  return {
    async run() {
      const { redelivered } = await payment.execute('redeliver_failed', { maxAgeMs: config.maxAgeMs }, { timeoutMs });
      return { redelivered };
    },
  };
}
