// erp-sim connector (design §3, §5.3): the ERP simulator, called through ERPNext's REST shape.
// Each document step is check-by-order_ref, create if missing, submit if still a draft, so a retry after a timeout
// finds the document instead of creating a second one.
import { PERMANENT, UnsupportedActionError, UpstreamHttpError, classifyHttpError } from './http-errors.js';

const CUSTOMER = 'Demo Customer';
// ERPNext amounts are in major units; our orders hold minor units (all games are priced in INR: 100 paise to the rupee).
const major = (amountMinor) => amountMinor / 100;

// A document the step builds on is not in the ERP: our system and the ERP disagree.
export class MissingDocumentError extends Error {}

// baseUrl: the simulator's origin. apiKey and apiSecret go in the Authorization header, never in errors or logs.
export function createErpConnector({ baseUrl, apiKey, apiSecret, healthTimeoutMs = 10_000 }) {
  async function call(path, { method = 'GET', body, headers, timeoutMs }) {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        Authorization: `token ${apiKey}:${apiSecret}`,
        ...(body && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamHttpError('ERP', res.status, excType(text), res.headers.get('retry-after'));
    return JSON.parse(text);
  }

  // The calls of one step: X-Sim-Run makes the simulator use the demo run's quantity and fault settings (design §5.5).
  function erp(ctx) {
    const send = (path, options = {}) =>
      call(path, { ...options, headers: ctx.runId ? { 'X-Sim-Run': ctx.runId } : {}, timeoutMs: ctx.timeoutMs });
    const resource = (doctype) => `/api/resource/${encodeURIComponent(doctype)}`;

    async function find(doctype, orderRef) {
      const query = new URLSearchParams({
        filters: JSON.stringify([['order_ref', '=', orderRef]]),
        fields: JSON.stringify(['name', 'docstatus']),
      });
      return (await send(`${resource(doctype)}?${query}`)).data[0] ?? null;
    }

    async function mustFind(doctype, orderRef) {
      const doc = await find(doctype, orderRef);
      if (!doc) throw new MissingDocumentError(`${doctype} for order ${orderRef} is not in the ERP`);
      return doc;
    }

    async function ensure(doctype, orderRef, build) {
      return (await find(doctype, orderRef)) ?? (await send(resource(doctype), { method: 'POST', body: await build() })).data;
    }

    async function ensureSubmitted(doctype, orderRef, build) {
      const doc = await ensure(doctype, orderRef, build);
      if (doc.docstatus === 0) {
        await send('/api/method/frappe.client.submit', { method: 'POST', body: { doc: { doctype, name: doc.name } } });
      }
      return { name: doc.name, docstatus: 1 };
    }

    return { mustFind, ensure, ensureSubmitted };
  }

  const items = ({ itemCode, amountMinor }) => [{ item_code: itemCode, qty: 1, rate: major(amountMinor) }];

  const actions = {
    'sales_order.submit': ({ orderId, itemCode, amountMinor, currency }, ctx) =>
      erp(ctx).ensureSubmitted('Sales Order', orderId, () => ({
        customer: CUSTOMER, items: items({ itemCode, amountMinor }), currency, order_ref: orderId,
      })),

    // A Stock Reservation Entry is in effect as soon as it exists: there is nothing to submit.
    'stock.reserve': async ({ orderId, itemCode }, ctx) => {
      const api = erp(ctx);
      const { name, docstatus } = await api.ensure('Stock Reservation Entry', orderId, async () => ({
        voucher_type: 'Sales Order',
        voucher_no: (await api.mustFind('Sales Order', orderId)).name,
        item_code: itemCode,
        reserved_qty: 1,
        order_ref: orderId,
      }));
      return { name, docstatus };
    },

    'sales_invoice.submit': ({ orderId, itemCode, amountMinor, currency }, ctx) => {
      const api = erp(ctx);
      return api.ensureSubmitted('Sales Invoice', orderId, async () => ({
        customer: CUSTOMER,
        items: items({ itemCode, amountMinor }),
        currency,
        sales_order: (await api.mustFind('Sales Order', orderId)).name,
        order_ref: orderId,
      }));
    },

    'payment_entry.submit': ({ orderId, amountMinor }, ctx) => {
      const api = erp(ctx);
      return api.ensureSubmitted('Payment Entry', orderId, async () => ({
        party: CUSTOMER,
        paid_amount: major(amountMinor),
        references: [{ reference_doctype: 'Sales Invoice', reference_name: (await api.mustFind('Sales Invoice', orderId)).name }],
        order_ref: orderId,
      }));
    },

    // Simulator-only calls (not ERPNext-shaped, design §5.3): a quantity addition keyed by receipt id, a run's data.
    'stock.add': async ({ receiptId, itemCode, qty, runId }, ctx) =>
      call('/sim/stock-receipts', { method: 'POST', body: { receiptId, itemCode, qty, runId }, timeoutMs: ctx.timeoutMs }),
    'run.delete': ({ runId }, ctx) =>
      call(`/sim/runs/${encodeURIComponent(runId)}`, { method: 'DELETE', timeoutMs: ctx.timeoutMs }),
  };

  return {
    id: 'erp-sim',
    capabilities: Object.keys(actions),
    async execute(action, payload, ctx) {
      if (!Object.hasOwn(actions, action)) throw new UnsupportedActionError(`erp-sim has no action ${action}`);
      return actions[action](payload, ctx);
    },
    classifyError: (err) => (err instanceof MissingDocumentError ? PERMANENT : classifyHttpError(err)),
    async healthCheck() {
      try {
        await call('/health', { timeoutMs: healthTimeoutMs });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// The simulator's error body carries exc_type (Frappe REST docs).
function excType(text) {
  try {
    const type = JSON.parse(text)?.exc_type;
    return typeof type === 'string' ? type : null;
  } catch {
    return null;
  }
}
