// Mock payment provider: webhook signer, Stripe's scheme:
// Mock-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>. Sign again on every attempt.
import { createHmac } from 'node:crypto';

export function createWebhookSigner({ secret, now = Date.now }) {
  return {
    sign(rawBody) {
      if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody must be a Buffer');
      const t = Math.floor(now() / 1000);
      const v1 = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
      return `t=${t},v1=${v1}`;
    },
  };
}
