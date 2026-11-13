// Mock payment provider: env vars + configurable starting values. Same style as src/config.js; sims/ may import
// only src/logger.js, so the small helpers below are repeated here. Only the entry point passes process.env.
// The pg library reads the PG* variables itself (the paysim schema lives in the same database).
export function loadProviderConfig(env) {
  return Object.freeze({
    host: env.PAYMENT_PROVIDER_HOST || '127.0.0.1', // all interfaces only when set, e.g. 0.0.0.0 at hosting (step 11)
    port: port(env, 'PAYMENT_PROVIDER_PORT'),
    webhookSecret: secret(env, 'PAYMENT_WEBHOOK_SECRET'), // signs webhooks (design §5.2)
    apiKey: secret(env, 'PAYMENT_API_KEY'), // Bearer key for our internal API, separate from the webhook secret
    webhookUrl: httpUrl(env, 'PAYMENT_WEBHOOK_URL'), // our ingress, e.g. http://127.0.0.1:3000/webhooks/payment
    // Webhook delivery retries: truncated exponential backoff with jitter, the same rule as design §7.
    // Wait before retry n = min(baseDelayMs * 2^(n-1), maxDelayMs), randomly 50-100% of it. Total ≈ 35-70 min,
    // which must stay below the run-cleanup delay (design §5.5). Starting values, not measured.
    delivery: Object.freeze({
      retries: 12,
      baseDelayMs: 10_000,
      maxDelayMs: 600_000,
      jitter: 0.5,
      timeoutMs: 10_000, // per attempt; opossum's default timeout (design §7)
      leaseMs: 30_000, // a claimed delivery is re-sent after this if the process died mid-send; must be > timeoutMs
    }),
    runDuplicateShare: 0.05, // share of run payments whose webhook is sent twice, same event id (design §5.5)
    log: Object.freeze({ level: logLevel(env, 'LOG_LEVEL') }),
  });
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']; // pino's levels

function logLevel(env, name) {
  const value = env[name] || 'info';
  if (!LOG_LEVELS.includes(value)) throw new Error(`${name} must be one of: ${LOG_LEVELS.join(', ')}`);
  return value;
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

function port(env, name) {
  const value = Number(required(env, name));
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return value;
}

// RFC 2104 §3: an HMAC key shorter than the hash output (32 bytes for SHA-256) is "strongly discouraged".
// The API key uses the same minimum. Error messages name the variable, never its value.
function secret(env, name) {
  const value = required(env, name);
  if (Buffer.byteLength(value) < 32) throw new Error(`${name} must be at least 32 bytes`);
  return value;
}

function httpUrl(env, name) {
  const value = required(env, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be an http or https URL`);
  return value;
}
