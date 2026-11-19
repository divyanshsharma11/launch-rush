-- What the ERP simulator created for each order (design-v1 §4, §5.3).
CREATE TABLE erp_documents (
  id        uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id  uuid     NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  doctype   text     NOT NULL,
  name      text     NOT NULL,                      -- the ERP's document name, e.g. 'SINV-0001' (the invoice number)
  docstatus smallint NOT NULL,
  CONSTRAINT erp_documents_doctype_valid   CHECK (doctype IN ('Sales Order', 'Stock Reservation Entry', 'Sales Invoice', 'Payment Entry')),
  CONSTRAINT erp_documents_docstatus_valid CHECK (docstatus IN (0, 1, 2)),          -- draft / submitted / cancelled (Frappe, §5.3)
  CONSTRAINT erp_documents_one_per_order_doctype UNIQUE (order_id, doctype)       -- §4: the last guard against duplicates (§5.3)
);
