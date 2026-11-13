// Structured JSON logs with pino (plan §14 item 12): one JSON line per log on stdout.
import pino from 'pino';

// Safety net only: code should never pass the secret or the signature header to a log call.
const REDACT = [
  'webhookSecret',
  '*.webhookSecret',
  'headers["mock-signature"]',
  '*.headers["mock-signature"]',
];

// destination: optional writable (tests pass one to read the lines); default is stdout.
export function createLogger({ level }, destination) {
  return pino({ level, redact: REDACT }, destination);
}
