// payment-mock connector (design §3): the InboundVerifier for the webhook ingress, and the Connector that
// calls the mock provider's API. Signature scheme copied from Stripe:
// header `Mock-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
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

// A non-2xx reply from the provider; code is the provider's error code when its body has one.
export class ProviderHttpError extends Error {
  constructor(status, code, retryAfter) {
    super(`payment provider replied HTTP ${status}${code ? ` ${code}` : ''}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class UnsupportedActionError extends Error {}

const RETRYABLE = Object.freeze({ kind: 'retryable' });
const PERMANENT = Object.freeze({ kind: 'permanent' });

// baseUrl: the provider's origin. apiKey: sent as a Bearer token, never in errors or logs.
export function createPaymentConnector({ baseUrl, apiKey, healthTimeoutMs = 10_000 }) {
  async function call(path, { method = 'POST', body, headers, timeoutMs }) {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body && { 'Content-Type': 'application/json' }), ...headers },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new ProviderHttpError(res.status, errorCode(text), res.headers.get('retry-after'));
    return JSON.parse(text);
  }

  // A missing key must not be sent as the text "undefined": without the header the provider answers 400.
  const keyHeader = (ctx) => (ctx.idempotencyKey ? { 'Idempotency-Key': ctx.idempotencyKey } : {});

  const actions = {
    charge: ({ orderId, amountMinor, currency }, ctx) =>
      call('/charges', {
        body: { orderId, amountMinor, currency },
        headers: { ...keyHeader(ctx), ...(ctx.runId && { 'X-Sim-Run': ctx.runId }) },
        timeoutMs: ctx.timeoutMs,
      }),
    refund: ({ paymentId }, ctx) =>
      call('/refunds', { body: { paymentId }, headers: keyHeader(ctx), timeoutMs: ctx.timeoutMs }),
    resend_webhook: ({ paymentId }, ctx) =>
      call(`/payments/${encodeURIComponent(paymentId)}/resend-webhook`, { timeoutMs: ctx.timeoutMs }),
    redeliver_failed: ({ maxAgeMs }, ctx) =>
      call('/deliveries/redeliver-failed', { body: { maxAgeMs }, timeoutMs: ctx.timeoutMs }),
  };

  return {
    id: 'payment-mock',
    capabilities: Object.keys(actions),
    async execute(action, payload, ctx) {
      if (!Object.hasOwn(actions, action)) throw new UnsupportedActionError(`payment-mock has no action ${action}`);
      return actions[action](payload, ctx);
    },
    classifyError,
    async healthCheck() {
      try {
        await call('/health', { method: 'GET', timeoutMs: healthTimeoutMs });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// 4xx other than 408/429 means the request itself is wrong, so a retry fails the same way.
// 5xx, 408, timeouts, network errors and anything unrecognised are retried.
function classifyError(err) {
  if (err instanceof UnsupportedActionError) return PERMANENT;
  if (!(err instanceof ProviderHttpError)) return RETRYABLE;
  if (err.status === 429) {
    const retryAfterMs = parseRetryAfter(err.retryAfter);
    return retryAfterMs === null ? RETRYABLE : { kind: 'rateLimited', retryAfterMs };
  }
  return err.status >= 400 && err.status < 500 && err.status !== 408 ? PERMANENT : RETRYABLE;
}

// Retry-After is delay-seconds or an HTTP-date.
function parseRetryAfter(value) {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function errorCode(text) {
  try {
    const code = JSON.parse(text)?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}
