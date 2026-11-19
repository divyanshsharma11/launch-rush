// Error handling shared by connectors that call an outside system over HTTP.
export class UnsupportedActionError extends Error {}

// A non-2xx reply. code is the system's own error code when its body has one; retryAfter is the raw header.
export class UpstreamHttpError extends Error {
  constructor(system, status, code, retryAfter) {
    super(`${system} replied HTTP ${status}${code ? ` ${code}` : ''}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const RETRYABLE = Object.freeze({ kind: 'retryable' });
export const PERMANENT = Object.freeze({ kind: 'permanent' });

// 4xx other than 408/429 means the request itself is wrong, so a retry fails the same way.
// 5xx, 408, timeouts, network errors and anything unrecognised are retried (design §7).
export function classifyHttpError(err) {
  if (err instanceof UnsupportedActionError) return PERMANENT;
  if (!(err instanceof UpstreamHttpError)) return RETRYABLE;
  if (err.status === 429) {
    const retryAfterMs = parseRetryAfter(err.retryAfter);
    return retryAfterMs === null ? RETRYABLE : { kind: 'rateLimited', retryAfterMs };
  }
  return err.status >= 400 && err.status < 500 && err.status !== 408 ? PERMANENT : RETRYABLE;
}

// Retry-After is delay-seconds or an HTTP-date.
export function parseRetryAfter(value) {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
