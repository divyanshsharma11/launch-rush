// payment-mock connector (design §3). This piece: InboundVerifier only (design §5.2 steps 1-2).
// Scheme copied from Stripe: header `Mock-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
import { createHmac, timingSafeEqual } from 'node:crypto';

export class InvalidSignatureError extends Error {
  code = 'invalid_signature';
}

// Signature is valid but the body is not JSON: 400, because the sender's body is invalid, not our server (design §5.2 step 2).
export class InvalidPayloadError extends Error {
  code = 'invalid_payload';
}

// secret: PAYMENT_WEBHOOK_SECRET. now: injectable clock for tests. Never logs or returns the secret or the expected signature.
export function createInboundVerifier({ secret, toleranceSeconds = 300, now = Date.now }) {
  return {
    verifyInbound(rawBody, headers) {
      const { t, signatures } = parseHeader(headers['mock-signature']);
      if (Math.floor(now() / 1000) - t > toleranceSeconds) throw new InvalidSignatureError('timestamp too old');

      const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
      // Lengths are equal by construction (64 hex chars = 32 bytes), so timingSafeEqual never throws here.
      if (!signatures.some((hex) => timingSafeEqual(Buffer.from(hex, 'hex'), expected))) {
        throw new InvalidSignatureError('signature mismatch');
      }
      try {
        return JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new InvalidPayloadError('body is not valid JSON');
      }
    },
  };
}

// Exactly one t (digits) and at least one v1 (64 lowercase hex chars); other schemes are ignored (Stripe: downgrade protection).
function parseHeader(value) {
  if (typeof value !== 'string') throw new InvalidSignatureError('missing Mock-Signature header');
  const times = [];
  const signatures = [];
  for (const part of value.split(',')) {
    const [key, val] = part.trim().split('=');
    if (key === 't') times.push(val);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(val)) signatures.push(val);
  }
  if (times.length !== 1 || !/^\d+$/.test(times[0]) || signatures.length === 0) {
    throw new InvalidSignatureError('malformed Mock-Signature header');
  }
  return { t: Number(times[0]), signatures };
}
