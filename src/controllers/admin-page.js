// The built admin page (admin/), served as static files from the backend's own origin. A file that does not exist
// falls through to the next handler, so the /admin API routes are still reached.
import express from 'express';

// The page calls only its own origin and loads only its own scripts and styles.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function createAdminPage({ dir }) {
  return express.static(dir, {
    setHeaders(res) {
      res.set('Content-Security-Policy', CSP);
      res.set('X-Content-Type-Options', 'nosniff');
    },
  });
}
