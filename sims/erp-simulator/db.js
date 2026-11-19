// ERP simulator: all erpsim SQL. pg reads the PG* env vars itself.
import pg from 'pg';

const SEQUENCES = {
  'Sales Order': ['SO', 'erpsim.sales_order_seq'],
  'Stock Reservation Entry': ['SRE', 'erpsim.stock_reservation_entry_seq'],
  'Sales Invoice': ['SINV', 'erpsim.sales_invoice_seq'],
  'Payment Entry': ['PE', 'erpsim.payment_entry_seq'],
};
const FILTER_COLUMNS = { name: 'name', docstatus: 'docstatus', order_ref: 'order_ref' };

export const isDoctype = (name) => Object.hasOwn(SEQUENCES, name);

// Like ERPNext's naming series: at least four digits, and more digits after 9999 (SO-9999, then SO-10000).
export const documentName = (prefix, number) => `${prefix}-${String(number).padStart(4, '0')}`;

const invalid = (excType, message) => ({ outcome: 'invalid', excType, message });

// pg's defaults are "no timeout": a frozen DB would make every request wait forever.
export function createErpSimDb({ logger, connectTimeoutMs = 5_000, queryTimeoutMs = 5_000 }) {
  const pool = new pg.Pool({ connectionTimeoutMillis: connectTimeoutMs, query_timeout: queryTimeoutMs });
  pool.on('error', (err) => logger.error({ err }, 'postgres idle client error'));

  // work(client) returns a result; the transaction commits only when keep(result) is true.
  // A failed transaction releases its client with the error, so pg discards a stuck connection.
  async function inTransaction(work, keep) {
    const client = await pool.connect();
    let failed;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query(keep(result) ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (err) {
      failed = err;
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release(failed);
    }
  }

  const exists = async (client, sql, values) => (await client.query(sql, values)).rowCount > 0;

  async function missingItems(client, itemCodes) {
    const { rows } = await client.query('SELECT item_code FROM erpsim.items WHERE item_code = ANY($1)', [itemCodes]);
    const found = new Set(rows.map((row) => row.item_code));
    return itemCodes.filter((code) => !found.has(code));
  }

  const submittedExists = (client, doctype, name) =>
    exists(client, 'SELECT 1 FROM erpsim.documents WHERE doctype = $1 AND name = $2 AND docstatus = 1', [doctype, name]);

  // The links a document points to must exist (Frappe validates links); null when they all do.
  async function linkProblem(client, doctype, body) {
    if (doctype === 'Sales Order' || doctype === 'Sales Invoice' || doctype === 'Payment Entry') {
      const party = doctype === 'Payment Entry' ? body.party : body.customer;
      if (!(await exists(client, 'SELECT 1 FROM erpsim.customers WHERE name = $1', [party]))) {
        return invalid('LinkValidationError', `Could not find Customer: ${party}`);
      }
    }
    const itemCodes = doctype === 'Stock Reservation Entry' ? [body.item_code] : (body.items ?? []).map((item) => item.item_code);
    const missing = itemCodes.length > 0 ? await missingItems(client, itemCodes) : [];
    if (missing.length > 0) return invalid('LinkValidationError', `Could not find Item: ${missing[0]}`);

    if (doctype === 'Stock Reservation Entry' && !(await submittedExists(client, 'Sales Order', body.voucher_no))) {
      return invalid('ValidationError', `Sales Order ${body.voucher_no} is not submitted`);
    }
    if (doctype === 'Sales Invoice' && !(await submittedExists(client, 'Sales Order', body.sales_order))) {
      return invalid('ValidationError', `Sales Order ${body.sales_order} is not submitted`);
    }
    if (doctype === 'Payment Entry') {
      for (const ref of body.references) {
        if (ref.reference_doctype !== 'Sales Invoice' || !(await submittedExists(client, 'Sales Invoice', ref.reference_name))) {
          return invalid('ValidationError', `${ref.reference_doctype} ${ref.reference_name} is not a submitted Sales Invoice`);
        }
      }
    }
    return null;
  }

  return {
    async ping() {
      await pool.query('SELECT 1');
    },

    // filters: [[column, value], ...] over name, docstatus and order_ref, all joined with AND.
    async findDocuments({ doctype, filters, limit, offset }) {
      const values = [doctype];
      const where = ['doctype = $1'];
      for (const [field, value] of filters) {
        values.push(value);
        where.push(`${FILTER_COLUMNS[field]} = $${values.length}`);
      }
      values.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT doctype, name, docstatus, body FROM erpsim.documents WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, name DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return rows.map(toDocument);
    },

    async getDocument(doctype, name) {
      const { rows } = await pool.query(
        'SELECT doctype, name, docstatus, body FROM erpsim.documents WHERE doctype = $1 AND name = $2',
        [doctype, name],
      );
      return rows[0] ? toDocument(rows[0]) : null;
    },

    // scope: 'shop' or 'run:<uuid>'. A Stock Reservation Entry takes its quantity in the same transaction:
    // a conditional UPDATE, safe under concurrency, and a submitted document right away.
    // Outcomes: 'created', 'invalid' (excType, message), 'insufficient_stock'.
    createDocument({ doctype, scope, body }) {
      return inTransaction(async (client) => {
        const problem = await linkProblem(client, doctype, body);
        if (problem) return problem;

        let docstatus = 0;
        if (doctype === 'Stock Reservation Entry') {
          const { rowCount } = await client.query(
            `UPDATE erpsim.item_stock SET available = available - $3
             WHERE scope = $1 AND item_code = $2 AND available >= $3`,
            [scope, body.item_code, body.reserved_qty],
          );
          if (rowCount === 0) return { outcome: 'insufficient_stock', message: `Insufficient stock for item ${body.item_code}` };
          docstatus = 1;
        }
        const [prefix, sequence] = SEQUENCES[doctype];
        const { rows: [{ number }] } = await client.query('SELECT nextval($1::regclass) AS number', [sequence]);
        const { rows } = await client.query(
          `INSERT INTO erpsim.documents (doctype, name, docstatus, order_ref, scope, body)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING doctype, name, docstatus, body`,
          [doctype, documentName(prefix, number), docstatus, body.order_ref, scope, body],
        );
        return { outcome: 'created', document: toDocument(rows[0]) };
      }, (result) => result.outcome === 'created');
    },

    // Outcomes: 'submitted', 'not_found', 'not_draft' (docstatus).
    async submitDocument(doctype, name) {
      const { rows } = await pool.query(
        `UPDATE erpsim.documents SET docstatus = 1 WHERE doctype = $1 AND name = $2 AND docstatus = 0
         RETURNING doctype, name, docstatus, body`,
        [doctype, name],
      );
      if (rows[0]) return { outcome: 'submitted', document: toDocument(rows[0]) };
      const current = await pool.query('SELECT docstatus FROM erpsim.documents WHERE doctype = $1 AND name = $2', [doctype, name]);
      return current.rows[0] ? { outcome: 'not_draft', docstatus: current.rows[0].docstatus } : { outcome: 'not_found' };
    },

    // Adds qty to an item's quantity; a receipt id that was already applied adds nothing.
    // Outcomes: 'applied', 'repeated', 'item_not_found'.
    async addStock({ receiptId, scope, itemCode, qty }) {
      try {
        return await inTransaction(async (client) => {
          const { rowCount } = await client.query(
            `INSERT INTO erpsim.stock_additions (receipt_id, scope, item_code, qty) VALUES ($1, $2, $3, $4)
             ON CONFLICT (receipt_id) DO NOTHING`,
            [receiptId, scope, itemCode, qty],
          );
          if (rowCount === 0) return { outcome: 'repeated' };
          await client.query(
            `INSERT INTO erpsim.item_stock (scope, item_code, available) VALUES ($1, $2, $3)
             ON CONFLICT (scope, item_code) DO UPDATE SET available = erpsim.item_stock.available + EXCLUDED.available`,
            [scope, itemCode, qty],
          );
          return { outcome: 'applied' };
        }, (result) => result.outcome === 'applied');
      } catch (err) {
        if (err.constraint === 'stock_additions_item_code_fkey') return { outcome: 'item_not_found' };
        throw err;
      }
    },

    // Run cleanup: everything one demo run owns.
    async deleteRun(runId) {
      const scope = `run:${runId}`;
      return inTransaction(async (client) => {
        const documents = await client.query('DELETE FROM erpsim.documents WHERE scope = $1', [scope]);
        const quantities = await client.query('DELETE FROM erpsim.item_stock WHERE scope = $1', [scope]);
        await client.query('DELETE FROM erpsim.stock_additions WHERE scope = $1', [scope]);
        return { documents: documents.rowCount, quantities: quantities.rowCount };
      }, () => true);
    },

    close: () => pool.end(),
  };
}

const toDocument = (row) => ({ ...row.body, doctype: row.doctype, name: row.name, docstatus: row.docstatus });
