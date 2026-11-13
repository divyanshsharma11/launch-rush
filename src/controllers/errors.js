// JSON error replies in the design §5 shape: { error: { code, message } }.

export function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

// After all routes: Express's own 404 reply is HTML ("Cannot POST /x"; measured).
export function notFound(req, res) {
  sendError(res, 404, 'not_found', 'route not found');
}

// Registered last. Express's built-in handler would reply with err.stack as HTML.
export function createErrorHandler({ logger }) {
  // Keep all 4 parameters: that is how Express recognises an error handler.
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const request = { method: req.method, url: req.originalUrl };
    if (isBodyParserError(err)) {
      logger.warn({ ...request, status: err.status, reason: err.message }, 'request body rejected');
      return sendError(res, err.status, 'invalid_payload', err.message);
    }
    logger.error({ ...request, err }, 'unhandled request error');
    sendError(res, 500, 'internal_error', 'internal error');
  };
}

// body-parser errors have a `type` (e.g. 'entity.too.large') and a 4xx status.
function isBodyParserError(err) {
  return typeof err.type === 'string' && err.status >= 400 && err.status < 500;
}
