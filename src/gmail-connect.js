// One-time Gmail consent. Run: npm run gmail-connect
// Opens no browser itself: it prints the Google consent URL, then prints GMAIL_REFRESH_TOKEN for your .env.
import { authorizeOnLoopback } from './services/connectors/gmail-auth.js';

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first (see .env.example).');
  process.exitCode = 1;
} else {
  try {
    const refreshToken = await authorizeOnLoopback({
      clientId,
      clientSecret,
      onUrl: (url) => console.log(`Open this URL in a browser, signed in as the demo Gmail account:\n\n${url}\n`),
    });
    console.log(`Connected. Add this line to .env (and GMAIL_ADDRESS), then restart the worker:\n\nGMAIL_REFRESH_TOKEN=${refreshToken}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
