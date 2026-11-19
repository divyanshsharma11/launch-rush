-- One outside action for one order, with retry status (design-v1 §4, §7).
CREATE TABLE deliveries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),   -- used by POST /admin/deliveries/:id/replay (§5.4)
  order_id      uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  connector     text        NOT NULL,             -- connector id, e.g. 'erp-sim', 'email-gmail' (§3)
  action        text        NOT NULL,             -- e.g. 'sales_order.submit', 'email.send' (§3)
  status        text        NOT NULL DEFAULT 'pending',
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,                             -- error class/message only, never secrets (plan §7)
  next_retry_at timestamptz,
  CONSTRAINT deliveries_status_valid      CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT deliveries_attempts_not_negative CHECK (attempts >= 0),
  CONSTRAINT deliveries_one_per_order_action  UNIQUE (order_id, action)   -- §4, §6: one row per action however often retried
);

-- Admin list of failed deliveries (§5.4).
CREATE INDEX deliveries_failed ON deliveries (id) WHERE status = 'failed';
