-- One purchase; design-v1 §4. State changes follow §2 (conditional UPDATE + order_transitions row).
CREATE TABLE orders (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid        REFERENCES sessions (id),                    -- null for simulated buyers (§4)
  game_id        text        NOT NULL REFERENCES games (id),
  amount_minor   integer     NOT NULL CHECK (amount_minor >= 0),
  currency       text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state          text        NOT NULL CHECK (state IN (
                   'reserved', 'payment_pending', 'paid', 'so_submitted', 'invoiced', 'completed',
                   'waitlisted', 'waitlist_ended', 'reservation_expired', 'refund_pending', 'refunded', 'failed')),
  buyer_email    text,                                                     -- null unless given; purged after 24 h (§1)
  email_saved_at timestamptz,
  email_channel  text        CHECK (email_channel IN ('gmail', 'mock')),   -- decided once by the email job (§5.1)
  waitlist_until timestamptz,
  is_simulated   boolean     NOT NULL DEFAULT false,
  run_id         uuid        REFERENCES demo_runs (id) ON DELETE CASCADE,  -- null for shop orders
  buyer_ref      text,                                                     -- buyer id inside a run; null for shop orders
  reserved_until timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (session_id IS NOT NULL OR is_simulated),        -- real orders always belong to a session
  CHECK (NOT is_simulated OR run_id IS NOT NULL),        -- simulated buyers exist only in runs (§5.5)
  CHECK ((run_id IS NULL) = (buyer_ref IS NULL))         -- buyer_ref is set exactly for run orders (§4)
);

-- One active reservation or wait per session per game in the shop (§4, §5.1: 409 already_reserved).
CREATE UNIQUE INDEX orders_one_active_per_session_game ON orders (session_id, game_id)
  WHERE run_id IS NULL AND state IN ('waitlisted', 'reserved', 'payment_pending');
