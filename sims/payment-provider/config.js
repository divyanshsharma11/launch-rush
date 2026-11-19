// Mock payment provider settings: env vars plus starting values (not measured). pg reads PG* itself.
export function loadProviderConfig(env) {
  return Object.freeze({
    host: env.PAYMENT_PROVIDER_HOST || '127.0.0.1',
    port: port(env, 'PAYMENT_PROVIDER_PORT'),
    webhookSecret: secret(env, 'PAYMENT_WEBHOOK_SECRET'),
    apiKey: secret(env, 'PAYMENT_API_KEY'),
    webhookUrl: httpUrl(env, 'PAYMENT_WEBHOOK_URL'),
    // All retries take about 35-70 min; must stay below the run cleanup delay.
    delivery: Object.freeze({
      retries: 12,
      baseDelayMs: 10_000,
      maxDelayMs: 600_000,
      jitter: 0.5,
      timeoutMs: 10_000,
      leaseMs: 30_000, // must be > timeoutMs
      pollMs: 1_000,
      batchSize: 10,
    }),
    runDuplicateShare: 0.05, // share of run payments whose webhook is sent twice
    log: Object.freeze({ level: logLevel(env, 'LOG_LEVEL') }),
  });
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

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

// Error messages name the variable, never its value.
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
