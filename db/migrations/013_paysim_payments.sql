-- Mock payment provider's own data: a separate schema, like erpsim (design §5.3), so it behaves like an outside
-- system: our app code never reads it, only the provider's HTTP API does.
CREATE SCHEMA paysim;

-- One charge (design §5.2 `charge`). A repeated idempotency key returns this row instead of charging again (§6).
CREATE TABLE paysim.payments (
  id              text        PRIMARY KEY,                -- 'pay_' + 16 random bytes as hex, made by the provider
  idempotency_key text        NOT NULL,                   -- our connector sends 'charge-<orderId>' (§6)
  order_id        uuid        NOT NULL,                   -- our order id; no FK: an outside system does not know our tables
  amount_minor    integer     NOT NULL,
  currency        text        NOT NULL,
  run_id          uuid,                                   -- from the X-Sim-Run header (§5.5); null for shop orders
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_idempotency_key_unique  UNIQUE (idempotency_key),
  CONSTRAINT payments_idempotency_key_length  CHECK (length(idempotency_key) BETWEEN 1 AND 255),  -- Stripe: up to 255 characters
  CONSTRAINT payments_id_format               CHECK (id ~ '^pay_[0-9a-f]{32}$'),
  CONSTRAINT payments_amount_not_negative     CHECK (amount_minor >= 0),              -- same rule as games.price_minor (001)
  CONSTRAINT payments_currency_format         CHECK (currency ~ '^[A-Z]{3}$')
);
