-- Orders that sit in an ERP or refund step, found by age: the recovery job (design §7 "After the final failure").
-- Few rows at any time: a finished order leaves these states.
CREATE INDEX orders_in_pipeline ON orders (updated_at)
  WHERE state IN ('paid', 'so_submitted', 'invoiced', 'refund_pending');
