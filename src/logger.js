// Structured JSON logs with pino: one JSON line per log on stdout.
import pino from 'pino';

// Safety net only: code should never pass the secret or the signature header to a log call.
// apiKey / apiSecret / authorization: the Bearer key of the mock provider, the token of the ERP simulator.
const REDACT = [
  'webhookSecret',
  '*.webhookSecret',
  'headers["mock-signature"]',
  '*.headers["mock-signature"]',
  'apiKey',
  '*.apiKey',
  'apiSecret',
  '*.apiSecret',
  'headers.authorization',
  '*.headers.authorization',
];

// destination: optional writable (tests pass one to read the lines); default is stdout.
export function createLogger({ level }, destination) {
  return pino({ level, redact: REDACT }, destination);
}
