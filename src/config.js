// Env vars + configurable starting values (plan §14 item 10). Only entry points (api.js, worker.js) call
// loadConfig(process.env); other modules get values passed in, so tests never need a real .env.
// The pg library reads the PG* variables itself (see .env.example), so they are not repeated here.
export function loadConfig(env) {
  return Object.freeze({
    api: Object.freeze({
      host: env.API_HOST || '127.0.0.1', // all interfaces only when set, e.g. 0.0.0.0 at hosting (step 11)
      port: port(env, 'PORT'),
    }),
    payment: Object.freeze({
      webhookSecret: secret(env, 'PAYMENT_WEBHOOK_SECRET'),
      webhookToleranceSeconds: 300, // Stripe's default tolerance (design §5.2)
    }),
    redis: Object.freeze({
      host: required(env, 'REDIS_HOST'),
      port: port(env, 'REDIS_PORT'),
    }),
    // Webhook job options (design §5.2 step 4, §7). Starting values, tuned at the load step.
    webhookJob: Object.freeze({
      attempts: 5,
      backoff: Object.freeze({ type: 'exponential', delay: 2000, jitter: 0.5 }), // first retry after 1-2 s (design §7 note)
      removeOnComplete: true, // a late duplicate becomes a cheap no-op job (design §5.2)
      removeOnFail: Object.freeze({ count: 5000 }), // kept for admin replay (§6), bounded under noeviction
    }),
    log: Object.freeze({ level: logLevel(env, 'LOG_LEVEL') }),
  });
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']; // pino's levels

// Optional, default 'info'. Checked here because pino's own message for a bad level is unclear.
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
// Error messages name the variable, never its value.
function secret(env, name) {
  const value = required(env, name);
  if (Buffer.byteLength(value) < 32) throw new Error(`${name} must be at least 32 bytes`);
  return value;
}
