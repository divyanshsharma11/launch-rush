// Mock payment provider: webhook signer (design §5.2). Stripe's scheme:
// header `Mock-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
// Call sign() again for every delivery attempt, so each retry carries a fresh timestamp.
import { createHmac } from 'node:crypto';

// secret: PAYMENT_WEBHOOK_SECRET (shared with our ingress). now: injectable clock for tests.
export function createWebhookSigner({ secret, now = Date.now }) {
  return {
    // rawBody must be the exact bytes that will be sent, so the signature covers what the ingress receives.
    sign(rawBody) {
      if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody must be a Buffer');
      const t = Math.floor(now() / 1000);
      const v1 = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
      return `t=${t},v1=${v1}`;
    },
  };
}
