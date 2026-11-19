// CORS for the portfolio's origin only (design §5). No cookies are used, so the origin is fixed, never echoed back.
// A preflight is an OPTIONS request with Access-Control-Request-Method (MDN CORS guide).
export function createCors({ allowedOrigin, maxAgeSeconds }) {
  return function cors(req, res, next) {
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.vary('Origin');
    // Retry-After is not a CORS-safelisted response header, so the page can only read it if it is exposed.
    res.set('Access-Control-Expose-Headers', 'Retry-After');
    if (req.method !== 'OPTIONS' || !req.get('access-control-request-method')) return next();

    res.set({
      'Access-Control-Allow-Methods': 'GET, POST, PUT',
      'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id',
      'Access-Control-Max-Age': String(maxAgeSeconds),
    });
    res.status(204).end();
  };
}
