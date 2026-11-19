// Shape checks for the documents the simulator accepts (types and required fields only; links are checked in db.js).
const MAX_INT = 2_147_483_647; // quantities are PostgreSQL integers

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '' && value.length <= 255 && !value.includes('\0');
const isQty = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_INT;
function hasNul(value) {
  if (typeof value === 'string') return value.includes('\0');
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, inner]) => key.includes('\0') || hasNul(inner));
}
const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function itemsProblem(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) return 'items must be a list of 1 to 20 rows';
  for (const item of items) {
    if (!isObject(item) || !isText(item.item_code)) return 'every item needs an item_code';
    if (!isQty(item.qty)) return 'every item needs a whole qty of at least 1';
    if (!isAmount(item.rate)) return 'every item needs a rate of 0 or more';
  }
  return null;
}

function referencesProblem(references) {
  if (!Array.isArray(references) || references.length === 0 || references.length > 20) {
    return 'references must be a list of 1 to 20 rows';
  }
  for (const ref of references) {
    if (!isObject(ref) || !isText(ref.reference_doctype) || !isText(ref.reference_name)) {
      return 'every reference needs reference_doctype and reference_name';
    }
  }
  return null;
}

const CHECKS = {
  'Sales Order': (body) => (!isText(body.customer) ? 'customer is required' : itemsProblem(body.items)),
  'Sales Invoice': (body) => {
    if (!isText(body.customer)) return 'customer is required';
    if (!isText(body.sales_order)) return 'sales_order is required';
    return itemsProblem(body.items);
  },
  'Stock Reservation Entry': (body) => {
    if (body.voucher_type !== 'Sales Order') return 'voucher_type must be Sales Order';
    if (!isText(body.voucher_no)) return 'voucher_no is required';
    if (!isText(body.item_code)) return 'item_code is required';
    return isQty(body.reserved_qty) ? null : 'reserved_qty must be a whole number of at least 1';
  },
  'Payment Entry': (body) => {
    if (!isText(body.party)) return 'party is required';
    return isAmount(body.paid_amount) ? referencesProblem(body.references) : 'paid_amount must be a number of 0 or more';
  },
};

// null when the body is acceptable, else the reason.
export function documentProblem(doctype, body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (hasNul(body)) return 'text must not contain a NUL character'; // PostgreSQL text and jsonb cannot store it
  if (!isText(body.order_ref)) return 'order_ref is required';
  return CHECKS[doctype](body);
}

export { isObject, isText };
