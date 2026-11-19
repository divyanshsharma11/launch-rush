-- One webhook event the provider sends (design §5.2). body is the exact JSON text sent on every attempt and resend,
-- so it is text: jsonb reorders object keys (measured on PostgreSQL 18).
CREATE TABLE paysim.events (
  id          text        PRIMARY KEY,                    -- 'evt_' + 16 random bytes as hex; our ingress dedupes by it (§5.2)
  type        text        NOT NULL,
  payment_id  text        NOT NULL REFERENCES paysim.payments (id),
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_id_format            CHECK (id ~ '^evt_[0-9a-f]{32}$'),   -- also meets our ingress rule: non-digit start, no colon
  CONSTRAINT events_type_valid           CHECK (type IN ('payment.succeeded', 'payment.refunded')),
  CONSTRAINT events_body_is_json_object  CHECK (body IS JSON OBJECT),
  CONSTRAINT events_one_per_payment_type UNIQUE (payment_id, type)  -- a resend reuses the same event id (§5.5); also the lookup by payment
);

-- One send of an event: the first send, a Duplicate resend or a run duplicate (§5.5) each add a row for the same event.
-- Retried with truncated exponential backoff until delivered or out of attempts (plan §10 Step 3 decision 2026-11-13).
CREATE TABLE paysim.deliveries (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        text        NOT NULL REFERENCES paysim.events (id),
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),     -- first attempt right away
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_status_valid        CHECK (status IN ('pending', 'delivered', 'failed')),
  CONSTRAINT deliveries_attempts_not_negative CHECK (attempts >= 0)  -- no upper bound here: the retry count is a config value
);

-- The retry loop's query: pending deliveries that are due, oldest first.
CREATE INDEX deliveries_due ON paysim.deliveries (next_attempt_at) WHERE status = 'pending';
