-- One refund (design §5.2 `refund(paymentId)`). A repeated idempotency key returns this row instead of refunding again (§6).
-- Always the full payment: no amount column, the amount is read from the payment, so the two cannot disagree.
CREATE TABLE paysim.refunds (
  id              text        PRIMARY KEY,                -- 're_' + 16 random bytes as hex, made by the provider
  idempotency_key text        NOT NULL,                   -- our connector sends 'refund-<orderId>' (§6)
  payment_id      text        NOT NULL REFERENCES paysim.payments (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_idempotency_key_unique  UNIQUE (idempotency_key),
  CONSTRAINT refunds_idempotency_key_length  CHECK (length(idempotency_key) BETWEEN 1 AND 255),  -- Stripe: up to 255 characters
  CONSTRAINT refunds_id_format               CHECK (id ~ '^re_[0-9a-f]{32}$'),
  CONSTRAINT refunds_one_per_payment         UNIQUE (payment_id)                    -- one full refund per payment; also indexes the FK
);
