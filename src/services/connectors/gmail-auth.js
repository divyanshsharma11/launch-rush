// One-time Google OAuth consent for the owner's Gmail account: the authorization code flow with a loopback redirect
// and PKCE, as Google documents for desktop apps. Returns the refresh token the email-gmail connector uses.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

// onUrl(url): called with the consent URL to open in a browser. Resolves after the redirect came back and the code
// was exchanged. Rejects when Google reports an error, no refresh token comes back, or timeoutMs passes.
export async function authorizeOnLoopback({
  clientId, clientSecret, onUrl, timeoutMs = 300_000,
  authUrl = 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl = 'https://oauth2.googleapis.com/token',
}) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  const redirected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer from Google in time')), timeoutMs);
    server.on('request', (req, res) => {
      const params = new URL(req.url, redirectUri).searchParams;
      // Anything that is not Google's redirect for this run (a favicon request, a wrong state) is ignored.
      if (params.get('state') !== state) {
        res.writeHead(400).end('unexpected request');
        return;
      }
      clearTimeout(timer);
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('You can close this tab and go back to the terminal.');
      if (params.get('error')) reject(new Error(`Google returned an error: ${params.get('error')}`));
      else resolve(params.get('code'));
    });
  });

  redirected.catch(() => {}); // a rejection after an early exit must not go unhandled; the await below still sees it
  try {
    onUrl(`${authUrl}?${new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline',
      prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })}`);
    const code = await redirected;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
        grant_type: 'authorization_code', redirect_uri: redirectUri,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google refused the code (HTTP ${res.status} ${body.error ?? ''})`.trim());
    if (!body.refresh_token) throw new Error('Google sent no refresh token: remove this app in your Google account permissions and run again');
    return body.refresh_token;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
