// JSON error replies: { error: { code, message } }; some codes add fields.
import { BusinessError } from '../business/errors.js';

// The request's path without its query string: the stream's session id is in the query and must stay out of logs.
const pathOf = (req) => req.originalUrl.split('?')[0];

export function sendError(res, status, code, message, fields = {}) {
  res.status(status).json({ error: { code, message, ...fields } });
}

// HTTP status for each business error code.
const STATUS_BY_CODE = {
  invalid_input: 400,
  invalid_email: 400,
  session_required: 401,
  not_found: 404,
  unknown_game: 404,
  already_reserved: 409,
  invalid_state: 409,
  run_ended: 409,
  run_active: 409,
  payment_unavailable: 502,
  unavailable: 503,
  runs_busy: 503,
  rush_disabled: 503,
};

// Wraps an async route: a BusinessError becomes its reply; any other error goes on to the error handler (500).
export const handle = (route) => async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    if (!(err instanceof BusinessError)) throw err;
    sendError(res, STATUS_BY_CODE[err.code], err.code, err.message, err.fields);
  }
};

// For /api routes: a 4xx raised before the route (bad JSON, too large, a malformed %-escape in the path)
// is the caller's mistake: invalid_input with that status. Anything else goes on.
// hideReason: the parser's message quotes part of the body, so a route whose body holds a secret (the admin login)
// neither logs nor returns it.
export function createInvalidInputHandler({ logger, hideReason = false }) {
  return function invalidInput(err, req, res, next) {
    if (res.headersSent || !(err.status >= 400 && err.status < 500)) return next(err);
    const reason = hideReason ? 'request body rejected' : err.message;
    logger.warn({ method: req.method, url: pathOf(req), status: err.status, reason }, 'request rejected');
    sendError(res, err.status, 'invalid_input', reason);
  };
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

    const request = { method: req.method, url: pathOf(req) };
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
