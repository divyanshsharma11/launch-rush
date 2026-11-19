-- What the ERP simulator stores per document, and the quantity additions it has already applied.
CREATE SEQUENCE erpsim.sales_order_seq;
CREATE SEQUENCE erpsim.stock_reservation_entry_seq;
CREATE SEQUENCE erpsim.sales_invoice_seq;
CREATE SEQUENCE erpsim.payment_entry_seq;

-- order_ref (our order id) is not unique: ERPNext documents no idempotency, so the connector's
-- check-then-create has to prevent duplicates (§5.3), and the simulator must not hide a connector bug.
CREATE TABLE erpsim.documents (
  doctype    text        NOT NULL,
  name       text        NOT NULL,                  -- e.g. 'SINV-0001' (the invoice number)
  docstatus  smallint    NOT NULL,                  -- 0 draft, 1 submitted, 2 cancelled (Frappe, §5.3)
  order_ref  text        NOT NULL,
  scope      text        NOT NULL,                  -- 'shop' or 'run:<uuid>', for the run cleanup
  body       jsonb       NOT NULL,                  -- the fields the connector sent
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doctype, name),
  CONSTRAINT documents_doctype_valid
    CHECK (doctype IN ('Sales Order', 'Stock Reservation Entry', 'Sales Invoice', 'Payment Entry')),
  CONSTRAINT documents_docstatus_valid CHECK (docstatus IN (0, 1, 2)),
  CONSTRAINT documents_scope_valid
    CHECK (scope = 'shop' OR scope ~ '^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- The connector's check by order_ref (§5.3), and the run cleanup.
CREATE INDEX documents_order_ref ON erpsim.documents (doctype, order_ref);
CREATE INDEX documents_scope ON erpsim.documents (scope);

-- One row per applied quantity addition (shop restock, admin refill, run start). A repeated receipt_id adds nothing (§1.2, §5.3).
CREATE TABLE erpsim.stock_additions (
  receipt_id text        PRIMARY KEY,
  scope      text        NOT NULL,
  item_code  text        NOT NULL REFERENCES erpsim.items (item_code),
  qty        integer     NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_additions_qty_positive CHECK (qty > 0),
  CONSTRAINT stock_additions_scope_valid
    CHECK (scope = 'shop' OR scope ~ '^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE INDEX stock_additions_scope ON erpsim.stock_additions (scope);
