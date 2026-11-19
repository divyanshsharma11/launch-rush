// ERP simulator settings: env vars. pg reads PG* itself.
export function loadErpSimConfig(env) {
  return Object.freeze({
    host: env.ERP_SIM_HOST || '127.0.0.1',
    port: port(env, 'ERP_SIM_PORT'),
    apiKey: secret(env, 'ERP_API_KEY'),
    apiSecret: secret(env, 'ERP_API_SECRET'),
    redis: Object.freeze({ host: required(env, 'REDIS_HOST'), port: port(env, 'REDIS_PORT') }),
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
