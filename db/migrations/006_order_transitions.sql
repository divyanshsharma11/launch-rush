-- History of state changes, one row per transition (§2); feeds the event log and SSE (§8.4).
CREATE TABLE order_transitions (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_state order_state,                            -- null on the first row, when the order is created (§2 "(none)")
  to_state   order_state NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_transitions_state_changes CHECK (from_state IS DISTINCT FROM to_state)
);

-- §8.4: one order's rows after its last sent id; §8.5 and §2 replay: an order's latest transition.
CREATE INDEX order_transitions_order_id_id ON order_transitions (order_id, id);
