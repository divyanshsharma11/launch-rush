// Env vars + configurable starting values. Only entry points (api.js, worker.js) call
// loadConfig(process.env); other modules get values passed in, so tests never need a real .env.
// The pg library reads the PG* variables itself (see .env.example), so they are not repeated here.
import { join } from 'node:path';

export function loadConfig(env) {
  return Object.freeze({
    api: Object.freeze({
      host: env.API_HOST || '127.0.0.1', // all interfaces only when set, e.g. 0.0.0.0 in the containers (compose.prod.yaml)
      port: port(env, 'PORT'),
      trustProxy: trustProxy(env), // number of proxies in front of the API; 1 behind Caddy (compose.prod.yaml)
    }),
    payment: Object.freeze({
      webhookSecret: secret(env, 'PAYMENT_WEBHOOK_SECRET'),
      webhookToleranceSeconds: 300, // Stripe's default tolerance (design §5.2)
      providerUrl: httpUrl(env, 'PAYMENT_PROVIDER_URL'),
      apiKey: secret(env, 'PAYMENT_API_KEY'),
      callTimeoutMs: 10_000, // Pay and Duplicate wait at most this long for the provider (opossum's default timeout)
    }),
    erp: Object.freeze({
      baseUrl: httpUrl(env, 'ERP_SIM_URL'),
      apiKey: secret(env, 'ERP_API_KEY'),
      apiSecret: secret(env, 'ERP_API_SECRET'),
      callTimeoutMs: 10_000, // an ERP call waits at most this long (opossum's default timeout, design §7)
    }),
    // Gmail (design §5.1, §5.4). All empty until the owner connects Gmail (npm run gmail-connect): the email-gmail
    // connector then fails every send with gmail_reauth_required, which the owner can replay after connecting.
    gmail: gmailConfig(env),
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
    // Circuit breakers (design §3, §7). Starting values, tuned at the load step. timeoutMs is opossum's default;
    // volumeThreshold keeps one failed call from opening a breaker; a run's breaker is dropped after runIdleMs unused.
    breaker: Object.freeze({
      timeoutMs: 10_000,
      errorThresholdPercentage: 50,
      resetTimeoutMs: 30_000,
      volumeThreshold: 5,
      rollingCountTimeoutMs: 10_000,
      runIdleMs: 600_000,
    }),
    // A job that is delayed (ERP rate limit, open breaker) keeps its attempts but may start at most this often,
    // then it fails and waits for replay. Starting value, tuned at the load step.
    worker: Object.freeze({ maxStartedAttempts: 50 }),
    fulfilment: Object.freeze({ concurrency: 5 }), // fulfilment jobs processed at once; tuned at the load step
    // Shop restock (design §1.2): looks at every shop game this often; one timer restock per game per window;
    // batchSize: unfinished receipts finished per pass.
    restock: Object.freeze({ intervalMs: 30_000, windowMs: 600_000, batchSize: 50 }),
    // Hold and wait times and the expiry sweeper. Starting values.
    stock: Object.freeze({ shopHoldMs: 300_000, runHoldMs: 30_000, waitlistMs: 600_000 }),
    sweeper: Object.freeze({ intervalMs: 5000, batchSize: 100 }),
    // Demo runs. Caps, behaviour shares and times are configurable starting values, not measurements.
    runs: Object.freeze({
      maxBuyers: 500,
      maxDurationMs: 300_000,
      maxRunning: 3,
      arrivalWindowMs: 10_000, // simulated buyers all arrive within this time
      tickMs: 500, // the run driver looks at its orders this often
      lateDelayMs: 10_000, // a late payer charges this long after its hold ended (two sweeper passes)
      // Shares add up to 1: pays in time, never pays, pays after the hold, clicks Buy twice then pays in time.
      behaviours: Object.freeze({ pays: 0.7, never: 0.15, late: 0.1, doubleClick: 0.05 }),
      cleanupAfterMs: 7_200_000, // 2 h: longer than the payment provider's webhook retry window
      cleanupBatch: 20,
    }),
    // Request limits per window (design §5 conventions): session creation per client IP, every other visitor
    // call per session. Starting values, tuned at the load step.
    rateLimits: Object.freeze({
      sessionCreate: Object.freeze({ limit: perMinute(env, 'RATE_LIMIT_SESSION_CREATE_PER_MIN', 10), windowMs: 60_000 }),
      session: Object.freeze({ limit: perMinute(env, 'RATE_LIMIT_SESSION_PER_MIN', 120), windowMs: 60_000 }),
      adminLogin: Object.freeze({ limit: 5, windowMs: 60_000 }), // login attempts per client IP (design §5.4)
    }),
    reconciler: Object.freeze({ intervalMs: 10_000, graceMs: 60_000 }),
    // Recovery of orders that sit in an ERP or refund step without a live job (design §7). Starting values.
    recovery: Object.freeze({ intervalMs: 30_000, graceMs: 60_000, batchSize: 100 }), // batchSize: orders per page
    // Failed webhook deliveries at the payment provider are sent again for this long (design §6). Starting values.
    redelivery: Object.freeze({ intervalMs: 60_000, maxAgeMs: 86_400_000 }),
    // Confirmation emails (design §5.1 real-email cap, §1.2 email purge). The caps are the owner's values; the rest
    // are starting values. Both Gmail caps stay well under Gmail's own limit of about 500 a day.
    email: Object.freeze({
      concurrency: 5,
      callTimeoutMs: 8000, // one deadline for a whole Gmail send; under the breaker's timeout, so a breaker timeout never leaves a send in flight
      caps: Object.freeze({ perSession: 2, perDay: 200, dayKeyTtlSeconds: 172_800 }), // day sets are kept 2 days
      purge: Object.freeze({ intervalMs: 600_000, afterMs: 86_400_000 }), // a visitor's address is kept 24 hours
    }),
    // CORS (design §5): only the portfolio's origin may call the API from a browser. The default is the Vite dev
    // server; set PORTFOLIO_ORIGIN when hosting. maxAgeSeconds: how long a browser may reuse a preflight answer.
    cors: Object.freeze({ allowedOrigin: origin(env, 'PORTFOLIO_ORIGIN', 'http://localhost:5173'), maxAgeSeconds: 600 }),
    // SSE streams (design §8). Starting values, tuned at the load step. tickMs: the fallback read that makes a lost
    // wake-up only a delay; progressMs: at most one run.progress per this; settleMs: after a run ends, its progress
    // goes on this long while orders are still being processed, then run.ended is sent; maxOrders: the newest orders
    // of a session that a stream follows; maxPerSession: open streams per session (each holds timers and reads the
    // database).
    stream: Object.freeze({
      retryMs: 3000, pingMs: 15_000, tickMs: 2000, progressMs: 500, settleMs: 60_000, maxOrders: 50, maxPerSession: 3,
    }),
    admin: adminConfig(env),
    log: Object.freeze({ level: logLevel(env, 'LOG_LEVEL') }),
  });
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']; // pino's levels

// Optional, default `fallback`. Only the load run raises the two visitor limits (tools/load); the admin login limit stays fixed.
function perMinute(env, name, fallback) {
  if (!env[name]) return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number of at least 1`);
  return value;
}

// Optional, default 'info'. Checked here because pino's own message for a bad level is unclear.
function logLevel(env, name) {
  const value = env[name] || 'info';
  if (!LOG_LEVELS.includes(value)) throw new Error(`${name} must be one of: ${LOG_LEVELS.join(', ')}`);
  return value;
}

// Optional as a whole. Client id and secret go together; a refresh token needs them and the sender address.
function gmailConfig(env) {
  const names = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_ADDRESS'];
  const [clientId, clientSecret, refreshToken, address] = names.map((name) => env[name] || null);
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET go together');
  if (refreshToken && !(clientId && address)) throw new Error('GMAIL_REFRESH_TOKEN needs GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_ADDRESS');
  return Object.freeze({ clientId, clientSecret, refreshToken, address });
}

// The owner's admin login (design §5.4). null (no /admin routes) until the password hash and salt are set
// (npm run admin-hash prints them). origin: where the admin page is served; defaults to the API's own address.
function adminConfig(env) {
  const hash = env.ADMIN_PASSWORD_HASH;
  const salt = env.ADMIN_PASSWORD_SALT;
  if (!hash && !salt) return null;
  if (!hash || !salt) throw new Error('ADMIN_PASSWORD_HASH and ADMIN_PASSWORD_SALT go together');
  if (!/^[0-9a-f]{128}$/.test(hash)) throw new Error('ADMIN_PASSWORD_HASH must be 128 lower-case hex characters');
  if (!/^[0-9a-f]{32,}$/.test(salt) || salt.length % 2 !== 0) {
    throw new Error('ADMIN_PASSWORD_SALT must be at least 32 lower-case hex characters');
  }
  const fallback = new URL(`http://${env.API_HOST || '127.0.0.1'}:${env.PORT}`).origin;
  return Object.freeze({
    passwordHash: Buffer.from(hash, 'hex'),
    passwordSalt: Buffer.from(salt, 'hex'),
    origin: origin(env, 'ADMIN_ORIGIN', fallback),
    sessionTtlSeconds: 28_800,
    pageDir: join(import.meta.dirname, '..', 'admin', 'dist'), // the built admin page (admin/, npm run build there)
  });
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

// Express "trust proxy" as a hop count (expressjs.com/en/guide/behind-proxies): 0 reads the client IP from the socket only.
function trustProxy(env) {
  const value = env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' ? 0 : Number(env.TRUST_PROXY);
  if (!Number.isInteger(value) || value < 0 || value > 10) throw new Error('TRUST_PROXY must be an integer from 0 to 10');
  return value;
}

// RFC 2104 §3: an HMAC key shorter than the hash output (32 bytes for SHA-256) is "strongly discouraged".
// Error messages name the variable, never its value.
function secret(env, name) {
  const value = required(env, name);
  if (Buffer.byteLength(value) < 32) throw new Error(`${name} must be at least 32 bytes`);
  return value;
}

// An origin as browsers send it: scheme, host and optional port, no path and no trailing slash.
function origin(env, name, fallback) {
  const value = env[name] || fallback;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an origin such as https://example.com`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new Error(`${name} must be an origin such as https://example.com`);
  }
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
