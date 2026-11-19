-- Every webhook received, once (design-v1 §4, §5.2).
CREATE TABLE payment_events (
  event_id    text        PRIMARY KEY,           -- provider's event id; duplicates rejected by ON CONFLICT DO NOTHING (§5.2 step 3)
  order_id    uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  type        text        NOT NULL,
  payload     jsonb       NOT NULL,              -- the verified event body (signature checked on the raw bytes first, §5.2)
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_type_valid CHECK (type IN ('payment.succeeded', 'payment.refunded')),
  CONSTRAINT payment_events_event_id_format CHECK (event_id ~ '^[^0-9:][^:]*$')  -- reused as a BullMQ job id: non-digit start, no colon (§5.2, §6)
);

-- Refund needs the order's payment.succeeded event (§5.2); Duplicate button resends it (§5.5); cascade delete from orders.
CREATE INDEX payment_events_order_id ON payment_events (order_id);
