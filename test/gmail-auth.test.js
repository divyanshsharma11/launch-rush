// The one-time Gmail consent (loopback redirect + PKCE) against a fake Google; the "browser" is a fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { authorizeOnLoopback } from '../src/services/connectors/gmail-auth.js';
import { startFakeGoogle } from './helpers.js';

let google;
before(async () => {
  google = await startFakeGoogle();
});
after(() => google.close());

const options = (onUrl, extra = {}) => ({
  clientId: google.clientId, clientSecret: google.clientSecret, tokenUrl: google.tokenUrl, onUrl, timeoutMs: 3000, ...extra,
});

test('consent URL asks for offline gmail.send access with state and PKCE; the code is exchanged for a refresh token', async () => {
  let consent;
  const token = await authorizeOnLoopback(options(async (url) => {
    consent = new URL(url);
    const redirectUri = consent.searchParams.get('redirect_uri');
    google.codes.set('code-1', { challenge: consent.searchParams.get('code_challenge'), redirectUri });
    await fetch(`${redirectUri}/?code=code-1&state=${consent.searchParams.get('state')}`);
  }));
  assert.equal(token, 'refresh-from-code');
  const p = consent.searchParams;
  assert.equal(consent.origin + consent.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(p.get('client_id'), google.clientId);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'https://www.googleapis.com/auth/gmail.send');
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.match(p.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(p.get('state'), /^[0-9a-f]{32}$/);
});

test('a request with the wrong state is ignored; the real redirect still completes', async () => {
  const token = await authorizeOnLoopback(options(async (url) => {
    const consent = new URL(url);
    const redirectUri = consent.searchParams.get('redirect_uri');
    google.codes.set('code-2', { challenge: consent.searchParams.get('code_challenge'), redirectUri });
    assert.equal((await fetch(`${redirectUri}/?code=code-2&state=forged`)).status, 400);
    assert.equal((await fetch(`${redirectUri}/favicon.ico`)).status, 400);
    await fetch(`${redirectUri}/?code=code-2&state=${consent.searchParams.get('state')}`);
  }));
  assert.equal(token, 'refresh-from-code');
});

test('the user denying consent rejects with Google\'s error', async () => {
  await assert.rejects(
    authorizeOnLoopback(options(async (url) => {
      const consent = new URL(url);
      await fetch(`${consent.searchParams.get('redirect_uri')}/?error=access_denied&state=${consent.searchParams.get('state')}`);
    })),
    /access_denied/,
  );
});

test('a code Google refuses (wrong PKCE verifier) rejects with the status, not the secret', async () => {
  await assert.rejects(
    authorizeOnLoopback(options(async (url) => {
      const consent = new URL(url);
      const redirectUri = consent.searchParams.get('redirect_uri');
      google.codes.set('code-3', { challenge: 'not-the-challenge', redirectUri });
      await fetch(`${redirectUri}/?code=code-3&state=${consent.searchParams.get('state')}`);
    })),
    (err) => /HTTP 400 invalid_grant/.test(err.message) && !err.message.includes(google.clientSecret),
  );
});

test('no redirect in time rejects and frees the port', async () => {
  let redirectUri;
  await assert.rejects(
    authorizeOnLoopback(options((url) => {
      redirectUri = new URL(url).searchParams.get('redirect_uri');
    }, { timeoutMs: 100 })),
    /no answer from Google in time/,
  );
  await assert.rejects(fetch(redirectUri), 'the loopback server is closed');
});

test('npm run gmail-connect without a client id says what to set and exits 1', async () => {
  const env = { ...process.env, GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '' };
  const err = await promisify(execFile)(process.execPath, ['src/gmail-connect.js'], { env }).catch((e) => e);
  assert.equal(err.code, 1);
  assert.match(err.stderr, /Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET/);
});
