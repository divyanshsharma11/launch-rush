// email-gmail connector (design §3, §7): sends through the Gmail API with the owner's refresh token.
// Plain fetch against Google's documented endpoints: no client library.
import { PERMANENT, UnsupportedActionError, UpstreamHttpError, classifyHttpError, parseRetryAfter } from './http-errors.js';

const RETRYABLE = Object.freeze({ kind: 'retryable' });
// Google's reasons for "too many requests" sent as 403 (Gmail handle-errors guide).
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
// A token is renewed this long before it expires.
const EXPIRY_MARGIN_MS = 60_000;

// The refresh token is revoked or missing, or Google rejected the client: the owner connects Gmail again.
export class ReauthRequiredError extends Error {
  code = 'gmail_reauth_required';
}

// The message cannot be sent as given: no usable recipient, or a header value that could inject more headers.
export class InvalidEmailError extends Error {}

// One plain address; no spaces, commas or brackets, so a value can never become several recipients or headers.
const ADDRESS = /^[^\s<>,;"()\\]+@[^\s<>,;"()\\]+$/;

export function createGmailConnector({
  clientId, clientSecret, refreshToken, address, senderName,
  tokenUrl = 'https://oauth2.googleapis.com/token', apiUrl = 'https://gmail.googleapis.com', healthTimeoutMs = 10_000,
}) {
  let token = null; // { value, expiresAt }
  let refreshing = null; // one refresh at a time, shared by concurrent sends

  async function refresh(signal) {
    if (!refreshToken) throw new ReauthRequiredError('Gmail is not connected (run npm run gmail-connect)');
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
      }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const code = jsonOf(text)?.error;
      if ([400, 401].includes(res.status) && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(code)) {
        throw new ReauthRequiredError(`Google refused the Gmail credentials (${code}): connect Gmail again`);
      }
      throw new UpstreamHttpError('Google OAuth', res.status, typeof code === 'string' ? code : null, res.headers.get('retry-after'));
    }
    const body = JSON.parse(text);
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  }

  function accessToken(signal, { renew = false } = {}) {
    if (!renew && token && token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return token.value;
    refreshing ??= refresh(signal).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const post = (raw, bearer, signal) =>
    fetch(new URL('/gmail/v1/users/me/messages/send', apiUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal,
    });

  // A 401 means the access token is expired or invalid: renew it once and send again.
  async function send(raw, signal) {
    let res = await post(raw, await accessToken(signal), signal);
    if (res.status === 401) res = await post(raw, await accessToken(signal, { renew: true }), signal);
    const text = await res.text();
    if (res.status === 401) throw new ReauthRequiredError('Gmail rejected the renewed access token: connect Gmail again');
    if (!res.ok) throw new UpstreamHttpError('Gmail', res.status, reasonOf(text), res.headers.get('retry-after'));
    return { id: jsonOf(text)?.id ?? null };
  }

  return {
    id: 'email-gmail',
    capabilities: ['email.send'],
    async execute(action, { to, subject, text }, ctx) {
      if (action !== 'email.send') throw new UnsupportedActionError(`email-gmail has no action ${action}`);
      // One deadline for the whole send (token refresh, send, renewal): it stays under the breaker's timeout.
      return send(buildRaw({ from: `"${senderName}" <${address}>`, to, subject, text }), AbortSignal.timeout(ctx.timeoutMs));
    },
    classifyError(err) {
      if (err instanceof ReauthRequiredError || err instanceof InvalidEmailError) return PERMANENT;
      if (err instanceof UpstreamHttpError && err.status === 403 && RATE_LIMIT_REASONS.has(err.code)) {
        const retryAfterMs = parseRetryAfter(err.retryAfter);
        return retryAfterMs === null ? RETRYABLE : { kind: 'rateLimited', retryAfterMs };
      }
      return classifyHttpError(err);
    },
    // The send scope cannot read the mailbox, so health = can a fresh access token be obtained.
    async healthCheck() {
      try {
        await accessToken(AbortSignal.timeout(healthTimeoutMs), { renew: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// The MIME message Gmail expects in `raw`: RFC 2822/5322 text, base64url encoded (Gmail sending guide).
function buildRaw({ from, to, subject, text }) {
  if (typeof to !== 'string' || !ADDRESS.test(to)) throw new InvalidEmailError('email has no usable recipient');
  if (/[\r\n]/.test(subject)) throw new InvalidEmailError('subject contains a line break');
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(message).toString('base64url');
}

// RFC 2047 §2: an encoded-word is at most 75 characters and a header line with one at most 76. 36 bytes make 48
// base64 characters, so "Subject: " plus one word fits; longer subjects become several words on folded lines.
function encodeSubject(subject) {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const chunks = [''];
  for (const char of subject) {
    if (Buffer.byteLength(chunks.at(-1) + char) > 36) chunks.push('');
    chunks[chunks.length - 1] += char;
  }
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
}

const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Google API errors carry the reason in error.errors[0].reason (Gmail handle-errors guide).
const reasonOf = (text) => jsonOf(text)?.error?.errors?.[0]?.reason ?? null;
