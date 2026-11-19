-- One row per repeat that was refused: a webhook event id already stored, or a second Buy for an active order.
-- Counted by the scoreboard and the run summary ("duplicates blocked").
CREATE TABLE duplicates_blocked (
  id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  kind     text        NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT duplicates_blocked_kind_valid CHECK (kind IN ('webhook', 'buy'))
);

CREATE INDEX duplicates_blocked_order_id ON duplicates_blocked (order_id);
