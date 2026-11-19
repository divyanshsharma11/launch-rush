// ERP simulator: ERPNext/Frappe-shaped REST API for our erp-sim connector.
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isDoctype } from './db.js';
import { documentProblem, isObject, isText } from './validate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INT = 2_147_483_647;
const DEFAULT_PAGE_LENGTH = 20; // Frappe: a list returns 20 records unless limit_page_length says otherwise
const FILTER_FIELDS = ['name', 'docstatus', 'order_ref'];

const scopeOf = (runId) => (runId ? `run:${runId.toLowerCase()}` : 'shop');
const noDoctype = (res, doctype) => sendError(res, 404, 'DoesNotExistError', `DocType ${doctype} not found`);

export function createErpSimApp({ db, faults, config, logger }) {
  const app = express();
  app.use(requireToken(config, logger));

  const invalid = (req, res, reason, excType = 'ValidationError') => {
    logger.warn({ method: req.method, url: req.originalUrl, reason }, 'erp request rejected');
    sendError(res, 400, excType, reason);
  };

  app.get('/health', async (req, res) => {
    try {
      await db.ping();
    } catch (err) {
      logger.error({ err }, 'health check failed: database unreachable');
      return sendError(res, 503, 'ServiceUnavailable', 'database unreachable');
    }
    if (await faults.isDown()) return sendError(res, 503, 'ServiceUnavailable', 'ERP is down');
    res.json({ status: 'ok' });
  });

  // ERPNext-shaped routes. X-Sim-Run picks the demo run whose quantity and fault settings apply.
  const api = express.Router();
  api.use(async (req, res, next) => {
    const runId = req.headers['x-sim-run'];
    if (runId !== undefined && !UUID.test(runId)) return invalid(req, res, 'X-Sim-Run must be a uuid');
    req.scope = scopeOf(runId);
    const refusal = await faults.check(req.scope);
    if (!refusal) return next();
    logger.debug({ method: req.method, url: req.originalUrl, status: refusal.status }, 'call refused by a fault setting');
    if (refusal.retryAfter) res.set('Retry-After', String(refusal.retryAfter));
    sendError(res, refusal.status, refusal.excType, refusal.message);
  });
  api.use(express.json());

  api.get('/resource/:doctype', async (req, res) => {
    const { doctype } = req.params;
    if (!isDoctype(doctype)) return noDoctype(res, doctype);
    const query = parseListQuery(req.query);
    if (query.problem) return invalid(req, res, query.problem);
    const documents = await db.findDocuments({ doctype, filters: query.filters, limit: query.limit, offset: query.offset });
    res.json({ data: documents.map((doc) => pick(doc, query.fields)) });
  });

  api.get('/resource/:doctype/:name', async (req, res) => {
    const { doctype, name } = req.params;
    if (!isDoctype(doctype)) return noDoctype(res, doctype);
    const document = isText(name) ? await db.getDocument(doctype, name) : null;
    if (!document) return sendError(res, 404, 'DoesNotExistError', `${doctype} ${name} not found`);
    res.json({ data: document });
  });

  api.post('/resource/:doctype', async (req, res) => {
    const { doctype } = req.params;
    if (!isDoctype(doctype)) return noDoctype(res, doctype);
    const problem = documentProblem(doctype, req.body);
    if (problem) return invalid(req, res, problem);

    const { name, docstatus, doctype: ignored, ...body } = req.body; // the server sets these three
    const result = await db.createDocument({ doctype, scope: req.scope, body });
    if (result.outcome === 'invalid') return invalid(req, res, result.message, result.excType);
    if (result.outcome === 'insufficient_stock') {
      logger.warn({ doctype, orderRef: body.order_ref, scope: req.scope }, 'reservation refused: insufficient stock');
      return sendError(res, 409, 'InsufficientStock', result.message);
    }
    logger.debug({ doctype, name: result.document.name, orderRef: body.order_ref, scope: req.scope }, 'document created');
    res.json({ data: result.document });
  });

  // Frappe's whitelisted method takes POST or PUT.
  async function submit(req, res) {
    const doc = req.body?.doc;
    if (!isObject(doc) || !isText(doc.doctype) || !isText(doc.name)) {
      return invalid(req, res, 'doc must have a doctype and a name');
    }
    if (!isDoctype(doc.doctype)) return noDoctype(res, doc.doctype);
    const result = await db.submitDocument(doc.doctype, doc.name);
    if (result.outcome === 'not_found') return sendError(res, 404, 'DoesNotExistError', `${doc.doctype} ${doc.name} not found`);
    if (result.outcome === 'not_draft') {
      const message = `${doc.name} has docstatus ${result.docstatus}, only a draft can be submitted`;
      return sendError(res, 409, 'DocstatusTransitionError', message);
    }
    logger.debug({ doctype: doc.doctype, name: doc.name }, 'document submitted');
    res.json({ message: result.document });
  }
  api.route('/method/frappe.client.submit').post(submit).put(submit);
  app.use('/api', api);

  // Simulator-only routes (not ERPNext-shaped): no fault settings apply.
  const internal = express.Router();
  internal.use(express.json());

  // Adds to an item's quantity; a receipt id that was already applied adds nothing.
  internal.post('/stock-receipts', async (req, res) => {
    const { receiptId, itemCode, qty, runId } = req.body ?? {};
    const problem = receiptProblem({ receiptId, itemCode, qty, runId });
    if (problem) return invalid(req, res, problem);

    const scope = scopeOf(runId);
    const { outcome } = await db.addStock({ receiptId, scope, itemCode, qty });
    if (outcome === 'item_not_found') return sendError(res, 404, 'DoesNotExistError', `Item ${itemCode} not found`);
    logger.info({ receiptId, itemCode, qty, scope, applied: outcome === 'applied' }, 'stock receipt');
    res.json({ applied: outcome === 'applied' });
  });

  internal.delete('/runs/:runId', async (req, res) => {
    if (!UUID.test(req.params.runId)) return invalid(req, res, 'runId must be a uuid');
    const deleted = await db.deleteRun(req.params.runId.toLowerCase());
    logger.info({ runId: req.params.runId, ...deleted }, 'run data deleted');
    res.json(deleted);
  });
  app.use('/sim', internal);

  app.use((req, res) => sendError(res, 404, 'DoesNotExistError', 'route not found'));

  // Express needs all 4 parameters to treat this as the error handler.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const request = { method: req.method, url: req.originalUrl };
    if (err.status >= 400 && err.status < 500) {
      logger.warn({ ...request, status: err.status, reason: err.message }, 'erp request rejected');
      return sendError(res, err.status, 'ValidationError', err.message);
    }
    logger.error({ ...request, err }, 'unhandled erp request error');
    sendError(res, 500, 'InternalServerError', 'internal error');
  });
  return app;
}

function receiptProblem({ receiptId, itemCode, qty, runId }) {
  if (!isText(receiptId)) return 'receiptId is required';
  if (!isText(itemCode)) return 'itemCode is required';
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_INT) return 'qty must be a whole number of at least 1';
  if (runId !== undefined && !(typeof runId === 'string' && UUID.test(runId))) return 'runId must be a uuid';
  return null;
}

// filters=[["order_ref","=","<id>"]], fields=["name","docstatus"], limit_page_length, limit_start (Frappe REST docs).
function parseListQuery(query) {
  const parsedFilters = parseJson(query.filters, []);
  if (!Array.isArray(parsedFilters)) return { problem: 'filters must be a JSON list' };
  const filters = [];
  for (const filter of parsedFilters) {
    const [field, operator, value] = Array.isArray(filter) ? filter : [];
    if (!FILTER_FIELDS.includes(field) || operator !== '=' || !['string', 'number'].includes(typeof value) || String(value).includes('\0')) {
      return { problem: `a filter must be [field, "=", value] with field one of ${FILTER_FIELDS.join(', ')}` };
    }
    if (field === 'docstatus' && ![0, 1, 2].includes(Number(value))) return { problem: 'docstatus must be 0, 1 or 2' };
    filters.push([field, value]);
  }

  const fields = parseJson(query.fields, ['name']);
  if (!Array.isArray(fields) || !fields.every((field) => typeof field === 'string')) {
    return { problem: 'fields must be a JSON list of names' };
  }
  const limit = query.limit_page_length === undefined ? DEFAULT_PAGE_LENGTH : Number(query.limit_page_length);
  const offset = query.limit_start === undefined ? 0 : Number(query.limit_start);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { problem: 'limit_page_length must be a whole number from 1 to 1000' };
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_INT) return { problem: 'limit_start must be a whole number of 0 or more' };
  return { filters, fields, limit, offset };
}

function parseJson(text, fallback) {
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const pick = (doc, fields) => Object.fromEntries(fields.filter((field) => field in doc).map((field) => [field, doc[field]]));

// Frappe errors carry exc_type and exc (REST docs); the statuses are our own choice.
function sendError(res, status, excType, message) {
  res.status(status).json({ exc_type: excType, exc: message });
}

// Authorization: token <api_key>:<api_secret> (Frappe REST docs), compared in constant time
// (hashed first: timingSafeEqual needs equal lengths). Both halves are always compared.
function requireToken({ apiKey, apiSecret }, logger) {
  const expectedKey = sha256(apiKey);
  const expectedSecret = sha256(apiSecret);
  return (req, res, next) => {
    const match = /^token +([^\s:]+):(\S+)$/i.exec(req.headers.authorization ?? '');
    if (match) {
      const keyOk = timingSafeEqual(sha256(match[1]), expectedKey);
      const secretOk = timingSafeEqual(sha256(match[2]), expectedSecret);
      if (keyOk && secretOk) return next();
    }
    logger.warn({ method: req.method, url: req.originalUrl }, 'erp request unauthorized');
    res.set('WWW-Authenticate', 'token');
    sendError(res, 401, 'AuthenticationError', 'missing or invalid API key and secret');
  };
}

const sha256 = (value) => createHash('sha256').update(value).digest();
